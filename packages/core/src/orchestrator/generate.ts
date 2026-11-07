import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  COACH_RESPONSE_SCHEMA_NAME,
  CoachAnnotations,
  MIN_KEPT_WORDS,
  SPOKEN_MAX_WORDS,
  SentenceGate,
  clampWords,
  cutMetaNarration,
  isOnlyLeadIn,
  isModelGatewayError,
  ModelUnavailableError,
  signsOff,
  withoutRepeats,
  withoutUnits,
  type ChatMessage,
  type GateBlockReason,
  type GateResult,
  type GateStats,
  type ModelAttempt,
  type ModelPurpose,
  type NarrationNames,
  type PromptCacheHint,
  type QuestionTerms,
  type SentenceGateOptions,
  type StreamStopReason,
} from '@foundry/ai';
import { CoachResponse, type CoachMode, type TurnChannel, type TurnStreamEvent } from '@foundry/contracts';

import { type SessionSigningKey } from '../auth/session-token.js';
import { type RequestContext } from '../context.js';
import { type Kit } from '../internal/kit.js';
import { signSpeechUnit } from './speech-units.js';
import { ReplyExtractor } from './reply-extract.js';
import {
  annotationMessages,
  answerSystemPrompt,
  continuationMessages,
  emptyAnnotations,
} from './turn-prompts.js';

/** What a turn's generation produced, before the deterministic validation (`validateCoachResponse`). */
export interface Generation {
  /** The candidate response: a full CoachResponse, or a streamed answer merged with its annotations. */
  readonly raw: unknown;
  /** Model that wrote the answer. */
  readonly modelId: string;
  readonly fallbackUsed: boolean;
  /** Every billable model call of the turn (already recorded in the usage ledger). */
  readonly attempts: readonly ModelAttempt[];
  /** Model time in milliseconds (all calls). */
  readonly latencyMs: number;
  /** Extra validator notes (codes only). */
  readonly notes: readonly string[];
  /** The sentence gate stopped the stream: the turn is blocked whatever the final validation finds. */
  readonly gateBlocked: GateBlockReason | null;
  /** Streamed turns: details for the turn record, the audit and the spoken ending. */
  readonly stream: StreamDetails | null;
  /**
   * A streamed reply's phase B, under way when the generation returns (absent: a reply written whole, blocked or
   * interrupted, whose fields, if any, are in `raw`). Nothing the founder waits on waits for it.
   */
  readonly annotations?: PendingAnnotations | null;
}

/**
 * Why a streamed turn's reply was written whole after all: the stream broke after text was shown
 * (`interrupted`), produced nothing presentable (`empty`), was structured output with no reply field the
 * extractor could stream (`structured_output`), or opened with the model thinking aloud about its prompt
 * (`meta_narration`, the sentence gate). Units already sent are superseded by `turn.completed`.
 */
export type StreamFallback = 'interrupted' | 'empty' | 'structured_output' | 'meta_narration';

export interface StreamDetails {
  /** Milliseconds from the start of the turn request to the first `turn.delta`; null when none was sent. */
  readonly firstDeltaMs: number | null;
  /** The model's own time to first text (gateway measure). */
  readonly modelFirstTokenMs: number | null;
  readonly deltas: number;
  readonly gate: GateStats;
  readonly phaseAMs: number;
  /** Set when the reply was written whole after all (its speech then holds and finishes like a whole reply). */
  readonly fallback: StreamFallback | null;
  /**
   * Voice: the founder spoke over the reply (the caller cancelled the turn after speech units were sent). The
   * reply stands as far as it was written, without annotations; the unit still held is never sent.
   */
  readonly interrupted: boolean;
  /** Voice: the signed speech units of the reply (finished after validation). */
  readonly speech: SpeechStream | null;
}

/** A model failure while generating, with every billable attempt made so far (already recorded). */
export class GenerationFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly attempts: readonly ModelAttempt[],
  ) {
    super('generation failed', { cause });
    this.name = 'GenerationFailure';
  }
}

/**
 * Face pre-approval for one voice turn (docs/architecture/calls.md §4): admits each unit to the call's live FULL
 * face as it is signed, with the checks `POST /calls/:id/face/say` makes, so the browser hands it to the face at
 * once instead of asking the server first. True when admitted (the unit is then sent with `face: true`, covered by
 * its signature); false leaves the unit to `face/say` as before. Never throws.
 */
export interface FaceApproval {
  approve(unit: { readonly turnId: string; readonly seq: number; readonly text: string }): Promise<boolean>;
  /**
   * The turn was blocked or failed after some of its units were admitted (a streamed reply the whole-reply check
   * then blocked, a stream that broke): nothing more is admitted, and what was admitted that the face has not said
   * is withdrawn, so the face cannot say it later (as `face/say` refuses a blocked or failed turn). Never throws.
   */
  withdraw(): Promise<void>;
}

/** Most a spoken unit may carry (`turn.speech` text). */
const MAX_SPEECH_UNIT_CHARS = 600;

/**
 * The signed `turn.speech` units of one voice turn. Signing failures stop speech for the turn (the reply
 * stays readable) and are logged with ids only. Nothing is sent once `signal` (the caller's) is aborted: the
 * founder spoke over the vEIR or went away, and would never hear it.
 *
 * A reply said whole (the crisis support message, a validated spoken reply) is queued, then finished: each
 * unit is held until the next one is ready, so the last one carries `final: true`; `discard` drops the held
 * unit when the turn is blocked. A streamed reply (`eager`) sends each unit the moment the sentence gate
 * released it, so the founder hears its first sentence while the model is still writing and its last one
 * (usually the question that hands the turn back) without waiting for the annotations and the final
 * validation (docs/runbooks/latency.md). None of its units is marked final (`turn.completed` ends the turn),
 * and nothing is said after it: a closing unit offered to `finish` would come a whole model call after the
 * hand-back, over or after the founder's answer, so it is not said. When the stream is given up and the reply is written whole after all, `sayWhole` makes the stream
 * hold and finish like a reply said whole. Every unit was validated by the sentence gate either way.
 *
 * On a call whose FULL face is live (`face`, resolved once per turn), each unit is offered to the face's
 * pre-approval before it is signed and sent: an admitted unit carries `face: true` (in its signature too).
 */
export class SpeechStream {
  #held: string | null = null;
  #seq = 0;
  #broken = false;
  #eager: boolean;

  constructor(
    private readonly key: Promise<SessionSigningKey>,
    private readonly ids: { readonly sessionId: string; readonly turnId: string; readonly requestId: string },
    private readonly emit: (event: TurnStreamEvent) => Promise<void>,
    private readonly onError: (fields: Record<string, string | number>) => void,
    private readonly signal?: AbortSignal,
    options: {
      readonly eager?: boolean;
      /** The call's FULL face pre-approval for this turn (null: none, resolved lazily at the first unit). */
      readonly face?: Promise<FaceApproval | null> | null;
    } = {},
  ) {
    this.#eager = options.eager === true;
    this.#face = options.face ?? null;
  }

  readonly #face: Promise<FaceApproval | null> | null;

  /** Units sent so far. */
  get sent(): number {
    return this.#seq;
  }

  async queue(text: string): Promise<void> {
    const unit = clampWords(text, Number.MAX_SAFE_INTEGER, MAX_SPEECH_UNIT_CHARS).text;
    if (unit === '' || this.#broken) return;
    if (this.#eager) {
      await this.#send(unit, false);
      return;
    }
    if (this.#held !== null) await this.#send(this.#held, false);
    this.#held = unit;
  }

  /**
   * Ends the turn's speech. Held: `closing`, if any, is said after the reply and the last unit is marked final.
   * Eager (a streamed reply): everything was already said and nothing follows it.
   */
  async finish(closing?: string): Promise<void> {
    if (this.#eager) return;
    if (closing) await this.queue(closing);
    const last = this.#held;
    this.#held = null;
    if (last !== null) await this.#send(last, true);
  }

  discard(): void {
    this.#held = null;
  }

  /**
   * The reply is written whole after all (a stream given up after it began): what is queued from now on is
   * held and finished like a reply said whole, so its last unit is final. Units already said stay said.
   */
  sayWhole(): void {
    this.#held = null;
    this.#eager = false;
  }

  async #send(text: string, final: boolean): Promise<void> {
    if (this.#broken || this.signal?.aborted === true) return;
    let sig: string;
    let face = false;
    try {
      const key = await this.key;
      // Admitted to the call's FULL face here, in order, before the unit leaves the server.
      const approval = this.#face === null ? null : await this.#face.catch(() => null);
      if (approval !== null) {
        // Its cost is on the unit's way out: the approval logs it per unit (`turn.face_approval`, ms).
        face = await approval.approve({ turnId: this.ids.turnId, seq: this.#seq, text }).catch(() => false);
      }
      sig = signSpeechUnit(key, {
        sessionId: this.ids.sessionId,
        turnId: this.ids.turnId,
        seq: this.#seq,
        text,
        ...(face ? { face: true } : {}),
      });
    } catch (err) {
      this.#broken = true;
      this.onError({
        requestId: this.ids.requestId,
        turnId: this.ids.turnId,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return;
    }
    await this.emit({
      event: 'turn.speech',
      turnId: this.ids.turnId,
      seq: this.#seq,
      text,
      sig,
      final,
      ...(face ? { face: true } : {}),
    });
    this.#seq += 1;
  }
}

/**
 * What a generation is billed as: a coaching turn of a venture (`turn`), or an EIR studio test conversation
 * (`test_bench`, no venture). Every model call of the generation is metered once under it.
 */
export interface GenerationMeter {
  readonly purpose: Extract<ModelPurpose, 'turn' | 'test_bench'>;
  readonly ventureId: string | null;
}

export interface GenerateArgs {
  readonly kit: Kit;
  readonly ctx: RequestContext;
  readonly meter: GenerationMeter;
  /** Ids the speech units and logs carry (a test conversation uses its run id for both). */
  readonly sessionId: string;
  readonly turnId: string;
  /** The turn's system prompt (whole-reply path and phase B). */
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  /**
   * Where `system`'s unchanging prefix and the earlier exchanges in `messages` end (Bedrock prompt caching). Every
   * call of the turn sends it; phase A keeps that prefix of `system` byte for byte.
   */
  readonly promptCache?: PromptCacheHint;
  readonly channel: TurnChannel;
  /** The fixed mode, or null in auto mode. */
  readonly mode: CoachMode | null;
  readonly allowedModes: readonly CoachMode[];
  /** Mode the annotations fall back to when phase B fails in auto mode. */
  readonly fallbackMode: CoachMode;
  readonly signal: AbortSignal | undefined;
  /** `performance.now()` when the turn request reached the engine. */
  readonly startedAt: number;
  /** Who the reply may narrate by name (the founder it talks to, the venture's people; LAB-M1b). */
  readonly narration?: NarrationNames;
  /**
   * The conversation's earlier replies (and opener) a reply never says again, or null when it may (the founder asked to
   * hear it again, or sincerely asked who or what the coach is). A whole reply that says one again is written once more
   * with what was already said (`repeat_regenerated`): left out by the validator alone, the sentences around it would
   * lean on a hole. `keepReferrals`: a flagged turn keeps its referral (validators/social.ts `isProtectedLine`);
   * `strictQuestions`: the founder said they do not know, so a question on the same subject counts as asked again
   * (validators/social.ts `stuckOn`); `asked`: the questions of those replies, the ones before the previous reply
   * settled (validators/social.ts `askedBefore`).
   */
  readonly alreadySaid?: {
    readonly text: string;
    readonly keepReferrals: boolean;
    readonly strictQuestions: boolean;
    readonly asked: readonly QuestionTerms[];
  } | null;
}

export interface StreamArgs extends GenerateArgs {
  readonly gate: SentenceGateOptions;
  readonly emit: (event: TurnStreamEvent) => Promise<void>;
  /** Voice turns: the key the speech units are signed with. */
  readonly speechKey: Promise<SessionSigningKey> | null;
  /** A call's FULL face pre-approval for this turn's units (absent or null: none). */
  readonly faceApproval?: Promise<FaceApproval | null> | null;
}

/** Longest the annotations of a streamed answer may take (phase B). */
export const ANNOTATION_BUDGET_MS = 15_000;
/** Bounds on the streamed reply: a typed answer, and the short spoken one of a call. */
const ANSWER_MAX_TOKENS = { text: 1_500, voice: 400 } as const;
/**
 * Voice suite VC-2: phase A said the previous reply again, whole, and the founder heard nothing for 11.8 s while it did,
 * before the continuation began. Once nothing but a lead-in was released and the gate left out this many units as the
 * previous reply again (or one of {@link EARLY_REPEAT_WORDS} words), the continuation starts at once, while phase A
 * waits: a full repeat, that is, at least half of the previous reply said again, with {@link EARLY_REPEAT_WORDS} words
 * of it still to come (a recap of its first sentence or two is no full repeat). Phase A is stopped only once the
 * continuation added something; when it added nothing (it repeated too, or failed), phase A goes on as if never paused,
 * so new advice after the repeats still comes (differential audit, 2026-10-22: stopped for good, the new advice after a
 * recap was thrown away and the founder heard only a hand-back).
 */
export const EARLY_REPEAT_UNITS = 2;
export const EARLY_REPEAT_WORDS = 20;
/**
 * Bound on the annotations (phase B). Production's turns wrote 550–1,900 output tokens for both calls
 * together (docs/runbooks/latency.md §4), so this never cuts a real one; it stops a call that runs away
 * (the gateway's default is 4,096) well before the annotation time budget.
 */
export const ANNOTATION_MAX_TOKENS = 2_000;
const SPOKEN_UNIT_CHARS = 280;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function sum(attempts: readonly ModelAttempt[], pick: (a: ModelAttempt) => number): number {
  return attempts.reduce((acc, a) => acc + pick(a), 0);
}

async function record(a: GenerateArgs, attempts: readonly ModelAttempt[]): Promise<void> {
  await a.kit.recordUsage({ ctx: a.ctx, ventureId: a.meter.ventureId, purpose: a.meter.purpose, attempts });
}

function attemptsOf(err: unknown): readonly ModelAttempt[] {
  return isModelGatewayError(err) ? err.attempts : [];
}

/**
 * Asked again once when a whole reply opens with the model thinking aloud about its prompt instead of talking
 * to the founder (LAB-M1). Server-written, appended to the founder's message.
 */
export const META_NARRATION_RETRY =
  '[Your previous reply described your reasoning, the rules or the founder in the third person instead of talking to the founder. Write only what you say to them, as "you".]';

/**
 * Asked again once when a whole reply says again what this conversation already said (`repeat_regenerated`): the
 * sentences are named so the new reply builds on them instead. Server-written, appended to the founder's message.
 */
export function repeatRetryBrief(removed: readonly string[]): string {
  const quoted = removed
    .slice(0, 4)
    .map((sentence) => `"${sentence.replace(/\s+/g, ' ').slice(0, 200)}"`)
    .join(' ');
  return (
    '[Your previous reply said again what you already said or already answered earlier in this conversation: ' +
    `${quoted}. Write the reply again: keep what is new, leave those out (they still stand, and the founder has them), ` +
    'and build on them with the next thing that helps. If a list or a count of steps lost an item, renumber it.]'
  );
}

/** Whether a whole reply has no reply in it: its answer (or, on a call, its spoken form) opens with narration. */
function opensWithNarration(value: CoachResponse, channel: TurnChannel, names?: NarrationNames): boolean {
  if (cutMetaNarration(value.answer, names).at === 'opening') return true;
  return channel === 'voice' && cutMetaNarration(value.spoken ?? '', names).at === 'opening';
}

/**
 * The whole reply in one structured call (streaming switched off, or a stream that broke after text). A reply
 * that opens with meta-narration is asked for once more (`meta_narration_retried`); the validator holds back a
 * second one.
 */
export async function generateWhole(
  a: GenerateArgs,
  earlier: readonly ModelAttempt[] = [],
): Promise<Generation> {
  const attempts: ModelAttempt[] = [...earlier];
  const notes: string[] = [];
  let latencyMs = 0;
  // What the one retry asks for (null on the first round).
  let retry: string | null = null;
  for (let round = 0; ; round += 1) {
    try {
      const result = await a.kit.deps.gateway.generateStructured({
        purpose: a.meter.purpose,
        system: a.system,
        messages: retry === null ? a.messages : [...a.messages, { role: 'user', content: retry }],
        schemaName: COACH_RESPONSE_SCHEMA_NAME,
        zodSchema: CoachResponse,
        requestId: a.ctx.requestId,
        timeoutMs: a.kit.config.turns.modelTimeoutMs,
        ...(a.promptCache ? { promptCache: a.promptCache } : {}),
        ...(a.signal ? { signal: a.signal } : {}),
      });
      await record(a, result.attempts);
      attempts.push(...result.attempts);
      latencyMs += Math.round(result.latencyMs);
      if (
        round === 0 &&
        opensWithNarration(result.value, a.channel, a.narration) &&
        a.signal?.aborted !== true
      ) {
        notes.push('meta_narration_retried');
        retry = META_NARRATION_RETRY;
        continue;
      }
      if (round === 0 && a.alreadySaid && a.signal?.aborted !== true) {
        const repeated = withoutRepeats(result.value.answer, a.alreadySaid.text, {
          keepReferrals: a.alreadySaid.keepReferrals,
          strictQuestions: a.alreadySaid.strictQuestions,
          asked: a.alreadySaid.asked,
        });
        // A sign-off said again is only left out (the validator does it): never worth writing the reply again for.
        const substance = repeated.removed.filter((sentence) => !signsOff(sentence));
        if (substance.length > 0) {
          notes.push('repeat_regenerated');
          retry = repeatRetryBrief(substance);
          continue;
        }
      }
      return {
        raw: result.value,
        modelId: result.modelId,
        fallbackUsed: result.fallbackUsed,
        attempts,
        latencyMs,
        notes,
        gateBlocked: null,
        stream: null,
      };
    } catch (err) {
      await record(a, attemptsOf(err));
      throw new GenerationFailure(err, [...attempts, ...attemptsOf(err)]);
    }
  }
}

/**
 * Validate-before-show streaming (phase A then phase B; see `turn-prompts.ts`).
 *
 * Phase A streams the reply through the sentence gate: each unit that passes goes out as `turn.delta` (and,
 * on a call, as a signed `turn.speech` unit). The reply extractor reads the stream before the gate: when the
 * model writes the reply as structured output, only its reply field is streamed (the model is stopped once
 * that field ends), and a reply that runs on into the response's other fields ends where they begin. When the
 * gate stops (cross-venture or identity), the model call is cancelled and the turn ends blocked. When the
 * stream fails before any text, the turn fails like a whole reply would (the gateway already tried the
 * fallback model). The reply is written whole instead (the whole-reply path, with its own fallback model)
 * when the stream breaks after text arrived, when it gives nothing presentable, or when it is structured
 * output with no reply field in it; `turn.completed` then replaces whatever was streamed.
 *
 * Phase B then produces the structured fields for exactly the streamed reply; when it fails, the reply stands
 * alone (`annotations_unavailable`). Phase B runs after phase A, not alongside it: claims, grounding coverage,
 * the challenge and the follow-ups must describe the text the founder read. It is started when the reply is complete
 * and returned under way (`Generation.annotations`): the turn completes on the reply, and its fields are added to the
 * stored turn when they arrive (run-turn.ts), so nothing the founder waits on (the terminal event, a call's return to
 * listening, the next message) waits for them. What is said was gated before it was said: the crisis path and the
 * safety screen run before generation, the sentence gate on every unit, and a pre-classified escalation is forced by the
 * validation of the reply itself.
 *
 * On a call, the caller cancelling the turn after speech units were sent is the founder speaking over the
 * vEIR (barge-in, docs/architecture/calls.md §2.6), not a failure: the reply stands as far as it was written,
 * without annotations (`interrupted`), so the turn and what the founder heard of it stay in the conversation.
 * Cancelled before any unit was sent, the turn fails as before.
 */
export async function generateStreamed(a: StreamArgs): Promise<Generation> {
  const { gateway, logger } = a.kit.deps;
  const notes: string[] = [];
  const attempts: ModelAttempt[] = [];
  const voice = a.channel === 'voice';
  const traceText = a.kit.config.turns.traceStreamText;
  // What the gate left out is kept for the continuation request; its text is logged only in the lab.
  const gate = new SentenceGate({
    ...a.gate,
    ...(voice ? { maxUnitChars: SPOKEN_UNIT_CHARS, spokenWordBudget: SPOKEN_MAX_WORDS, spoken: true } : {}),
    keepDropped: true,
    // A reply left with nothing but repeats goes on (or is written anew) below, never as a stock line.
    callerContinues: true,
  });
  const speech =
    voice && a.speechKey
      ? new SpeechStream(
          a.speechKey,
          { sessionId: a.sessionId, turnId: a.turnId, requestId: a.ctx.requestId },
          a.emit,
          (fields) => {
            logger.error('turn.speech_unsigned', fields);
          },
          a.signal,
          // Each validated sentence is spoken as soon as the gate releases it.
          { eager: true, face: a.faceApproval ?? null },
        )
      : null;
  const stop = new AbortController();
  const signal = a.signal ? AbortSignal.any([a.signal, stop.signal]) : stop.signal;
  const timing = { firstDeltaAt: null as number | null, deltas: 0, modelFirstTextAt: null as number | null };
  /**
   * A call's reply as said so far: once its spoken form used the call's word budget, nothing more of it can be
   * heard, so the model is stopped and the reply is what was shown (`full`). Production's spoken replies were
   * the first 50–70 words of written answers about twice as long, which the transcript then showed unsaid.
   */
  const said = { words: 0, shown: '', spoken: '', full: false, cut: false };
  /**
   * The continuation started while phase A was saying the previous reply again (VC-2, {@link repeatedEarly}): what it
   * added (null: not started early), and whether phase A was stopped for it (`stopped`: it added something).
   */
  const early: { went: string | null; stopped: boolean } = { went: null, stopped: false };
  const previousWords = wordCount(a.gate.previousReply ?? '');

  const release = async (result: GateResult): Promise<void> => {
    for (const unit of result.units) {
      // A unit withheld from the preview (text '') is still said on a call.
      if (unit.text !== '') {
        timing.firstDeltaAt ??= performance.now();
        await a.emit({ event: 'turn.delta', turnId: a.turnId, seq: timing.deltas, text: unit.text });
        timing.deltas += 1;
        said.shown += unit.text;
      }
      if (unit.spoken !== '') said.words += unit.spoken.split(/\s+/).filter((w) => w !== '').length;
      if (unit.spoken !== '') said.spoken += ` ${unit.spoken}`;
      if (speech && unit.spoken !== '') await speech.queue(unit.spoken);
    }
    if (result.blocked !== null || result.fallback !== null || result.cut !== null) stop.abort();
    else if (!said.full && (gate.full || gate.spokenFull || (voice && said.words >= SPOKEN_MAX_WORDS))) {
      // All of the reply that can be said was said: a call's spoken budget, or a short reply's (a thanks).
      said.full = true;
      stop.abort();
    }
  };
  const details = (phaseAMs: number, modelFirstTokenMs: number | null): StreamDetails => ({
    firstDeltaMs: timing.firstDeltaAt === null ? null : Math.round(timing.firstDeltaAt - a.startedAt),
    modelFirstTokenMs,
    deltas: timing.deltas,
    gate: gate.stats,
    phaseAMs,
    fallback: null,
    interrupted: false,
    speech,
  });
  const blockedBy = (reason: GateBlockReason, modelId: string, phaseAMs: number): Generation => {
    speech?.discard();
    return {
      raw: { ...emptyAnnotations(a.mode ?? a.fallbackMode), answer: gate.text, spoken: null },
      modelId,
      fallbackUsed: false,
      attempts,
      latencyMs: phaseAMs,
      notes: ['stream_gate_blocked'],
      gateBlocked: reason,
      stream: details(phaseAMs, null),
    };
  };
  /** The caller cancelled after speech units were sent: the founder spoke over the reply (see above). */
  const interruptedBy = (): boolean => a.signal?.aborted === true && (speech?.sent ?? 0) > 0;
  const interruptedAt = (text: string, modelId: string, phaseAMs: number): Generation => {
    speech?.discard();
    logger.info('turn.interrupted', {
      requestId: a.ctx.requestId,
      turnId: a.turnId,
      phase: 'answer',
      units: speech?.sent ?? 0,
    });
    return {
      raw: { ...emptyAnnotations(a.mode ?? a.fallbackMode), answer: text, spoken: text },
      modelId,
      fallbackUsed: false,
      attempts,
      latencyMs: phaseAMs,
      notes: ['interrupted'],
      gateBlocked: null,
      stream: { ...details(phaseAMs, null), interrupted: true },
    };
  };
  /** The reply written whole after all: it is said whole, after whatever the stream already said. */
  const wholeInstead = async (fallback: StreamFallback, phaseAMs: number, code: string | null) => {
    speech?.sayWhole();
    logger.warn('turn.stream_fallback', {
      requestId: a.ctx.requestId,
      turnId: a.turnId,
      reason: fallback,
      deltas: timing.deltas,
      ...(code === null ? {} : { code }),
    });
    const whole = await generateWhole(a, attempts);
    return {
      ...whole,
      latencyMs: whole.latencyMs + phaseAMs,
      notes: [`stream_${fallback}`, ...whole.notes],
      stream: { ...details(phaseAMs, null), fallback },
    } satisfies Generation;
  };

  /**
   * Whether the reply may still go on after the gate left out what repeated the conversation: the founder did not speak
   * over it, it is not a short reply meant to be short (a thanks), and neither was its preview withheld nor a call's
   * spoken budget used up.
   */
  const open = (): boolean =>
    a.signal?.aborted !== true &&
    !said.full &&
    !gate.full &&
    (a.gate.replyBudget ?? null) === null &&
    gate.stats.withheld === 0;
  /**
   * Phase A has released nothing but a lead-in, and the gate left out {@link EARLY_REPEAT_UNITS} units as the previous
   * reply again (or one of {@link EARLY_REPEAT_WORDS} words): a full repeat, half of the previous reply or more, with
   * {@link EARLY_REPEAT_WORDS} words of it still to come. The continuation need not wait for the rest of phase A (VC-2).
   */
  const repeatedEarly = (): boolean => {
    if (!open() || gate.cut !== null || !isOnlyLeadIn(said.shown)) return false;
    const left = gate.trace.dropped.filter((d) => d.reason === 'repeat').map((d) => wordCount(d.text));
    if (left.length < EARLY_REPEAT_UNITS && !left.some((n) => n >= EARLY_REPEAT_WORDS)) return false;
    const repeated = left.reduce((n, w) => n + w, 0);
    return repeated * 2 >= previousWords && previousWords - repeated >= EARLY_REPEAT_WORDS;
  };
  /**
   * Goes on with a reply the gate left at its lead-in (see {@link continuationMessages}): streamed through a gate of its
   * own, shown and said after what was, within what is left of the spoken budget. Returns what it added ('' when
   * nothing passed, or the call failed: the reply then stands as it was shown).
   */
  const goOn = async (soFar: string, leftOut: readonly string[]): Promise<string> => {
    const more = new SentenceGate({
      ...a.gate,
      // Nothing said yet: the reply written anew may greet as the first one could; after a lead-in, never again.
      greeted: soFar === '' ? a.gate.greeted : true,
      // What this reply already said counts as said, as the previous reply does.
      previousReply: [a.gate.previousReply ?? '', soFar].filter((t) => t.trim() !== '').join('\n') || null,
      ...(voice
        ? {
            maxUnitChars: SPOKEN_UNIT_CHARS,
            spokenWordBudget: Math.max(0, SPOKEN_MAX_WORDS - said.words),
            spoken: true,
          }
        : {}),
      keepDropped: true,
      // What it adds is new or nothing: never the stock line for repeats (lab, a call: "Great, Idris. That still stands
      // from a moment ago. Which part do you want to dig into?"). Adding nothing, the reply stands as it was shown. Their
      // news parked again still gets its line ("That's real news. How did it come about?"), as before.
      repeatFallback: false,
    });
    const extractor = new ReplyExtractor();
    const halt = new AbortController();
    const until = a.signal ? AbortSignal.any([a.signal, halt.signal]) : halt.signal;
    let added = '';
    // A sentence this reply already said, word for word, is never said again (short ones are below the repeat check).
    const key = (text: string): string =>
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const saidSentences = new Set(
      soFar
        .split(/(?<=[.!?…])\s+/)
        .map(key)
        .filter((k) => k !== ''),
    );
    const show = async (result: GateResult): Promise<void> => {
      for (const unit of result.units) {
        if (saidSentences.has(key(unit.text === '' ? unit.spoken : unit.text))) continue;
        if (unit.text !== '') {
          // The first added unit is a new sentence of the same reply.
          const text =
            added === '' && said.shown !== '' && !/\s$/.test(said.shown)
              ? ` ${unit.text.trimStart()}`
              : unit.text;
          await a.emit({ event: 'turn.delta', turnId: a.turnId, seq: timing.deltas, text });
          timing.deltas += 1;
          said.shown += text;
          added += text;
        }
        if (unit.spoken !== '') said.words += unit.spoken.split(/\s+/).filter((w) => w !== '').length;
        if (unit.spoken !== '') said.spoken += ` ${unit.spoken}`;
        if (speech && unit.spoken !== '') await speech.queue(unit.spoken);
      }
      if (
        result.blocked !== null ||
        result.fallback !== null ||
        result.cut !== null ||
        more.full ||
        more.spokenFull
      )
        halt.abort();
    };
    try {
      const answer = await gateway.streamText(
        {
          purpose: a.meter.purpose,
          system: answerSystemPrompt(a.system, {
            channel: a.channel,
            mode: a.mode,
            allowedModes: a.allowedModes,
            stableChars: a.promptCache?.systemChars ?? 0,
          }),
          messages: continuationMessages(a.messages, soFar, leftOut),
          // The conversation so far is the same prefix: the continuation reads it back from the cache.
          ...(a.promptCache ? { promptCache: a.promptCache } : {}),
          maxOutputTokens: ANSWER_MAX_TOKENS[a.channel],
          timeoutMs: a.kit.config.turns.modelTimeoutMs,
          requestId: a.ctx.requestId,
          signal: until,
        },
        async (chunk) => {
          if (
            more.blocked !== null ||
            more.fallback !== null ||
            more.cut !== null ||
            more.full ||
            more.spokenFull
          )
            return;
          if (extractor.isDone()) return;
          const text = extractor.push(chunk);
          if (text !== '') await show(more.push(text));
          if (extractor.isDone()) halt.abort();
        },
      );
      attempts.push(...answer.attempts);
      await record(a, answer.attempts);
    } catch (err) {
      const failed = attemptsOf(err);
      attempts.push(...failed);
      await record(a, failed);
      if (!halt.signal.aborted || a.signal?.aborted === true) {
        logger.warn('turn.continuation_failed', {
          requestId: a.ctx.requestId,
          turnId: a.turnId,
          code: isModelGatewayError(err) ? err.code : 'unknown',
        });
        return added;
      }
    }
    if (
      more.blocked === null &&
      more.fallback === null &&
      more.cut === null &&
      !more.full &&
      !more.spokenFull
    ) {
      const rest = extractor.end();
      if (rest !== '') await show(more.push(rest));
      await show(more.end());
    }
    logger.info('turn.continued', {
      requestId: a.ctx.requestId,
      turnId: a.turnId,
      channel: a.channel,
      addedWords: wordCount(added),
      repeatsDropped: more.trace.repeatsDropped,
      agendaDropped: more.trace.agendaDropped,
      ...(traceText ? { addedText: added } : {}),
    });
    return added;
  };

  // Phase A: the reply, streamed through the gate. The reply extractor reads the stream first: it hands on
  // prose as it comes, and the reply field of an answer written as structured output (reply-extract.ts).
  const phaseAStarted = performance.now();
  const reply = new ReplyExtractor();
  let streamed: {
    readonly modelId: string;
    readonly fallbackUsed: boolean;
    readonly firstTokenMs: number | null;
    readonly stopReason: StreamStopReason | null;
  };
  try {
    const answer = await gateway.streamText(
      {
        purpose: a.meter.purpose,
        system: answerSystemPrompt(a.system, {
          channel: a.channel,
          mode: a.mode,
          allowedModes: a.allowedModes,
          stableChars: a.promptCache?.systemChars ?? 0,
        }),
        messages: a.messages,
        ...(a.promptCache ? { promptCache: a.promptCache } : {}),
        maxOutputTokens: ANSWER_MAX_TOKENS[a.channel],
        timeoutMs: a.kit.config.turns.modelTimeoutMs,
        requestId: a.ctx.requestId,
        signal,
      },
      async (chunk) => {
        timing.modelFirstTextAt ??= performance.now();
        if (
          gate.blocked !== null ||
          gate.fallback !== null ||
          gate.cut !== null ||
          reply.isDone() ||
          said.full ||
          early.stopped
        )
          return;
        const text = reply.push(chunk);
        if (text !== '') await release(gate.push(text));
        // The reply is complete and what follows is the response's other fields: stop the model.
        if (reply.isDone()) stop.abort();
        else if (early.went === null && !stop.signal.aborted && repeatedEarly()) {
          // The previous reply again from its start: the continuation starts now, while this stream waits unread. Phase
          // A is stopped once the continuation added something; else it goes on from here as if never paused.
          early.went = await goOn(
            said.shown.trim(),
            gate.trace.dropped.map((d) => d.text),
          );
          if (early.went !== '') {
            early.stopped = true;
            stop.abort();
          }
        }
      },
    );
    attempts.push(...answer.attempts);
    await record(a, answer.attempts);
    streamed = {
      modelId: answer.modelId,
      fallbackUsed: answer.fallbackUsed,
      firstTokenMs: answer.firstTokenMs,
      stopReason: answer.stopReason,
    };
  } catch (err) {
    const failed = attemptsOf(err);
    attempts.push(...failed);
    await record(a, failed);
    const phaseAMs = Math.round(performance.now() - phaseAStarted);
    if (gate.blocked !== null)
      return blockedBy(gate.blocked, attempts.at(-1)?.modelId ?? 'unknown', phaseAMs);
    if (interruptedBy() && gate.text.trim() !== '') {
      // Spoken over during a continuation started while phase A waited: the reply is what was said of it.
      const text = early.went === null ? gate.text : said.shown.trim();
      return interruptedAt(text, attempts.at(-1)?.modelId ?? 'unknown', phaseAMs);
    }
    if (a.signal?.aborted) throw new GenerationFailure(err, attempts);
    if (gate.fallback !== null) return wholeInstead(gate.fallback, phaseAMs, null);
    if ((reply.isDone() || said.full || gate.cut !== null || early.stopped) && stop.signal.aborted) {
      // Stopped here once the reply was complete, all of a call's reply that can be said was said, the gate ended it
      // before the model's narration, or it was saying the previous reply again from its start: the reply stands as the
      // stream gave it (and goes on below).
      said.cut = said.full || gate.cut !== null;
      streamed = {
        modelId: failed.at(-1)?.modelId ?? 'unknown',
        fallbackUsed: failed.length > 1 && failed.at(-1)?.modelId !== failed[0]?.modelId,
        firstTokenMs:
          timing.modelFirstTextAt === null ? null : Math.round(timing.modelFirstTextAt - phaseAStarted),
        stopReason: null,
      };
    } else {
      if (gate.text === '') throw new GenerationFailure(err, attempts);
      return wholeInstead('interrupted', phaseAMs, isModelGatewayError(err) ? err.code : 'unknown');
    }
  }
  // A call's reply cut at its spoken budget ends with what was shown: the start of the next sentence, still
  // held by the gate, is never shown; nor is the rest of a reply stopped for saying the previous one again.
  if (gate.blocked === null && gate.fallback === null && !said.cut && !early.stopped) {
    const rest = reply.end();
    if (rest !== '') await release(gate.push(rest));
    // Ends the gate (nothing more once that last push stopped it).
    await release(gate.end());
  }
  // The gate ended the reply before the model's narration (while streaming, or on its last sentence at the end), or
  // a short reply's budget was used up.
  if (gate.cut !== null || gate.full) said.cut = true;
  const phaseAMs = Math.round(performance.now() - phaseAStarted);
  if (gate.blocked !== null) return blockedBy(gate.blocked, streamed.modelId, phaseAMs);
  if (gate.fallback !== null) return wholeInstead(gate.fallback, phaseAMs, null);
  // Structured output without a reply in it: the reply is written whole after all.
  if (reply.missing) return wholeInstead('structured_output', phaseAMs, null);
  // Nothing presentable (an empty or whitespace reply, or one the Markdown subset removes entirely).
  // Nothing presentable, unless what was left out was the conversation again: that reply is written anew below.
  const repeatedAway = gate.trace.repeatsDropped + gate.trace.agendaDropped > 0;
  if (gate.stats.units + gate.stats.withheld === 0 && !repeatedAway) {
    return wholeInstead('empty', phaseAMs, null);
  }
  // Cut before narration with no reply shown before it (nothing, units withheld from the preview, or a lead-in of a few
  // words such as "Okay, here goes."): the reply is written whole, as the final validation would hold it back.
  if (
    gate.cut === 'meta_narration' &&
    (said.shown.match(/\p{L}[\p{L}'’-]*/gu) ?? []).length < MIN_KEPT_WORDS
  ) {
    return wholeInstead(gate.cut, phaseAMs, null);
  }
  if (streamed.stopReason === 'max_tokens') notes.push('answer_truncated');
  // The reply was taken out of structured output, or cut where the response's other fields began.
  if (reply.shape !== 'prose') notes.push(`stream_structured_${reply.shape ?? 'unknown'}`);
  else if (reply.isDone()) notes.push('stream_fields_cut');
  if (gate.cut !== null) notes.push(`stream_${gate.cut}_cut`);
  else if (gate.full) notes.push('stream_reply_budget_cut');
  else if (said.cut) notes.push('stream_spoken_cut');
  if (early.stopped) notes.push('stream_repeat_stopped');
  // How the streamed reply ended and what the gate left out (2026-10-22 lab: call replies of 19 to 90 streamed tokens
  // were said as "Got it." or a sentence and a question, and nothing recorded why). Counts only, except in the lab.
  const trace = gate.trace;
  // Cut, or continued: the reply is what was shown. Otherwise it is the reply without the units the gate left out as
  // repeats, exactly as it released it: the final validation never judges released text for repeats again
  // (`ValidateCoachResponseOptions.released`), so the stored answer is what was shown and said.
  let replyText =
    said.cut || early.went !== null
      ? said.shown.trim()
      : withoutUnits(
          reply.text,
          gate.trace.dropped.filter((d) => d.reason === 'repeat' || d.reason === 'reask').map((d) => d.text),
        );
  logger.info('turn.phase_a', {
    requestId: a.ctx.requestId,
    turnId: a.turnId,
    channel: a.channel,
    stopReason: streamed.stopReason,
    replyShape: reply.shape ?? null,
    replyDone: reply.isDone(),
    gateCut: gate.cut,
    gateFull: gate.full,
    spokenFull: said.full,
    repeatStopped: early.stopped,
    units: gate.stats.units,
    withheld: gate.stats.withheld,
    repeatsDropped: trace.repeatsDropped,
    reasksDropped: trace.reasksDropped,
    agendaDropped: trace.agendaDropped,
    greetingDropped: trace.greetingDropped,
    replyWords: wordCount(reply.text),
    shownWords: wordCount(said.shown),
    spokenWords: said.words,
    spokenBudget: voice ? SPOKEN_MAX_WORDS : null,
    ...(traceText
      ? { replyText: reply.text, shownText: said.shown, dropped: JSON.stringify(trace.dropped) }
      : {}),
  });
  // The gate left out what repeated the conversation, and what is left is nothing, only the lead-in ("Okay, Idris."),
  // or a sliver of what was written (a sentence of a reply four times as long): the reply goes on once, from what was
  // said, with something new, or is written anew when nothing was said. Never for a short reply that is meant to be
  // short (a thanks), a reply whose preview was withheld, or once the founder spoke over it ({@link open}). Whatever it
  // adds, the reply is what was shown: what the gate left out is never kept, and nothing added leaves it as it was.
  // Once only: a continuation started while phase A waited is the reply's continuation.
  const shownWords = wordCount(said.shown);
  let went = early.went;
  if (
    went === null &&
    open() &&
    repeatedAway &&
    (gate.cut === 'repeat' ||
      isOnlyLeadIn(said.shown) ||
      (shownWords < 20 && shownWords * 4 < wordCount(reply.text)))
  ) {
    went = await goOn(
      said.shown.trim(),
      trace.dropped.map((d) => d.text),
    );
  }
  if (went !== null) {
    replyText = said.shown.trim();
    if (went !== '') notes.push('stream_continued');
  }
  // Still nothing said: the reply is written whole after all.
  if (said.shown.trim() === '' && gate.stats.withheld === 0) return wholeInstead('empty', phaseAMs, null);

  if (a.signal?.aborted === true) {
    // Cancelled while the reply was being written. On a call after units were said, the founder spoke over it: it
    // stands as written, without fields. Otherwise (a typed message cancelled, nothing said) the turn fails, as before.
    if (!interruptedBy()) {
      throw new GenerationFailure(new ModelUnavailableError('aborted', streamed.modelId), attempts);
    }
    return interruptedAt(replyText, streamed.modelId, phaseAMs);
  }
  // Phase B: the structured fields of exactly that reply, started now and never waited for here (see the function's
  // comment): the reply is complete, shown and said.
  const annotations = startAnnotations(a, replyText);
  return {
    raw: {
      ...emptyAnnotations(a.mode ?? a.fallbackMode),
      answer: replyText,
      spoken: voice ? replyText : null,
    },
    modelId: streamed.modelId,
    fallbackUsed: streamed.fallbackUsed,
    attempts,
    latencyMs: phaseAMs,
    notes,
    gateBlocked: null,
    stream: details(phaseAMs, streamed.firstTokenMs),
    annotations,
  };
}

/** What phase B gave: the annotations, or null when it failed (`note` says why), and every billable attempt it made. */
export interface AnnotationsResult {
  readonly value: CoachAnnotations | null;
  readonly attempts: readonly ModelAttempt[];
  /** Model time of the call. */
  readonly latencyMs: number;
  /** `annotations_unavailable` when the call failed (the reply stands alone), else null. */
  readonly note: string | null;
}

/** Phase B under way: its result (never rejects, already metered), and a way to stop it when nothing will read it. */
export interface PendingAnnotations {
  readonly result: Promise<AnnotationsResult>;
  cancel(): void;
}

/**
 * Phase B of a streamed reply (lab run 42238272157 on Haiku: phase B took 5.6 s after a reply whose first text showed at
 * 1.29 s, and the turn's terminal event, a call's return to listening and the founder's next message all waited for it).
 * The caller's signal is not its signal: the reply it describes is complete, so a founder speaking over it, or leaving,
 * does not take its fields away. Bounded by {@link ANNOTATION_BUDGET_MS} and {@link ANNOTATION_MAX_TOKENS}; metered as the
 * turn's own purpose.
 */
function startAnnotations(a: StreamArgs, replyText: string): PendingAnnotations {
  const budget = Math.min(ANNOTATION_BUDGET_MS, a.kit.config.turns.modelTimeoutMs);
  const stop = new AbortController();
  const started = performance.now();
  const result = (async (): Promise<AnnotationsResult> => {
    try {
      const out = await a.kit.deps.gateway.generateStructured({
        purpose: a.meter.purpose,
        system: a.system,
        messages: annotationMessages(a.messages, replyText),
        ...(a.promptCache ? { promptCache: a.promptCache } : {}),
        schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
        zodSchema: CoachAnnotations,
        requestId: a.ctx.requestId,
        maxOutputTokens: ANNOTATION_MAX_TOKENS,
        timeoutMs: budget,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(budget)]),
      });
      await record(a, out.attempts);
      return { value: out.value, attempts: out.attempts, latencyMs: Math.round(out.latencyMs), note: null };
    } catch (err) {
      const failed = attemptsOf(err);
      await record(a, failed).catch(() => undefined);
      if (!stop.signal.aborted) {
        a.kit.deps.logger.warn('turn.annotations_unavailable', {
          requestId: a.ctx.requestId,
          turnId: a.turnId,
          code: isModelGatewayError(err) ? err.code : 'unknown',
        });
      }
      return {
        value: null,
        attempts: failed,
        latencyMs: Math.round(performance.now() - started),
        note: 'annotations_unavailable',
      };
    }
  })();
  return {
    result,
    cancel: () => {
      stop.abort();
    },
  };
}

/**
 * Token and cost totals of a generation, for the turn record. Of the input tokens: those read from and written to
 * Bedrock's prompt cache (0 when no call reported any); the cost already prices them at the model's cache rates.
 */
export function generationTotals(g: Generation): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  costUsd: number;
} {
  return {
    inputTokens: sum(g.attempts, (a) => a.usage.inputTokens),
    outputTokens: sum(g.attempts, (a) => a.usage.outputTokens),
    cacheReadInputTokens: sum(g.attempts, (a) => a.usage.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens: sum(g.attempts, (a) => a.usage.cacheWriteInputTokens ?? 0),
    costUsd: sum(g.attempts, (a) => a.costUsd),
  };
}
