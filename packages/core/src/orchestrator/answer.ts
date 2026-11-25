import {
  AUTO_MODE,
  CROSS_VENTURE_BLOCK_ANSWER,
  askedBefore,
  asksToRepeat,
  INVALID_RESPONSE_ANSWER,
  buildSystemPromptParts,
  deriveSpoken,
  forcedEscalationFor,
  founderMoves,
  identityQuestionOf,
  inDistress,
  isModelGatewayError,
  openerSaidHello,
  SHORT_BUDGET,
  SOCIAL_BUDGETS,
  YES_NO_BUDGET,
  socialTurnOf,
  validateCoachResponse,
  statedPreferences,
  stuckOn,
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
import {
  checkReply,
  guidanceWords,
  owesStep,
  promptInput,
  renderPathGuidance,
  replyChecks,
  spokenStepLine,
  type PathPromptGuidance,
} from '../path/ai-adapter.js';
import { assembleContext, type AssembledContext } from './context-budget.js';
import { type KeyedEvidence } from './evidence.js';
import {
  GenerationFailure,
  generateStreamed,
  generateWhole,
  type AnnotationsResult,
  type FaceApproval,
  type Generation,
  type GenerationMeter,
} from './generate.js';
import { thinkFor } from './think.js';
import { withoutTrailingFields } from './reply-extract.js';
import { pathAnnotationMessages, pathReportRequest } from './turn-prompts.js';

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
  readonly presence?: Pick<personasRepo.PersonaPresence, 'firstPerson' | 'eirSeesWork' | 'mentor'>;
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
  /** What the founder path decided for the turn (core `path/`); absent or null: none (a test conversation). */
  readonly guidance?: PathPromptGuidance | null;
  readonly channel: TurnChannel;
  readonly continuity: PromptContinuity;
  /**
   * The rendered "## Where you left off" section (orchestrator/continuity-prompt.ts), or '' (none, a temporary
   * chat, a test conversation). Untrusted data at the start of the final user message.
   */
  readonly leftOff: string;
  /**
   * The vEIR's replies at the end of the person's own latest conversations with it, newest first
   * (continuity.ts `pastRepliesOf`): read for its phrasing ledger, the forms of its questions and how often it named
   * the founder, never as what was said. Absent: none (a test conversation, a temporary chat).
   */
  readonly pastReplies?: readonly string[];
  readonly evidence: readonly KeyedEvidence[];
  readonly history: readonly HistoryTurn[];
  /**
   * The founder's messages of this conversation from before `history` that hold a number: what they said there is
   * theirs when a reply says it back (validators/figures.ts). Absent: none.
   */
  readonly earlierFounderFigures?: readonly string[];
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
  /**
   * A streamed reply completes without waiting for its fields (phase B): they come as `annotations`, for the caller to
   * add to the stored turn (a founder turn). Absent or false: they are waited for (the studio's test conversation).
   */
  readonly deferAnnotations?: boolean;
}

/** A streamed reply's fields (phase B) under way. */
export interface PendingFields {
  /** The fields added to the validated response, once they arrive. */
  readonly result: Promise<AnnotatedTurn>;
  /**
   * Stops phase B when nothing will read it (the turn failed or was held back), and waits until what it cost is metered:
   * a request never ends with an unmetered model call still running (on Lambda it could be frozen mid-call).
   */
  stop(): Promise<void>;
}

export type AnswerOutcome =
  | {
      readonly kind: 'answered';
      readonly context: AssembledContext;
      /** Evidence shown to the model (the only items it may cite). */
      readonly shown: KeyedEvidence[];
      readonly generation: Generation;
      /**
       * The validated response, authoritative over anything streamed. With `annotations` under way, its fields are
       * empty but for a forced escalation: the reply, as validated, is what the founder read and heard.
       */
      readonly checked: CoachResponseValidation;
      /** A streamed reply's fields, arriving after it (`deferAnnotations`); null when `checked` has them already. */
      readonly annotations: PendingFields | null;
      /**
       * A call's reply left the decided step out: the server's one sentence for it, already in `checked`'s answer and
       * spoken form, to be said after the reply's last unit. Null: the reply names it, or owes none.
       */
      readonly spokenStep: string | null;
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
  const guidance = spec.guidance ?? null;
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
      mentor: spec.presence?.mentor === true,
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
    ...promptInput(guidance),
  });
  const system = `${prompt.stable}${prompt.turn}`;
  // The path's decision is in the system prompt (the coaching package renders it there); a build that does not render
  // it gets it at the start of the founder's message.
  const rendered = guidance === null ? '' : renderPathGuidance(guidance, spec.channel, today);
  const leftOff =
    rendered === '' || prompt.turn.includes(rendered)
      ? spec.leftOff
      : [rendered, spec.leftOff].filter((t) => t !== '').join('\n\n');
  const context = assembleContext({
    system,
    evidence: spec.evidence.map((k) => k.item),
    history: spec.history,
    founderText: spec.founderText,
    maxInputTokens: cfg.turns.maxInputTokens,
    maxHistoryTurns: cfg.turns.historyTurns,
    continuity: spec.continuity,
    leftOff,
    today,
    opener: spec.opener,
    guidance,
    ...(spec.pastReplies === undefined ? {} : { pastReplies: spec.pastReplies }),
  });
  const shown: KeyedEvidence[] = spec.evidence.filter((k) => context.shownKeys.has(k.item.key));
  const evidenceKeys = new Set(shown.map((k) => k.item.key));
  // The first reply after an opening line that said hello (a call's intro, or a model-written opener that greets in
  // its own words: "Good to see you again, Maya. …") does not greet again, and no later reply does unless the founder
  // greets (LAB-R4: "Good to talk again." opened both replies after the intro said it).
  const founderNames = spec.continuity.founderFirstName ? [spec.continuity.founderFirstName] : [];
  const greeted =
    spec.history.length === 0
      ? context.openerReplayed && openerSaidHello(spec.opener, founderNames)
      : !founderMoves(spec.founderText).includes('greeting');
  // Conversation craft (validators/social.ts): a social turn gets a short reply, and a reply never says the previous one
  // (or the opener) again.
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

  // A coaching reply on the path starts with its answer, the first one too: only a hello is met with a name.
  const introduced =
    alreadyIntroduced(spec) ||
    (guidance !== null && guidance.kind !== 'social' && guidance.kind !== 'rehearsal');
  // A whole reply that says the conversation again is written once more with what was said (generateWhole), unless
  // the founder asked to hear it again or sincerely asks who or what the coach is (its honest answer always stands).
  const saidBefore = [previousReply, ...earlierReplies].filter(
    (t): t is string => typeof t === 'string' && t.trim() !== '',
  );
  const identityAsked =
    identityQuestionOf(spec.founderText, {
      personaName: spec.personaName,
      eirNames: guards.eirNames,
      personaEirName: spec.personaEirName,
      mentor: spec.presence?.mentor === true,
      addressees: guards.addressees,
    }) !== null;
  const alreadySaid =
    saidBefore.length === 0 || asksToRepeat(spec.founderText) || identityAsked
      ? null
      : {
          text: saidBefore.join('\n\n'),
          keepReferrals: forcedEscalationFor(risk) !== null,
          strictQuestions: stuckOn(spec.founderText, previousReply),
          asked: askedBefore(previousReply, earlierReplies),
        };
  const wrapUp = risk.categories.length === 0 && !risk.crisis && wrapUpOf(spec.founderText);
  // How they asked to be answered, kept until they change it (live pilot 42124259353: "yes or no answers only" and "no
  // more questions" were dropped after a reply or two). Never on a flagged turn: its referral must be said whole.
  const preferences = statedPreferences(
    spec.history.map((t) => t.founderText),
    spec.founderText,
  );
  const plainTurn = forcedEscalationFor(risk) === null && !risk.crisis;
  const preferenceBudget = !plainTurn
    ? null
    : preferences.includes('yes/no answers')
      ? YES_NO_BUDGET
      : preferences.includes('short answers')
        ? SHORT_BUDGET
        : null;
  const noQuestions = plainTurn && preferences.includes('no questions');
  // The figures a reply may state: what the founder said in view, the sources shown, and what the notes remember of
  // them (validators/figures.ts; a review of B1: a price settled in an earlier conversation was said by its role).
  const knownFigures = [
    ...(spec.earlierFounderFigures ?? []),
    ...spec.history.map((t) => t.founderText),
    spec.founderText,
    ...shown.map((k) => `${k.item.title} ${k.item.excerpt}`),
    ...rememberedText(spec.continuity, spec.venture),
    // The step's and the answer's own figures and dates are the program's, not invented ones.
    ...(guidance === null ? [] : [guidanceWords(guidance)]),
  ].join('\n');

  // What the reply is held to: the path's decision, and what may be stated (the founder's words, the sources, the path).
  const checks = replyChecks(guidance, today, {
    evidence: shown.map((k) => ({ key: k.item.key, title: k.item.title, excerpt: k.item.excerpt })),
    founderText: knownFigures,
    ...(guidance === null
      ? {}
      : {
          guidanceText: guidanceWords(guidance),
          citable: [
            ...(spec.earlierFounderFigures ?? []),
            ...spec.history.map((t) => t.founderText),
            spec.founderText,
            ...rememberedText(spec.continuity, spec.venture),
            guidance.step === null
              ? ''
              : [
                  guidance.step.title,
                  guidance.step.doneWhen,
                  ...guidance.step.items.map((i) => `${i.do} ${i.how}`),
                ].join('\n'),
          ].join('\n'),
        }),
    alsoKnown: [
      spec.personaName,
      spec.personaEirName ?? '',
      spec.venture?.name ?? '',
      ...guards.addressees,
      JSON.stringify(spec.release.doctrine),
      today,
    ].join('\n'),
  });
  // A social turn, a wrap-up, a sincere question about the coach and a founder in distress owe no step.
  const owesContract =
    guidance !== null &&
    social === null &&
    !wrapUp &&
    !risk.categories.includes('safety_wellbeing') &&
    !inDistress(spec.founderText) &&
    !identityAsked;

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
    alreadySaid,
    pathReport: pathReportRequest(system, guidance),
    pathAnnotations:
      prompt.annotation === null ||
      guidance === null ||
      guidance.kind === 'rehearsal' ||
      spec.mode === 'rehearse'
        ? null
        : {
            system: prompt.annotation,
            messages: (answer: string) =>
              pathAnnotationMessages({
                lastFounder: spec.history.at(-1)?.founderText ?? null,
                lastReply: spec.history.at(-1)?.answer ?? null,
                evidence: shown.map((k) => k.item),
                founderText: spec.founderText,
                answer,
              }),
          },
  };
  let generation: Generation;
  try {
    generation = streaming
      ? await generateStreamed({
          ...base,
          emit,
          think: thinkFor(cfg.turns.think, { channel: spec.channel, guidance, coaches: owesContract }),
          speechKey: spec.speechKey,
          faceApproval: spec.faceApproval ?? null,
          gate: {
            personaName: spec.personaName,
            eirNames: guards.eirNames,
            personaEirName: spec.personaEirName,
            mentor: spec.presence?.mentor === true,
            addressees: guards.addressees,
            founderName: spec.continuity.founderFirstName ?? null,
            greeted,
            // A wrap-up ("got it, I'll send it Friday") is answered as briefly as a goodbye: no new homework. Never a
            // turn with any risk flag (the classifier's or the safety screen's): it needs the escalation, not a sign-off.
            replyBudget:
              social !== null ? SOCIAL_BUDGETS[social] : wrapUp ? SOCIAL_BUDGETS.closing : preferenceBudget,
            noQuestions,
            knownFigures,
            ...checks,
            previousReply,
            earlierReplies,
            pastReplies: spec.pastReplies ?? [],
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
  const options: Parameters<typeof validateCoachResponse>[1] = {
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
    mentor: spec.presence?.mentor === true,
    addressees: guards.addressees,
    founderName: spec.continuity.founderFirstName ?? null,
    greeted,
    previousReply,
    earlierReplies,
    pastReplies: spec.pastReplies ?? [],
    // What the gate released was shown or said as it stands: never edited for repeats again.
    released: generation.stream !== null && generation.stream.fallback === null,
    social,
    noQuestions,
    knownFigures,
    ...checks,
    founderText: spec.founderText,
    introduced,
    channel: spec.channel,
  };
  const validated = validateCoachResponse(generation.raw, options);
  validated.results.notes.push(...generation.notes);
  const gated =
    generation.gateBlocked === null
      ? validated
      : enforceGateBlock(validated, generation.gateBlocked, spec.channel);
  // The reply contract: a reply that leaves the decided step out (or only asks) is completed from the decision, never by
  // a second model call. A reply the founder spoke over stands as they heard it.
  const { checked, spokenStep } =
    guidance === null || !owesContract || gated.blocked || generation.stream?.interrupted === true
      ? { checked: gated, spokenStep: null }
      : withReplyContract(gated, guidance, {
          channel: spec.channel,
          today,
          founderText: spec.founderText,
        });
  await streamAdded(spec, generation, gated, checked);
  const pending = generation.annotations ?? null;
  if (pending === null)
    return { kind: 'answered', context, shown, generation, checked, annotations: null, spokenStep };
  if (checked.blocked) {
    // Nothing will read the fields of a reply that was held back: the call is stopped (what it cost is metered).
    pending.cancel();
    await pending.result;
    return { kind: 'answered', context, shown, generation, checked, annotations: null, spokenStep };
  }
  const annotations = pending.result.then((result) => ({
    checked: withAnnotations(checked, generation.raw, result, options),
    attempts: result.attempts,
    latencyMs: result.latencyMs,
  }));
  if (spec.deferAnnotations === true) {
    const stop = async (): Promise<void> => {
      pending.cancel();
      await pending.result;
    };
    return {
      kind: 'answered',
      context,
      shown,
      generation,
      checked,
      annotations: { result: annotations, stop },
      spokenStep,
    };
  }
  // Waited for here (the studio's test conversation): one generation, as a reply written whole would be.
  const annotated = await annotations;
  return {
    kind: 'answered',
    context,
    shown,
    generation: {
      ...generation,
      attempts: [...generation.attempts, ...annotated.attempts],
      latencyMs: generation.latencyMs + annotated.latencyMs,
      annotations: null,
    },
    checked: annotated.checked,
    annotations: null,
    spokenStep,
  };
}

/** What the contract added after a streamed reply, streamed after it: what was shown is the start of what is stored. */
async function streamAdded(
  spec: AnswerSpec,
  generation: Generation,
  before: CoachResponseValidation,
  after: CoachResponseValidation,
): Promise<void> {
  const { stream } = generation;
  const shown = before.response.answer.trimEnd();
  const full = after.response.answer;
  if (stream?.fallback !== null || stream.deltas === 0) return;
  if (full === before.response.answer || !full.startsWith(shown)) return;
  await spec.emit({
    event: 'turn.delta',
    turnId: spec.ids.turnId,
    seq: stream.deltas,
    text: full.slice(shown.length),
  });
}

/**
 * A validated reply held to the reply contract (`@foundry/ai` `checkReplyContract`, through the path's adapter). Typed:
 * the repaired text stands as the answer. On a call, what was said was said: when the step was left out, the server's
 * one sentence is added to what is said and to the transcript. What was found is noted (codes only).
 */
export function withReplyContract(
  checked: CoachResponseValidation,
  guidance: PathPromptGuidance,
  context: { readonly channel: TurnChannel; readonly today: string; readonly founderText: string },
): { readonly checked: CoachResponseValidation; readonly spokenStep: string | null } {
  const { response } = checked;
  const contract = checkReply(response.answer, guidance, context);
  const voice = context.channel === 'voice';
  const spokenStep =
    voice &&
    guidance.step !== null &&
    owesStep(guidance, context.channel) &&
    contract.findings.includes('missing_step')
      ? spokenStepLine(guidance.step, context.today, guidance.stepRole)
      : null;
  const answer =
    spokenStep !== null
      ? `${response.answer.trimEnd()} ${spokenStep}`
      : voice
        ? response.answer
        : (contract.repaired ?? response.answer);
  if (contract.findings.length === 0 && answer === response.answer) return { checked, spokenStep: null };
  return {
    spokenStep,
    checked: {
      ...checked,
      response: {
        ...response,
        answer,
        spoken:
          spokenStep === null || response.spoken === null || response.spoken === undefined
            ? response.spoken
            : `${response.spoken.trimEnd()} ${spokenStep}`,
      },
      results: {
        ...checked.results,
        notes: [
          ...checked.results.notes,
          ...contract.findings.map((f) => `reply_contract:${f}`),
          ...(answer === response.answer ? [] : ['reply_contract_repaired']),
        ],
      },
    },
  };
}

/** A streamed reply's fields (phase B) added to its validated response, once they arrived. */
export interface AnnotatedTurn {
  /** The response with its fields; its answer and spoken form are the reply as validated and shown. */
  readonly checked: CoachResponseValidation;
  /** Phase B's billable attempts (already in the usage ledger). */
  readonly attempts: readonly ModelAttempt[];
  readonly latencyMs: number;
}

/**
 * `checked` (a streamed reply validated with empty fields) with phase B's fields, validated as part of the whole
 * response: the claims, follow-ups, memory candidates, mode and escalation the validation keeps. The answer and spoken
 * form stay exactly as they were validated, shown and said. Fields the validation would hold back (another venture's
 * name or canary in them, an identity claim, an invalid object) are left out, never the reply, which the gate and the
 * validation already cleared and the founder already read (`annotations_discarded`).
 */
export function withAnnotations(
  checked: CoachResponseValidation,
  raw: unknown,
  result: AnnotationsResult,
  options: Parameters<typeof validateCoachResponse>[1],
): CoachResponseValidation {
  const note = (code: string): CoachResponseValidation => ({
    ...checked,
    results: { ...checked.results, notes: [...checked.results.notes, code] },
  });
  if (result.value === null) return note(result.note ?? 'annotations_unavailable');
  const reply = raw as { readonly answer: string; readonly spoken: string | null };
  const merged = validateCoachResponse(
    { ...result.value, answer: reply.answer, spoken: reply.spoken },
    options,
  );
  // A discard for another venture's name is noted as such only where participants never see it (blocked.ts): the
  // founder's view never tells it from any other discard.
  if (merged.blocked)
    return note(
      merged.blockReason === 'cross_venture'
        ? 'cross_venture_annotations_discarded'
        : 'annotations_discarded',
    );
  return {
    ...checked,
    response: { ...merged.response, answer: checked.response.answer, spoken: checked.response.spoken },
    results: {
      ...merged.results,
      notes: [...new Set([...checked.results.notes, ...merged.results.notes])],
    },
  };
}

/** Notes the vEIR wrote in its own voice, and ids and days of the record: never what the founder gave. */
const OWN_WORDS = new Set([
  'id',
  'lastAdvice',
  'nextOpener',
  'nextTopic',
  'updatedAt',
  'date',
  'due',
  'sessionId',
]);

/**
 * A sentence of a summary that tells what the vEIR put forward ("I suggested charging 40 cedis a session", "we
 * discussed a 10% discount"): distillation summarises the whole conversation, the vEIR's own suggestions included, so a
 * figure there is not one the founder gave (a review of B1: a made-up price that reached a digest then counted as theirs).
 */
const PUT_FORWARD =
  /\b(?:suggest(?:ed|ing|ion)?|advis(?:ed|ing)|advice|recommend(?:ed|ing|ation)?|propos(?:ed|ing|al)|floated|discuss(?:ed|ing)|explored|talked (?:about|through)|walked (?:them|him|her) through|(?:i|we) (?:said|offered|gave|set out|laid out|pointed|proposed))\b/iu;

/** The sentences of a summary that tell what the founder brought, never what the vEIR put forward. */
function foundersSide(summary: string): string {
  return summary
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !PUT_FORWARD.test(sentence))
    .join(' ');
}

/**
 * The text of what the notes remember of the founder and their venture (the notebook, the profile, the digests and
 * commitments, the venture's goal), never the vEIR's own advice or openers, nor what a summary says it put forward:
 * figures the founder gave in an earlier conversation count as given.
 */
export function rememberedText(
  continuity: AnswerSpec['continuity'],
  venture: AnswerSpec['venture'],
): string[] {
  const out: string[] = [];
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      const text = key === 'summary' ? foundersSide(value) : value;
      if (text.trim() !== '') out.push(text);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, item] of Object.entries(value)) if (!OWN_WORDS.has(k)) walk(item, k);
    }
  };
  walk(continuity.notebook ?? null);
  walk(continuity.studentProfile ?? null);
  walk(continuity.recentDigests ?? []);
  walk(continuity.openCommitments ?? []);
  walk(venture?.currentGoal ?? null);
  return out;
}
