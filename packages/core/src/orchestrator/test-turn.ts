import { randomUUID } from 'node:crypto';

import {
  CRISIS_SUPPORT_MESSAGE,
  buildRetrievalQuery,
  classifyRisk,
  riskLabel,
  withSafetyScreen,
  type HistoryTurn,
  type RiskClassification,
} from '@foundry/ai';
import {
  TestTurnRequest,
  type CoachMode,
  type TestTurnResponse,
  type ValidatorResults,
} from '@foundry/contracts';
import { type auditRepo, personasRepo, settingsRepo, turnsRepo } from '@foundry/db';
import { type z } from 'zod';

import { requirePersonaCurator, type CuratorVia } from '../authz/persona-curator.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { answerTurn, generationError } from './answer.js';
import { participantBlockReason, supportMessageFor } from './blocked.js';
import { generationTotals, type GenerationMeter } from './generate.js';
import { embedRetrievalQuery, retrieveEvidence } from './retrieval.js';
import { screenIndirectIdeation } from './safety-screen.js';
import { secondsUntilUtcMidnight } from './sampling.js';

export type RunTestTurnInput = z.input<typeof TestTurnRequest>;

export interface TestBench {
  /**
   * One message of an EIR studio test conversation: a curator (a program lead, or the EIR the persona is built
   * from) talks to a release of the persona (its active release or a draft) before approving it.
   *
   * The message runs the founder pipeline's answer stage (`answerTurn`: the release's doctrine and style, the
   * persona's common pool, the sentence gate, the identity guard and the validators) and the same crisis path,
   * with an empty specific pool: no venture, venture memory, notebook or documents. Nothing is stored: no
   * conversation, turn, memory proposal, notebook line, escalation or review sample. The client keeps the
   * transcript and sends the last few exchanges back. Admission follows founder messages (the per-person
   * message and in-flight limits, the daily spend caps, the AI kill switch); a crisis message is always
   * answered with the fixed support message and makes no model call. Model calls are metered once, under
   * purpose `test_bench`. Audited as `test_bench.used` and `test_bench.answered`, without content.
   */
  runTestTurn(
    ctx: RequestContext,
    personaId: string,
    input: RunTestTurnInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TestTurnResponse>;
}

const MESSAGE_LIMIT_TEXT = 'You are sending messages very quickly. Please wait a few minutes.';
const METER: GenerationMeter = { purpose: 'test_bench', ventureId: null };
const quiet = (): Promise<void> => Promise.resolve();

/**
 * What the curator sees of the checks: everything a founder's view shows, plus the risk categories their own
 * message raised. Which names the cross-venture guard knows is never revealed (no cross-venture flag, category
 * or note): a curator could otherwise test names to learn which ventures and people the program has.
 */
export function curatorValidator(validator: ValidatorResults): ValidatorResults {
  return {
    ...validator,
    riskCategories: validator.riskCategories.filter((c) => c !== 'cross_venture_request'),
    crossVentureViolation: false,
    notes: validator.notes.filter((note) => !note.startsWith('cross_venture')),
  };
}

/** A consent in force that covers doctrine (the rule release approval applies to an EIR persona). */
async function consentInForce(
  scope: RequestScope,
  persona: personasRepo.PersonaRecord,
  now: number,
): Promise<boolean> {
  if (persona.kind !== 'eir_persona') return true;
  const consent = persona.consentId ? await personasRepo.getConsent(scope.tx, persona.consentId) : null;
  return (
    consent !== null &&
    consent.revokedAt === null &&
    (consent.expiresAt === null || Date.parse(consent.expiresAt) > now) &&
    consent.assetTypes.includes('doctrine')
  );
}

interface Admitted {
  readonly persona: personasRepo.PersonaRecord;
  readonly release: personasRepo.PersonaReleaseRecord;
  readonly settings: Awaited<ReturnType<typeof settingsRepo.getPlatformSettings>>;
  readonly via: CuratorVia;
  readonly personaEirName: string | null;
  /** First-person consent; no venture, so its EIR sees no venture's work here. */
  readonly presence: Pick<personasRepo.PersonaPresence, 'firstPerson' | 'eirSeesWork'>;
  /** The fixed mode of this message, or null when the vEIR picks one. */
  readonly mode: CoachMode | null;
}

export function createTestBench(kit: Kit, directory: DirectoryCache): TestBench {
  const cfg = kit.config;
  const { logger } = kit.deps;

  /**
   * Authorizes the curator, checks the release and the gates, and records the admission (`test_bench.used`)
   * under the per-person admission lock, so parallel messages cannot all pass the limits. A crisis message
   * skips every gate but authorization (support is never refused for AI reasons), like a founder's.
   */
  function admit(
    ctx: RequestContext,
    args: {
      readonly personaId: string;
      readonly releaseId: string;
      readonly runId: string;
      readonly input: z.output<typeof TestTurnRequest>;
      readonly crisis: boolean;
    },
  ): Promise<Admitted> {
    return kit.inRequest(ctx, async (scope) => {
      const { tx } = scope;
      const persona = await personasRepo.getPersona(tx, args.personaId);
      if (persona?.tenantId !== ctx.tenantId) throw fail.notFound('Persona');
      const via = await requirePersonaCurator(scope, persona, {
        message: 'Only program leads and the EIR this vEIR is built from can try its releases',
      });
      const release = await personasRepo.getRelease(tx, args.releaseId);
      if (release?.personaId !== persona.id) throw fail.notFound('Persona release');
      const reject = (
        code: DomainError['code'],
        message: string,
        reason: string,
        retryAfterSeconds?: number,
      ): DomainError => {
        scope.deferAudit({
          action: code === 'spend_cap_reached' ? 'spend_cap.reached' : 'test_bench.rejected',
          outcome: 'blocked',
          objectType: 'persona',
          objectId: persona.id,
          policyReason: reason,
          metadata: { releaseId: release.id },
        } satisfies auditRepo.AuditEventInput);
        return new DomainError(
          code,
          message,
          retryAfterSeconds === undefined ? { reason } : { reason, retryAfterSeconds },
        );
      };
      const settings = await settingsRepo.getPlatformSettings(tx);
      // A counterpart is only used in a rehearsal, so sending one without a mode asks for that mode.
      const mode = args.input.mode ?? (args.input.rehearsalCounterpart ? 'rehearse' : null);
      if (!args.crisis) {
        const active = await personasRepo.getActiveRelease(tx, persona.id);
        if (release.status !== 'draft' && release.id !== active?.id) {
          throw reject(
            'conflict',
            'Only the active release or a draft can be tried. Choose a release again.',
            'release_not_testable',
          );
        }
        if (!settings.aiEnabled) {
          throw reject(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            'kill_switch',
          );
        }
        if (persona.status === 'suspended') {
          throw reject(
            'persona_suspended',
            'This vEIR is suspended. Resume it to try a release.',
            'persona_suspended',
          );
        }
        if (persona.status === 'retired') {
          throw reject('forbidden', 'This vEIR is retired, so it no longer answers.', 'persona_retired');
        }
        if (!(await consentInForce(scope, persona, kit.now().getTime()))) {
          throw reject(
            'forbidden',
            'This vEIR needs a consent in force that covers doctrine before it can answer. Record one in Consent.',
            'consent_required',
          );
        }
        if (mode !== null && !release.allowedModes.includes(mode)) {
          throw reject('forbidden', `Mode "${mode}" is not enabled in this release`, 'mode_not_allowed');
        }
      }
      await turnsRepo.lockTurnAdmission(tx, ctx.principalId);
      if (!args.crisis) {
        const counts = await turnsRepo.testBenchAdmission(tx, {
          windowSeconds: cfg.turns.rateWindowSeconds,
          inFlightSeconds: cfg.turns.inFlightWindowSeconds,
        });
        if (counts.recent >= cfg.turns.rateLimit) {
          throw reject('rate_limited', MESSAGE_LIMIT_TEXT, 'turn_rate_limit', cfg.turns.rateWindowSeconds);
        }
        if (counts.inFlight >= cfg.turns.maxInFlight) {
          throw reject(
            'rate_limited',
            'Please wait for the answer you are already waiting for.',
            'turns_in_flight',
            5,
          );
        }
        const cap = await turnsRepo.spendCapState(tx, {
          globalUsd: settings.dailyUsdCapGlobal,
          principalUsd: settings.dailyUsdCapPerPrincipal,
        });
        if (cap !== null) {
          throw reject(
            'spend_cap_reached',
            cap === 'global'
              ? 'The daily AI budget for the platform has been reached. Coaching resumes tomorrow (UTC).'
              : 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
            `${cap}_daily_cap`,
            secondsUntilUtcMidnight(kit.now()),
          );
        }
      }
      await audit(scope, {
        action: 'test_bench.used',
        outcome: 'succeeded',
        objectType: 'test_bench_run',
        objectId: args.runId,
        metadata: {
          personaId: persona.id,
          releaseId: release.id,
          releaseVersion: release.version,
          releaseStatus: release.status,
          via,
          mode,
          historyTurns: args.input.history.length,
          crisis: args.crisis,
        },
      });
      const presence = await personasRepo.getPersonaPresence(tx, {
        personaId: persona.id,
        assignedEirProfileId: null,
      });
      return {
        persona,
        release,
        settings,
        via,
        mode,
        personaEirName: persona.kind === 'eir_persona' ? presence.eirName : null,
        presence,
      };
    });
  }

  /** `test_bench.answered` (ids and counts only; never throws): the run is no longer in flight. */
  async function finished(
    ctx: RequestContext,
    runId: string,
    outcome: auditRepo.AuditOutcome,
    policyReason: string | null,
    metadata: auditRepo.AuditEventInput['metadata'],
  ): Promise<void> {
    try {
      await kit.inRequest(ctx, (scope) =>
        audit(scope, {
          action: 'test_bench.answered',
          outcome,
          objectType: 'test_bench_run',
          objectId: runId,
          policyReason,
          ...(metadata === undefined ? {} : { metadata }),
        }),
      );
    } catch (err) {
      logger.error('test_bench.finish_failed', {
        requestId: ctx.requestId,
        runId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  /** The crisis support a founder would get; `screened`: found by the safety screen, not by a crisis rule. */
  function crisisResponse(admitted: Admitted, risk: RiskClassification, screened = false): TestTurnResponse {
    return {
      release: {
        id: admitted.release.id,
        version: admitted.release.version,
        status: admitted.release.status,
      },
      status: 'blocked',
      response: null,
      evidence: [],
      validator: curatorValidator({
        unknownEvidenceIdsRemoved: 0,
        factsDowngraded: 0,
        groundingCoverage: null,
        narrowed: false,
        escalationForced: true,
        identityViolation: false,
        crossVentureViolation: false,
        riskCategories: risk.categories,
        // As the founder's turn records it (run-turn.ts crisisPath), so a curator can tell the two apart.
        notes: screened
          ? ['crisis_support', 'no_model_call', 'safety_screen']
          : ['crisis_support', 'no_model_call'],
      }),
      blocked: { reason: 'crisis_support', supportMessage: CRISIS_SUPPORT_MESSAGE },
    };
  }

  return {
    async runTestTurn(ctx, rawPersonaId, rawInput, options = {}) {
      const startedAt = performance.now();
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(TestTurnRequest, rawInput);
      const releaseId = requireId(input.releaseId, 'Persona release');
      // Crisis detection does not depend on venture names; it decides which gates apply.
      const firstRisk = classifyRisk(input.text);
      const crisis = firstRisk.crisis;
      const runId = randomUUID();
      const admitted = await admit(ctx, { personaId, releaseId, runId, input, crisis });
      if (crisis) {
        await finished(ctx, runId, 'blocked', 'crisis', { modelCalled: false });
        return crisisResponse(admitted, firstRisk);
      }

      let outcome: auditRepo.AuditOutcome = 'failed';
      let policyReason: string | null = 'internal';
      let metadata: auditRepo.AuditEventInput['metadata'] = { releaseVersion: admitted.release.version };
      try {
        const { persona, release, settings } = admitted;
        // No venture: every venture of the tenant (its name, canary and members) is another venture here.
        const others = await directory.others(ctx.tenantId, null);
        const { eirNames } = await directory.get(ctx.tenantId);
        // The founder pipeline's safety screen, on the same terms (run-turn.ts): a curator trying a release sees
        // what a founder would.
        const screen = await screenIndirectIdeation(kit, {
          meter: { ctx, ...METER },
          founderText: input.text,
          previousReply: input.history.at(-1)?.answer ?? null,
          crisis: firstRisk.crisis,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const risk = withSafetyScreen(
          classifyRisk(input.text, {
            otherVentureNames: others.names,
            otherVentureMemberNames: others.memberNames,
          }),
          screen ?? 'clear',
        );
        if (risk.crisis) {
          outcome = 'blocked';
          policyReason = 'crisis';
          metadata = {
            ...metadata,
            modelCalled: false,
            ...(screen === 'crisis' ? { safetyScreen: true } : {}),
          };
          return crisisResponse(admitted, risk, screen === 'crisis');
        }
        const history: HistoryTurn[] = input.history
          .slice(-cfg.turns.historyTurns)
          .map((exchange) => ({ founderText: exchange.text, answer: exchange.answer }));
        const query = buildRetrievalQuery({
          founderText: input.text,
          previousAnswer: history.at(-1)?.answer ?? null,
          currentGoal: null,
        });
        const embedding = await embedRetrievalQuery(kit, ctx, METER, query, options.signal);
        // The common pool only: the persona's library and lessons, the program corpus and resources.
        const pack = await kit.inRequest(ctx, (scope) =>
          retrieveEvidence(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId: null,
            personaId: persona.id,
            stage: null,
            query,
            embedding,
            // What a venture assigned with the default ceiling sees.
            dataClassCeiling: 'venture_private',
            budgets: cfg.retrieval,
            privateOwnerId: null,
          }),
        );
        const allowedModes = release.allowedModes;
        const answered = await answerTurn({
          kit,
          ctx,
          meter: METER,
          ids: { sessionId: runId, turnId: runId },
          release,
          personaName: persona.name,
          personaEirName: admitted.personaEirName,
          presence: admitted.presence,
          mode: admitted.mode,
          allowedModes,
          fallbackMode: allowedModes[0] ?? 'diagnose',
          risk,
          settings,
          venture: null,
          conversationGoal: null,
          rehearsalCounterpart: input.rehearsalCounterpart ?? null,
          channel: 'text',
          continuity: { founderFirstName: null },
          leftOff: '',
          evidence: pack.items,
          history,
          opener: null,
          founderText: input.text,
          // Nobody is addressed by name: the curator is no founder of a venture.
          guards: { eirNames, addressees: [], others },
          emit: quiet,
          speechKey: null,
          signal: options.signal,
          startedAt,
        });
        if (answered.kind === 'generation_failed') {
          const error = generationError(answered.cause);
          policyReason = error.reason ?? error.code;
          metadata = { ...metadata, code: error.code, attempts: answered.attempts.length };
          throw error;
        }
        const { checked, shown, generation, context } = answered;
        const totals = generationTotals(generation);
        outcome = checked.blocked ? 'blocked' : 'succeeded';
        policyReason = checked.blocked ? (checked.blockReason ?? 'blocked') : null;
        metadata = {
          ...metadata,
          riskLabel: riskLabel(risk),
          autoMode: admitted.mode === null,
          mode: checked.response.mode,
          modelId: generation.modelId,
          fallbackUsed: generation.fallbackUsed,
          attempts: generation.attempts.length,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          evidence: shown.length,
          library: pack.counts.shared,
          lessons: pack.counts.patterns,
          historyTurns: context.historyTurns,
          inputTokensEstimate: context.estimatedInputTokens,
          factsDowngraded: checked.results.factsDowngraded,
          unknownEvidenceIdsRemoved: checked.results.unknownEvidenceIdsRemoved,
          narrowed: checked.results.narrowed,
          escalationForced: checked.results.escalationForced,
          identityViolation: checked.results.identityViolation,
          crossVentureViolation: checked.results.crossVentureViolation,
          totalMs: Math.round(performance.now() - startedAt),
        };
        const reason = checked.blocked ? participantBlockReason(checked.blockReason ?? 'blocked') : null;
        return {
          release: { id: release.id, version: release.version, status: release.status },
          status: checked.blocked ? 'blocked' : 'completed',
          response: checked.blocked ? null : checked.response,
          evidence: shown.map((k) => k.item),
          validator: curatorValidator(checked.results),
          blocked: reason === null ? null : { reason, supportMessage: supportMessageFor(reason) },
        };
      } finally {
        await finished(ctx, runId, outcome, policyReason, metadata);
      }
    },
  };
}
