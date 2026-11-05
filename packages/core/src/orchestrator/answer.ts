import {
  AUTO_MODE,
  CROSS_VENTURE_BLOCK_ANSWER,
  asksToRepeat,
  INVALID_RESPONSE_ANSWER,
  buildSystemPromptParts,
  deriveSpoken,
  forcedEscalationFor,
  founderMoves,
  identityQuestionOf,
  isModelGatewayError,
  openerSaidHello,
  SOCIAL_BUDGETS,
  socialTurnOf,
  spokenHandBackFor,
  validateCoachResponse,
  wrapUpOf,
  type CoachResponseValidation,
  type GateBlockReason,
  type HistoryTurn,
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
  generateStreamed,
  generateWhole,
  type FaceApproval,
  type Generation,
  type GenerationMeter,
} from './generate.js';
import { withoutTrailingFields } from './reply-extract.js';

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
  /** A call's FULL face pre-approval for this turn's units (absent or null: none). */
  readonly faceApproval?: Promise<FaceApproval | null> | null;
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
export async function answerTurn(raw: AnswerSpec): Promise<AnswerOutcome> {
  // Earlier replies as the founder read them: structured blocks a model once wrote after a reply never return as history
  // (where they taught the format to every later reply of the session).
  const spec: AnswerSpec = {
    ...raw,
    history: raw.history.map((t) =>
      t.answer === null ? t : { ...t, answer: withoutTrailingFields(t.answer) },
    ),
  };
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
  // Every earlier reply in view, and the opener, is never said again either (live pilot 42099643194: with the previous
  // reply alone checked, replies alternated A, B, A, B).
  const earlierReplies =
    spec.history.length > 0
      ? [...spec.history.slice(0, -1).map((t) => t.answer), context.openerReplayed ? spec.opener : null]
      : [];
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
  // A whole reply that says the conversation again is written once more with what was said (generateWhole), unless
  // the founder asked to hear it again or sincerely asks who or what the coach is (its honest answer always stands).
  const saidBefore = [previousReply, ...earlierReplies].filter(
    (t): t is string => typeof t === 'string' && t.trim() !== '',
  );
  const alreadySaid =
    saidBefore.length === 0 ||
    asksToRepeat(spec.founderText) ||
    identityQuestionOf(spec.founderText, {
      personaName: spec.personaName,
      eirNames: guards.eirNames,
      personaEirName: spec.personaEirName,
      addressees: guards.addressees,
    }) !== null
      ? null
      : { text: saidBefore.join('\n\n'), keepReferrals: forcedEscalationFor(risk) !== null };
  const wrapUp = risk.categories.length === 0 && !risk.crisis && wrapUpOf(spec.founderText);

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
    alreadySaid,
  };
  let generation: Generation;
  try {
    generation = streaming
      ? await generateStreamed({
          ...base,
          emit,
          speechKey: spec.speechKey,
          faceApproval: spec.faceApproval ?? null,
          gate: {
            personaName: spec.personaName,
            eirNames: guards.eirNames,
            personaEirName: spec.personaEirName,
            addressees: guards.addressees,
            founderName: spec.continuity.founderFirstName ?? null,
            greeted,
            // A wrap-up ("got it, I'll send it Friday") is answered as briefly as a goodbye: no new homework. Never a
            // turn with any risk flag (the classifier's or the safety screen's): it needs the escalation, not a sign-off.
            replyBudget: social !== null ? SOCIAL_BUDGETS[social] : wrapUp ? SOCIAL_BUDGETS.closing : null,
            previousReply,
            earlierReplies,
            // A flagged turn never loses its referral as a repeat, and is never cut short for one.
            keepReferrals: forcedEscalationFor(risk) !== null,
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
  const validated = validateCoachResponse(generation.raw, {
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
    earlierReplies,
    // What the gate released was shown or said as it stands: never edited for repeats again.
    released: generation.stream !== null && generation.stream.fallback === null,
    // A streamed reply handed the turn back as it was said (generate.ts); a reply written whole gets it here.
    handBack: generation.stream?.fallback === null ? null : handBack,
    social,
    founderText: spec.founderText,
    introduced,
    channel: spec.channel,
  });
  validated.results.notes.push(...generation.notes);
  const checked =
    generation.gateBlocked === null
      ? validated
      : enforceGateBlock(validated, generation.gateBlocked, spec.channel);
  return { kind: 'answered', context, shown, generation, checked };
}
