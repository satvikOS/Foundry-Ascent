import { SpeechRequest } from '@foundry/contracts';
import {
  auditRepo,
  callsRepo,
  personasRepo,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  usageRepo,
} from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import { verifySpeechUnit } from '../orchestrator/speech-units.js';
import { SpeechSynthesisError, type SynthesizedSpeech } from '../ports.js';
import { refusalError, timeLimitRefusal } from './call-admission.js';
import { CALL_LIMITS, callSecondsToday, callTimeLeft } from './call-usage.js';
import { voiceApproved } from './calls.js';
import { speechCostUsd, speechEngines } from './voices.js';

/**
 * Text-to-speech for calls (`POST /speech`). Calls speak only validated text:
 *  - a signed unit: a `turn.speech` unit of a turn (or the call intro, which has no turn) whose signature over
 *    `sessionId|turnId|seq|text` verifies; units of a turn that was blocked or failed are never spoken;
 *  - or, unsigned, the stored `spoken` form of a completed turn of the conversation: the whole of it, or one
 *    or more consecutive whole sentences of it (never a fragment).
 * Speech belongs to the caller's live call in that conversation and speaks with the call's voice. Every
 * synthesis is metered in the usage ledger (purpose `speech`, priced per character) and checked against the
 * kill switches, the daily spend caps, the call's time limits, the persona's status and its voice consent.
 */
export interface SpeechService {
  synthesize(
    ctx: RequestContext,
    input: z.input<typeof SpeechRequest>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SynthesizedSpeech>;
}

/** Unsigned requests shorter than this must be the whole spoken reply (no one-word splicing). */
export const MIN_UNSIGNED_SPEECH_CHARS = 12;

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

/**
 * Sentences of plain text, in order: a sentence ends at `.`, `!`, `?` or `…` (with any closing quotes or
 * brackets) followed by whitespace, so "19.5%" or "e-mail.com" never split.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'”’)\]]*)\s+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
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
 * Whether `requested` may be spoken for a turn whose validated spoken form is `spoken`: all of it, or one or
 * more consecutive whole sentences of it at least {@link MIN_UNSIGNED_SPEECH_CHARS} long. Arbitrary
 * substrings, reordered or skipped sentences are refused (pure; unit tested).
 */
export function isSpeakableRun(requested: string, spoken: string | null): boolean {
  if (spoken === null) return false;
  const wanted = comparable(speakableText(requested));
  if (wanted === '') return false;
  const plain = speakableText(spoken);
  if (wanted === comparable(plain)) return true;
  if (wanted.length < MIN_UNSIGNED_SPEECH_CHARS) return false;
  const sentences = splitSentences(plain).map(comparable);
  for (let start = 0; start < sentences.length; start += 1) {
    let run = '';
    for (let end = start; end < sentences.length; end += 1) {
      run = end === start ? (sentences[end] ?? '') : `${run} ${sentences[end] ?? ''}`;
      if (run === wanted) return true;
      if (run.length >= wanted.length) break;
    }
  }
  return false;
}

/**
 * What the founder heard of a spoken reply they interrupted after unit `heardSeq` (`turns.heard_seq`), when its
 * units are the reply's sentences in order: the conversation history replays this instead of the whole reply.
 * Empty when they heard nothing.
 */
export function heardPortion(spoken: string, heardSeq: number): string {
  if (heardSeq < 0) return '';
  return splitSentences(speakableText(spoken))
    .slice(0, heardSeq + 1)
    .join(' ');
}

interface SpeechPlan {
  readonly ventureId: string;
  readonly callId: string;
  readonly voiceId: string;
  readonly settings: { dailyUsdCapGlobal: number; dailyUsdCapPerPrincipal: number };
  readonly objectType: 'turn' | 'call';
  readonly objectId: string;
}

export function createSpeechService(kit: Kit, keys: PlatformKeyCache): SpeechService {
  const { logger } = kit.deps;

  function refuseText(scope: RequestScope, ventureId: string, turnId: string | null, reason: string): never {
    scope.deferAudit({
      action: 'speech.refused',
      outcome: 'denied',
      ventureId,
      objectType: turnId === null ? 'session' : 'turn',
      objectId: turnId,
      policyReason: reason,
    });
    throw fail.validation('Only the vEIR’s validated words can be spoken', [
      { path: reason === 'signature_invalid' ? 'sig' : 'text', message: 'Not validated text of this call' },
    ]);
  }

  return {
    synthesize: async (ctx, rawInput, options = {}) => {
      const input = parseInput(SpeechRequest, rawInput);
      const sessionId = requireId(input.sessionId, 'Session');
      const turnId = input.turnId === null ? null : requireId(input.turnId, 'Turn');
      if ((input.seq === undefined) !== (input.sig === undefined)) {
        throw fail.validation('A speech unit carries both its sequence number and its signature', [
          { path: input.seq === undefined ? 'seq' : 'sig', message: 'Required with the other' },
        ]);
      }
      if (turnId === null && input.sig === undefined) {
        throw fail.validation('The call intro is spoken with its signature', [
          { path: 'sig', message: 'Required for the call intro' },
        ]);
      }
      const verificationKeys = input.sig === undefined ? [] : await keys.verificationKeys();

      const plan = await kit.inRequest(ctx, async (scope): Promise<SpeechPlan> => {
        const { tx } = scope;
        const session = await sessionsRepo.getSession(tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        const settings = await settingsRepo.getPlatformSettings(tx);
        if (!settings.aiEnabled) {
          throw new DomainError(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            {
              reason: 'kill_switch',
            },
          );
        }
        if (!settings.callsEnabled) {
          throw new DomainError('ai_disabled', 'Calls are paused by the program. You can keep chatting.', {
            reason: 'calls_disabled',
          });
        }
        const active = await requireAssignmentActive(scope, session.ventureId);
        const call = await callsRepo.getLiveCallOf(tx, ctx.principalId);
        if (call?.sessionId !== sessionId || call.idleSeconds > CALL_LIMITS.staleSeconds) {
          throw fail.conflict('Speech is only available during a live call.', 'call_not_active');
        }
        const persona = await personasRepo.getPersona(tx, call.personaId);
        const assets = persona === null ? [] : await personasRepo.personaConsentAssets(tx, persona.id);
        if (
          persona === null ||
          active.persona.id !== call.personaId ||
          !voiceApproved(call.voiceId, persona, assets)
        ) {
          throw new DomainError('persona_suspended', 'This vEIR cannot speak right now.', {
            reason: 'voice_not_approved',
          });
        }
        const timeUp = timeLimitRefusal(
          callTimeLeft({
            elapsedSeconds: call.elapsedSeconds,
            maxSeconds: call.maxSeconds,
            usedSecondsToday: await callSecondsToday(tx, ctx.principalId),
            caps: settings,
          }),
        );
        if (timeUp !== null) throw refusalError(timeUp, kit.now());

        if (turnId !== null) {
          const source = await turnsRepo.getSpeechSource(tx, turnId);
          if (source?.sessionId !== sessionId) throw fail.notFound('Turn');
          if (input.sig === undefined) {
            if (source.status !== 'completed') {
              throw fail.conflict('Only a completed reply can be spoken', 'turn_not_completed');
            }
            if (!isSpeakableRun(input.text, source.spoken)) {
              refuseText(scope, session.ventureId, turnId, 'text_not_validated');
            }
          } else if (source.status === 'blocked' || source.status === 'failed') {
            // A unit passed the sentence gate, but the whole reply did not: it is never spoken again.
            throw fail.conflict('This reply can no longer be spoken.', 'turn_not_speakable');
          }
        }
        if (
          input.sig !== undefined &&
          !verifySpeechUnit(
            verificationKeys,
            { sessionId, turnId, seq: input.seq ?? 0, text: input.text },
            input.sig,
          )
        ) {
          refuseText(scope, session.ventureId, turnId, 'signature_invalid');
        }
        return {
          ventureId: session.ventureId,
          callId: call.id,
          voiceId: call.voiceId,
          settings,
          objectType: turnId === null ? 'call' : 'turn',
          objectId: turnId ?? call.id,
        };
      });

      // Checked after authorization and validation: callers learn nothing about a conversation they cannot
      // open, and a valid request tells the client to speak the text itself.
      const synthesizer = kit.deps.speech;
      if (synthesizer === undefined) {
        throw new DomainError(
          'speech_unavailable',
          'Spoken replies are not available on this server; the browser reads replies aloud instead.',
          { reason: 'speech_not_configured' },
        );
      }

      await assertWithinSpendCaps(kit, ctx, plan.settings, {
        ventureId: plan.ventureId,
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
          callId: plan.callId,
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
              ventureId: plan.ventureId,
              principalId: ctx.principalId,
              purpose: 'speech',
              modelId: `polly:${speech.engine}:${speech.voiceId}`,
              inputTokens: speech.characters,
              outputTokens: 0,
              costUsd: speechCostUsd(speech.characters, speech.engine),
              requestId: ctx.requestId,
            });
            await callsRepo.addSpeechCharacters(sx, { callId: plan.callId, characters: speech.characters });
            await auditRepo.appendAudit(sx, {
              action: 'speech.synthesized',
              outcome: 'succeeded',
              tenantId: ctx.tenantId,
              ventureId: plan.ventureId,
              actorId: ctx.principalId,
              requestId: ctx.requestId,
              objectType: plan.objectType,
              objectId: plan.objectId,
              metadata: {
                callId: plan.callId,
                characters: speech.characters,
                engine: speech.engine,
                voiceId: speech.voiceId,
                signed: input.sig !== undefined,
              },
            });
          },
          { transaction: false },
        );
      } catch (err) {
        logger.error('speech.usage_record_failed', {
          requestId: ctx.requestId,
          callId: plan.callId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
      return speech;
    },
  };
}
