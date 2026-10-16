import { SpeechRequest } from '@foundry/contracts';
import { auditRepo, sessionsRepo, settingsRepo, turnsRepo, usageRepo } from '@foundry/db';
import { type z } from 'zod';

import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { requireId, type Kit } from '../internal/kit.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { SpeechSynthesisError, type SynthesizedSpeech } from '../ports.js';
import { currentCallMinutes, remainingCallMinutes } from './call-usage.js';
import { callUsageToday, callVoice, resolveVeir } from './veir.js';
import { speechCostUsd, speechEngines } from './voices.js';

/**
 * Text-to-speech for calls (`POST /speech`). Calls speak only validated text: the requested text must be the
 * stored validated reply of a completed turn of that conversation (its short spoken form, or a passage of
 * its answer read as plain text). Every synthesis is metered in the usage ledger (purpose `speech`, priced
 * per character) and checked against the daily spend caps, the kill switch, the persona's status and the
 * call-minute caps.
 */
export interface SpeechService {
  synthesize(
    ctx: RequestContext,
    input: z.input<typeof SpeechRequest>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SynthesizedSpeech>;
}

/** Answer Markdown read as plain sentences: no citation keys, emphasis, headings, bullets or link targets. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/\[(E\d+(?:\s*[,;]\s*E\d+)*)\]/g, ' ')
    .replace(/\((E\d+(?:\s*[,;]\s*E\d+)*)\)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether `requested` is validated text of the turn: a passage of its spoken form, or of its answer read as
 * plain text (pure; unit tested).
 */
export function isSpeakable(
  requested: string,
  source: { spoken: string | null; answer: string | null },
): boolean {
  const wanted = comparable(speakableText(requested));
  if (wanted === '') return false;
  const sources = [source.spoken, source.answer].flatMap((s) =>
    s === null ? [] : [comparable(speakableText(s))],
  );
  return sources.some((s) => s.includes(wanted));
}

export function createSpeechService(kit: Kit): SpeechService {
  const { logger } = kit.deps;

  return {
    synthesize: async (ctx, rawInput, options = {}) => {
      const input = parseInput(SpeechRequest, rawInput);
      const sessionId = requireId(input.sessionId, 'Session');
      const turnId = requireId(input.turnId, 'Turn');
      const synthesizer = kit.deps.speech;
      if (synthesizer === undefined) {
        throw new DomainError(
          'speech_unavailable',
          'Spoken replies are not available on this server; the browser reads replies aloud instead.',
          { reason: 'speech_not_configured' },
        );
      }

      const plan = await kit.inRequest(ctx, async (scope) => {
        const session = await sessionsRepo.getSession(scope.tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        if (!settings.aiEnabled) {
          throw new DomainError(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            {
              reason: 'kill_switch',
            },
          );
        }
        await requireAssignmentActive(scope, session.ventureId);
        const source = await turnsRepo.getSpeechSource(scope.tx, turnId);
        if (source?.sessionId !== sessionId) throw fail.notFound('Turn');
        if (source.status !== 'completed') {
          throw fail.conflict('Only a completed reply can be spoken', 'turn_not_completed');
        }
        if (!isSpeakable(input.text, source)) {
          scope.deferAudit({
            action: 'speech.refused',
            outcome: 'denied',
            ventureId: session.ventureId,
            objectType: 'turn',
            objectId: turnId,
            policyReason: 'text_not_validated',
          });
          throw fail.validation('Only the coach’s validated reply can be spoken', [
            { path: 'text', message: 'Not the stored reply of this turn' },
          ]);
        }
        const now = kit.now();
        const usage = await callUsageToday(scope.tx, now);
        if (remainingCallMinutes(usage, settings.dailyCallMinutesPerPrincipal) <= 0) {
          throw new DomainError(
            'rate_limited',
            'You have used today’s call minutes. Calls reset at midnight UTC.',
            {
              reason: 'daily_call_minutes',
              retryAfterSeconds: secondsUntilUtcMidnight(now),
            },
          );
        }
        if (currentCallMinutes(usage, sessionId) >= settings.maxCallMinutes) {
          throw new DomainError(
            'rate_limited',
            `Calls last at most ${String(settings.maxCallMinutes)} minutes. Continue in chat or start a new call later.`,
            { reason: 'call_minutes', retryAfterSeconds: 600 },
          );
        }
        const veir = await resolveVeir(scope.tx, session.ventureId);
        if (veir === null) throw fail.notFound('Coach');
        return { session, settings, voiceId: callVoice(veir.identity.embodiment) };
      });

      await assertWithinSpendCaps(kit, ctx, plan.settings, {
        ventureId: plan.session.ventureId,
        operation: 'speech',
      });

      const text = speakableText(input.text);
      let speech: SynthesizedSpeech;
      try {
        speech = await synthesizer.synthesize({
          text,
          voiceId: plan.voiceId,
          engines: speechEngines(plan.voiceId),
          requestId: ctx.requestId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (err) {
        logger.warn('speech.synthesis_failed', {
          requestId: ctx.requestId,
          turnId,
          error: err instanceof Error ? err.name : 'unknown',
        });
        if (err instanceof SpeechSynthesisError || (err instanceof Error && err.name === 'AbortError')) {
          throw new DomainError(
            'model_unavailable',
            'Speech is temporarily unavailable. Try again shortly.',
            {
              reason: 'speech_failed',
              retryAfterSeconds: 5,
              cause: err,
            },
          );
        }
        throw err;
      }

      // Metered once synthesis started (the service bills the characters whether or not playback finishes).
      try {
        await kit.system(
          async (sx) => {
            await usageRepo.recordUsage(sx, {
              tenantId: ctx.tenantId,
              ventureId: plan.session.ventureId,
              principalId: ctx.principalId,
              purpose: 'speech',
              modelId: `polly:${speech.engine}:${speech.voiceId}`,
              inputTokens: speech.characters,
              outputTokens: 0,
              costUsd: speechCostUsd(speech.characters, speech.engine),
              requestId: ctx.requestId,
            });
            await auditRepo.appendAudit(sx, {
              action: 'speech.synthesized',
              outcome: 'succeeded',
              tenantId: ctx.tenantId,
              ventureId: plan.session.ventureId,
              actorId: ctx.principalId,
              requestId: ctx.requestId,
              objectType: 'turn',
              objectId: turnId,
              metadata: { characters: speech.characters, engine: speech.engine, voiceId: speech.voiceId },
            });
          },
          { transaction: false },
        );
      } catch (err) {
        logger.error('speech.usage_record_failed', {
          requestId: ctx.requestId,
          turnId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
      return speech;
    },
  };
}
