import {
  AUTO_MODE,
  CROSS_VENTURE_BLOCK_ANSWER,
  INJECTION_DECLINE,
  INVALID_RESPONSE_ANSWER,
  buildSystemPromptParts,
  checksForRepeats,
  classifyRisk,
  deriveSpoken,
  echoesInjection,
  founderMoves,
  injectionPayloadsOf,
  isModelGatewayError,
  openerSaidHello,
  questionsAskedIn,
  responseStrings,
  SOCIAL_BUDGETS,
  socialTurnOf,
  spokenHandBackFor,
  validateCoachResponse,
  withoutReasks,
  type CoachResponseValidation,
  type GateBlockReason,
  type HistoryTurn,
  type InjectionPayloads,
  type ModelAttempt,
  type PromptContinuity,
  type PromptRelease,
  type PromptVentureContext,
  type RiskClassification,
} from '@foundry/ai';
import {
  type CoachMode,
  type PlatformSettingsView,
  type TurnChannel,
  type TurnStreamEvent,
  type ValidatorResults,
} from '@foundry/contracts';
import { type personasRepo } from '@foundry/db';

import { type SessionSigningKey } from '../auth/session-token.js';
import { type RequestContext } from '../context.js';
import { DomainError, isDomainError, toDomainError } from '../errors.js';
import { type OtherVentures } from '../internal/directory.js';
import { type Kit } from '../internal/kit.js';
import { assembleContext, type AssembledContext } from './context-budget.js';
import { type KeyedEvidence } from './evidence.js';
import {
  GenerationFailure,
  INJECTION_ECHO_NOTE,
  generateStreamed,
  generateWhole,
  type Generation,
  type GenerationMeter,
} from './generate.js';

/**
 * Steps 4–6 of a turn (system design §7), shared by founder turns (`runTurn`) and the EIR studio's test bench
 * (`runTestTurn`): assemble the prompt from the release's doctrine and style, what the vEIR remembers, the
 * evidence and the history; generate (streamed through the sentence gate, or whole); validate the response
 * deterministically (identity, cross-venture, grounding, escalation). Nothing is stored here: the caller
 * persists the turn (a founder turn) or returns it (a test conversation).
 */
export interface AnswerSpec {
  readonly kit: Kit;
  readonly ctx: RequestContext;
  readonly meter: GenerationMeter;
  /** Ids the speech units and logs carry. */
  readonly ids: { readonly sessionId: string; readonly turnId: string };
  readonly release: Pick<PromptRelease, 'version' | 'doctrine' | 'style' | 'disclosureText'>;
  readonly personaName: string;
  /** Display name of the EIR the persona is built from (its own consented profile); null for a guide. */
  readonly personaEirName: string | null;
  /**
   * How the vEIR is present (`personasRepo.getPersonaPresence`): it speaks in its EIR's own voice only with the
   * first-person consent, and says its EIR sees the work only when that EIR is the venture's. Default: neither.
   */
  readonly presence?: Pick<personasRepo.PersonaPresence, 'firstPerson' | 'eirSeesWork'>;
  /** The fixed mode, or null when the model picks one (auto mode). */
  readonly mode: CoachMode | null;
  readonly allowedModes: readonly CoachMode[];
  /** Mode the annotations fall back to when they fail in auto mode. */
  readonly fallbackMode: CoachMode;
  readonly risk: RiskClassification;
  readonly settings: Pick<PlatformSettingsView, 'groundingCoverageThreshold' | 'streamingEnabled'>;
  /** The venture the conversation belongs to; null for a test conversation. */
  readonly venture: PromptVentureContext | null;
  readonly conversationGoal: string | null;
  readonly rehearsalCounterpart: string | null;
  readonly channel: TurnChannel;
  readonly continuity: PromptContinuity;
  /**
   * The rendered "## Where you left off" section (orchestrator/continuity-prompt.ts), or '' (none, a temporary
   * chat, a test conversation). Untrusted data at the start of the final user message.
   */
  readonly leftOff: string;
  readonly evidence: readonly KeyedEvidence[];
  readonly history: readonly HistoryTurn[];
  readonly opener: string | null;
  readonly founderText: string;
  readonly guards: {
    /** Every EIR's name: the vEIR never speaks as one. */
    readonly eirNames: readonly string[];
    /** People the reply may address by name (the founder and their team). */
    readonly addressees: readonly string[];
    readonly others: OtherVentures;
  };
  readonly emit: (event: TurnStreamEvent) => Promise<void>;
  readonly speechKey: Promise<SessionSigningKey> | null;
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
}

export type AnswerOutcome =
  | {
      readonly kind: 'answered';
      readonly context: AssembledContext;
      /** Evidence shown to the model (the only items it may cite). */
      readonly shown: KeyedEvidence[];
      readonly generation: Generation;
      /** The validated response, authoritative over anything streamed. */
      readonly checked: CoachResponseValidation;
    }
  | {
      /** The model failed; every billable attempt made is already in the usage ledger. */
      readonly kind: 'generation_failed';
      readonly cause: unknown;
      readonly attempts: readonly ModelAttempt[];
    };

/**
 * Whether the founder has already met the vEIR in this conversation: it answered before, the conversation opened with
 * its opener, or this is a call, which always opens with the vEIR's intro. Then a reply never introduces it again
 * (LAB-M16: in the evals matrix every reply of a first conversation opened "Hi Ines, I'm Ruth's vEIR."); only the
 * first reply of a first meeting may.
 */
export function alreadyIntroduced(spec: Pick<AnswerSpec, 'history' | 'opener' | 'channel'>): boolean {
  return (
    spec.history.some((t) => t.answer !== null && t.answer.trim() !== '') ||
    spec.opener !== null ||
    spec.channel === 'voice'
  );
}

/**
 * The validation of a turn the sentence gate stopped. The final validator normally reaches the same verdict
 * on the text the gate saw; when it does not (a guarded string cut differently), the gate's verdict stands
 * and nothing from the stopped text is kept: the stored answer is the fixed placeholder for the reason.
 */
export function enforceGateBlock(
  checked: CoachResponseValidation,
  reason: GateBlockReason,
  channel: TurnChannel,
): CoachResponseValidation {
  if (checked.blocked) return checked;
  const results: ValidatorResults = {
    ...checked.results,
    crossVentureViolation: checked.results.crossVentureViolation || reason === 'cross_venture',
    identityViolation: checked.results.identityViolation || reason === 'identity',
  };
  const answer = reason === 'cross_venture' ? CROSS_VENTURE_BLOCK_ANSWER : INVALID_RESPONSE_ANSWER;
  return {
    response: {
      ...checked.response,
      answer,
      claims: [],
      uncertainty: [],
      challenge: null,
      next_actions: [],
      memory_candidates: [],
      follow_up_questions: [],
      rehearsal: null,
      spoken: channel === 'voice' ? deriveSpoken(answer) : null,
    },
    results,
    blocked: true,
    blockReason: reason,
  };
}

/**
 * Whether the deterministic classifier flagged the founder's message: prompt injection, a cross-venture request or a
 * crisis. Such a turn's reply is never continued or written anew (generate.ts, evals MX-0004).
 */
export function flaggedTurn(
  risk: Pick<RiskClassification, 'injection' | 'crossVentureRequest' | 'crisis'>,
): boolean {
  return risk.injection || risk.crossVentureRequest || risk.crisis;
}

/**
 * The validated response of a turn whose reply carried out an injected instruction (evals MX-0004): the reply is the
 * fixed decline, said as written on a call, and nothing the model wrote is kept (no claims, actions, memory or
 * follow-ups; an escalation reason that reproduces the instruction is cleared). Blocked stays blocked.
 */
export function declineInjectionEcho(
  checked: CoachResponseValidation,
  channel: TurnChannel,
  payloads: InjectionPayloads | null,
): CoachResponseValidation {
  const escalation = checked.response.escalation;
  return {
    ...checked,
    response: {
      ...checked.response,
      answer: INJECTION_DECLINE,
      spoken: channel === 'voice' ? INJECTION_DECLINE : null,
      claims: [],
      uncertainty: [],
      challenge: null,
      next_actions: [],
      memory_candidates: [],
      follow_up_questions: [],
      rehearsal: null,
      escalation:
        escalation.reason !== null && echoesInjection(escalation.reason, payloads)
          ? { ...escalation, reason: null }
          : escalation,
    },
    results: {
      ...checked.results,
      notes: checked.results.notes.includes(INJECTION_ECHO_NOTE)
        ? checked.results.notes
        : [...checked.results.notes, INJECTION_ECHO_NOTE],
    },
  };
}

/**
 * A generation's reply (`answer`, and `spoken` on a call) without the questions the vEIR already asked earlier in the
 * conversation (`asked`, {@link questionsAskedIn}): the sentence gate never showed or said them, and a reply written
 * whole never asks them either. A reply that would be left with nothing keeps them.
 */
function withoutEarlierQuestions(
  raw: unknown,
  asked: readonly ReadonlySet<string>[],
): { readonly raw: unknown; readonly dropped: number } {
  if (asked.length === 0 || typeof raw !== 'object' || raw === null) return { raw, dropped: 0 };
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  let dropped = 0;
  for (const field of ['answer', 'spoken'] as const) {
    const value = out[field];
    if (typeof value !== 'string') continue;
    const kept = withoutReasks(value, asked);
    if (kept.dropped === 0 || kept.text === '') continue;
    out[field] = kept.text;
    if (field === 'answer') dropped = kept.dropped;
  }
  return { raw: out, dropped };
}

/** What a failed generation is reported as: the model being unavailable, or the domain error it carried. */
export function generationError(cause: unknown): DomainError {
  if (isModelGatewayError(cause)) {
    return new DomainError('model_unavailable', 'The coach could not answer right now. Please try again.', {
      reason: cause.code,
      retryAfterSeconds: 5,
      cause,
    });
  }
  const mapped = toDomainError(cause);
  return isDomainError(mapped)
    ? mapped
    : new DomainError('internal', 'Something went wrong while answering. Please try again.', {
        cause,
        reason: 'internal',
      });
}

/** Steps 4–6 (see {@link AnswerSpec}). Emits the `reasoning` and `validating` status events. */
export async function answerTurn(spec: AnswerSpec): Promise<AnswerOutcome> {
  const { kit, risk, settings, guards, emit } = spec;
  const cfg = kit.config;

  // Step 4: assemble context (≤ maxInputTokens): rules and persona, the vEIR's notes, history, evidence.
  const today = kit.now().toISOString().slice(0, 10);
  const prompt = buildSystemPromptParts({
    release: {
      version: spec.release.version,
      doctrine: spec.release.doctrine,
      style: spec.release.style,
      disclosureText: spec.release.disclosureText,
      personaName: spec.personaName,
      eirName: spec.personaEirName,
      firstPerson: spec.presence?.firstPerson === true,
      eirSeesWork: spec.presence?.eirSeesWork === true,
    },
    mode: spec.mode ?? AUTO_MODE,
    allowedModes: spec.allowedModes,
    policy: {
      // The cross-venture flag stays out of the prompt: the model would otherwise answer differently
      // for a real venture name than for an unknown one (a membership oracle). The always-on rule that
      // the workspace belongs to one venture, and the output validator, cover it.
      riskCategories: risk.categories.filter((c) => c !== 'cross_venture_request'),
      groundingThreshold: settings.groundingCoverageThreshold,
      crisis: false,
    },
    ventureContext: spec.venture,
    conversationGoal: spec.conversationGoal,
    rehearsalCounterpart: spec.mode === 'rehearse' || spec.mode === null ? spec.rehearsalCounterpart : null,
    today,
    channel: spec.channel,
    continuity: spec.continuity,
  });
  const system = `${prompt.stable}${prompt.turn}`;
  const context = assembleContext({
    system,
    evidence: spec.evidence.map((k) => k.item),
    history: spec.history,
    founderText: spec.founderText,
    maxInputTokens: cfg.turns.maxInputTokens,
    maxHistoryTurns: cfg.turns.historyTurns,
    continuity: spec.continuity,
    leftOff: spec.leftOff,
    today,
    opener: spec.opener,
  });
  const shown: KeyedEvidence[] = spec.evidence.filter((k) => context.shownKeys.has(k.item.key));
  const evidenceKeys = new Set(shown.map((k) => k.item.key));
  // The first reply after an opening line that said hello (a call's intro) does not greet again, and no later reply
  // does unless the founder greets (LAB-R4: "Good to talk again." opened both replies after the intro said it).
  const greeted =
    spec.history.length === 0
      ? context.openerReplayed && openerSaidHello(spec.opener)
      : !founderMoves(spec.founderText).includes('greeting');
  // Conversation craft (validators/social.ts): a social turn gets a short reply, a reply never says the previous one
  // (or the opener) again, and a call's reply that ends on a statement hands the turn back.
  const lastAnswer = spec.history.at(-1)?.answer ?? null;
  const previousReply =
    spec.history.length > 0 ? lastAnswer : context.openerReplayed ? (spec.opener ?? null) : null;
  // A hello that opens the conversation (nothing said before it) is answered with the pick-up of last time.
  const read = socialTurnOf(spec.founderText);
  const social = read === 'greeting' && previousReply === null ? null : read;
  // Never a hand-back the conversation already heard (the replies in view, and the opener).
  const handBack =
    spec.channel === 'voice'
      ? spokenHandBackFor(spec.founderText, spec.ids.turnId, [
          ...spec.history.map((t) => t.answer),
          spec.opener ?? null,
        ])
      : null;

  const introduced = alreadyIntroduced(spec);
  // Every message of the vEIR's in this conversation: a question any of them asked is never asked again (voice suite:
  // one question in five replies of a call), unless the founder asks to hear it again or asks what the coach is.
  const earlier = [spec.opener, ...spec.history.map((t) => t.answer)].filter(
    (t): t is string => t !== null && t.trim() !== '',
  );
  const askedEarlier = checksForRepeats(spec.founderText, {
    personaName: spec.personaName,
    eirNames: guards.eirNames,
    personaEirName: spec.personaEirName,
    addressees: guards.addressees,
  })
    ? questionsAskedIn(earlier)
    : [];
  // A flagged message is never answered by a continuation; an injected instruction is never carried out (MX-0004),
  // on its turn or later (the lab: declined on its turn, then carried out when the next message was "…").
  const flagged = flaggedTurn(risk);
  const payloads = injectionPayloadsOf([
    ...(risk.injection ? [spec.founderText] : []),
    ...spec.history.map((t) => t.founderText).filter((text) => classifyRisk(text).injection),
  ]);

  // Step 5: generate (streamed through the sentence gate, or whole when streaming is switched off).
  await emit({ event: 'turn.status', phase: 'reasoning', detail: null, evidenceCount: shown.length });
  const streaming = settings.streamingEnabled !== false;
  const base = {
    kit,
    ctx: spec.ctx,
    meter: spec.meter,
    sessionId: spec.ids.sessionId,
    turnId: spec.ids.turnId,
    system,
    messages: context.messages,
    // Bedrock prompt caching: the rules up to the notes are the same on every turn of the conversation, and every
    // message before the founder's new one is an earlier exchange (docs/runbooks/latency.md).
    promptCache: { systemChars: prompt.stable.length, historyMessages: context.messages.length - 1 },
    channel: spec.channel,
    mode: spec.mode,
    allowedModes: spec.allowedModes,
    fallbackMode: spec.fallbackMode,
    signal: spec.signal,
    startedAt: spec.startedAt,
    narration: { founder: spec.continuity.founderFirstName ?? null, people: guards.addressees },
    handBack,
    flagged,
  };
  let generation: Generation;
  try {
    generation = streaming
      ? await generateStreamed({
          ...base,
          emit,
          speechKey: spec.speechKey,
          gate: {
            personaName: spec.personaName,
            eirNames: guards.eirNames,
            personaEirName: spec.personaEirName,
            addressees: guards.addressees,
            founderName: spec.continuity.founderFirstName ?? null,
            greeted,
            replyBudget: social === null ? null : SOCIAL_BUDGETS[social],
            previousReply,
            askedBefore: earlier,
            injectionPayloads: payloads,
            founderText: spec.founderText,
            introduced,
            otherVentureNames: guards.others.names,
            otherVentureCanaries: guards.others.canaries,
            otherVentureMemberNames: guards.others.memberNames,
            evidenceKeys,
          },
        })
      : await generateWhole(base);
  } catch (err) {
    return {
      kind: 'generation_failed',
      cause: err instanceof GenerationFailure ? err.cause : err,
      attempts: err instanceof GenerationFailure ? err.attempts : [],
    };
  }

  // Step 6: deterministic validation of the whole response (authoritative over any streamed unit).
  await emit({ event: 'turn.status', phase: 'validating', detail: null, evidenceCount: shown.length });
  const unasked = withoutEarlierQuestions(generation.raw, askedEarlier);
  const validated = validateCoachResponse(unasked.raw, {
    evidenceKeys,
    preRisk: risk,
    otherVentureNames: guards.others.names,
    otherVentureCanaries: guards.others.canaries,
    otherVentureMemberNames: guards.others.memberNames,
    personaName: spec.personaName,
    coverageThreshold: settings.groundingCoverageThreshold,
    ...(spec.mode === null ? { allowedModes: spec.allowedModes } : { expectedMode: spec.mode }),
    eirNames: guards.eirNames,
    personaEirName: spec.personaEirName,
    addressees: guards.addressees,
    founderName: spec.continuity.founderFirstName ?? null,
    greeted,
    previousReply,
    // A streamed reply handed the turn back as it was said (generate.ts); a reply written whole gets it here.
    handBack: generation.stream?.fallback === null ? null : handBack,
    social,
    founderText: spec.founderText,
    introduced,
    channel: spec.channel,
  });
  validated.results.notes.push(...generation.notes);
  if (unasked.dropped > 0) validated.results.notes.push(`earlier_questions_removed:${unasked.dropped}`);
  const enforced =
    generation.gateBlocked === null
      ? validated
      : enforceGateBlock(validated, generation.gateBlocked, spec.channel);
  // An injected instruction carried out is never shown or said, whichever path wrote the reply (MX-0004).
  const echoed =
    generation.notes.includes(INJECTION_ECHO_NOTE) ||
    responseStrings(enforced.response).some((text) => echoesInjection(text, payloads));
  const checked = echoed ? declineInjectionEcho(enforced, spec.channel, payloads) : enforced;
  return { kind: 'answered', context, shown, generation, checked };
}
