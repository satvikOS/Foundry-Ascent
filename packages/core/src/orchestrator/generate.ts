import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  COACH_RESPONSE_SCHEMA_NAME,
  CoachAnnotations,
  INJECTION_DECLINE,
  MIN_KEPT_WORDS,
  SPOKEN_MAX_WORDS,
  SentenceGate,
  clampWords,
  cutMetaNarration,
  endsWithHandBack,
  isOnlyLeadIn,
  isModelGatewayError,
  type ChatMessage,
  type GateBlockReason,
  type GateResult,
  type GateStats,
  type ModelAttempt,
  type ModelPurpose,
  type NarrationNames,
  type PromptCacheHint,
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
  readonly phaseBMs: number;
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
    options: { readonly eager?: boolean } = {},
  ) {
    this.#eager = options.eager === true;
  }

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
    try {
      sig = signSpeechUnit(await this.key, {
        sessionId: this.ids.sessionId,
        turnId: this.ids.turnId,
        seq: this.#seq,
        text,
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
    await this.emit({ event: 'turn.speech', turnId: this.ids.turnId, seq: this.#seq, text, sig, final });
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
   * A call's turn: said right after a streamed reply that ends on a statement (`spokenHandBackFor`), so the founder
   * knows it is their turn without waiting for the annotations; null for none.
   */
  readonly handBack?: string | null;
  /**
   * A short hand-back of this turn (`spokenHandBackFor`, either channel; on a call the same line as `handBack`): the
   * whole reply when the model said nothing new twice, phase A and its continuation (review, 2026-10-22: a third call
   * wrote the reply whole and the validator said the stock line instead). Null: none fits (a social turn, every one
   * heard).
   */
  readonly turnBack?: string | null;
  /**
   * The deterministic classifier flagged the founder's message (prompt injection, a cross-venture request, a crisis).
   * A reply the sentence gate left with nothing new is then never continued or written anew: the gate's own short line
   * stands (evals MX-0004: a refusal that repeated the last reply was left out, and the continuation's "answer their
   * message with something new" made the model carry out the injected instruction).
   */
  readonly flagged?: boolean;
}

export interface StreamArgs extends GenerateArgs {
  readonly gate: SentenceGateOptions;
  readonly emit: (event: TurnStreamEvent) => Promise<void>;
  /** Voice turns: the key the speech units are signed with. */
  readonly speechKey: Promise<SessionSigningKey> | null;
}

/** Longest the annotations of a streamed answer may take (phase B). */
export const ANNOTATION_BUDGET_MS = 15_000;
/** Bounds on the streamed reply: a typed answer, and the short spoken one of a call. */
const ANSWER_MAX_TOKENS = { text: 1_500, voice: 400 } as const;
/**
 * A reply that has released nothing (or only its lead-in) once the gate left out this many units as the conversation
 * again, or one unit this long, can only go on: the model is stopped then and the continuation starts at once (voice
 * suite VC-2: phase A said the previous reply again whole, and the founder heard nothing for 11.8 s while it did).
 */
export const EARLY_REPEAT_UNITS = 2;
export const EARLY_REPEAT_WORDS = 20;
/** Validator note of a turn whose reply carried out an injected instruction and was replaced by the decline. */
export const INJECTION_ECHO_NOTE = 'injection_echo_declined';
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
  for (let round = 0; ; round += 1) {
    try {
      const result = await a.kit.deps.gateway.generateStructured({
        purpose: a.meter.purpose,
        system: a.system,
        messages: round === 0 ? a.messages : [...a.messages, { role: 'user', content: META_NARRATION_RETRY }],
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
        continue;
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
 * the challenge and the follow-ups must describe the text the founder read.
 *
 * On a call, the caller cancelling the turn after speech units were sent is the founder speaking over the
 * vEIR (barge-in, docs/architecture/calls.md §2.6), not a failure: the reply stands as far as it was written
 * (phase A) or whole (phase B), without annotations (`interrupted`), so the turn and what the founder heard of
 * it stay in the conversation. Cancelled before any unit was sent, the turn fails as before.
 */
export async function generateStreamed(a: StreamArgs): Promise<Generation> {
  const { gateway, logger } = a.kit.deps;
  const notes: string[] = [];
  const attempts: ModelAttempt[] = [];
  const voice = a.channel === 'voice';
  // A call's reply leaves room for its hand-back within the spoken budget (it is said after the reply).
  const spokenBudget = SPOKEN_MAX_WORDS - (voice && a.handBack ? a.handBack.split(/\s+/).length : 0);
  const traceText = a.kit.config.turns.traceStreamText;
  const flagged = a.flagged === true;
  // What the gate left out is kept for the continuation request; its text is logged only in the lab.
  const gate = new SentenceGate({
    ...a.gate,
    ...(voice ? { maxUnitChars: SPOKEN_UNIT_CHARS, spokenWordBudget: spokenBudget, spoken: true } : {}),
    keepDropped: true,
    // A reply left with nothing but repeats goes on (or is written anew) below, never as a stock line. On a flagged
    // turn it never goes on, and the gate's short line stands.
    callerContinues: !flagged,
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
          { eager: true },
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
  /** Phase A was stopped once what the gate left out showed the reply could only go on (VC-2, {@link repeatedEarly}). */
  const early = { repeat: false };

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
    else if (!said.full && (gate.full || (voice && said.words >= spokenBudget))) {
      // All of the reply that can be said was said: a call's spoken budget, or a short reply's (a thanks).
      said.full = true;
      stop.abort();
    }
  };
  const details = (phaseAMs: number, phaseBMs: number, modelFirstTokenMs: number | null): StreamDetails => ({
    firstDeltaMs: timing.firstDeltaAt === null ? null : Math.round(timing.firstDeltaAt - a.startedAt),
    modelFirstTokenMs,
    deltas: timing.deltas,
    gate: gate.stats,
    phaseAMs,
    phaseBMs,
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
      stream: details(phaseAMs, 0, null),
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
      stream: { ...details(phaseAMs, 0, null), interrupted: true },
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
      stream: { ...details(phaseAMs, 0, null), fallback },
    } satisfies Generation;
  };

  /**
   * Whether the reply may go on after the gate left out what repeated the conversation: never on a flagged turn, once
   * the founder spoke over it, for a short reply that is meant to be short (a thanks), or once its preview was
   * withheld or a call's spoken budget used up.
   */
  const mayContinue = (): boolean =>
    !flagged &&
    a.signal?.aborted !== true &&
    !said.full &&
    !gate.full &&
    (a.gate.replyBudget ?? null) === null &&
    gate.stats.withheld === 0;
  /**
   * Nothing (or only the lead-in) was released while the gate left out {@link EARLY_REPEAT_UNITS} units as the
   * conversation again, or one of {@link EARLY_REPEAT_WORDS} words: the rest of phase A is not waited for.
   */
  const repeatedEarly = (): boolean => {
    if (!mayContinue() || gate.cut !== null) return false;
    const left = gate.trace.dropped.filter((d) => d.reason !== 'greeting');
    if (left.length < EARLY_REPEAT_UNITS && !left.some((d) => wordCount(d.text) >= EARLY_REPEAT_WORDS)) {
      return false;
    }
    return isOnlyLeadIn(said.shown);
  };
  /**
   * The reply carried out an injected instruction (the gate's `injection_echo` cut): it becomes the fixed decline,
   * shown and said after whatever was released before it, with no annotations (nothing of the model's is kept).
   */
  const declined = async (
    modelId: string,
    fallbackUsed: boolean,
    phaseAMs: number,
    firstTokenMs: number | null,
  ): Promise<Generation> => {
    const text = `${said.shown !== '' && !/\s$/.test(said.shown) ? ' ' : ''}${INJECTION_DECLINE}`;
    timing.firstDeltaAt ??= performance.now();
    await a.emit({ event: 'turn.delta', turnId: a.turnId, seq: timing.deltas, text });
    timing.deltas += 1;
    said.shown += text;
    if (speech !== null) await speech.queue(INJECTION_DECLINE);
    logger.warn('turn.injection_echo', {
      requestId: a.ctx.requestId,
      turnId: a.turnId,
      channel: a.channel,
      units: gate.stats.units,
    });
    return {
      raw: {
        ...emptyAnnotations(a.mode ?? a.fallbackMode),
        answer: INJECTION_DECLINE,
        spoken: voice ? INJECTION_DECLINE : null,
      },
      modelId,
      fallbackUsed,
      attempts,
      latencyMs: phaseAMs,
      notes: [...notes, INJECTION_ECHO_NOTE],
      gateBlocked: null,
      stream: details(phaseAMs, 0, firstTokenMs),
    };
  };

  /**
   * Goes on with a reply the gate left at its lead-in (see {@link continuationMessages}): streamed through a gate of its
   * own, shown and said after what was, within what is left of the spoken budget. Returns what it added ('' when
   * nothing passed, or the call failed: the reply then stands as it was), and whether the call failed.
   */
  const goOn = async (
    soFar: string,
    leftOut: readonly string[],
  ): Promise<{ readonly added: string; readonly failed: boolean }> => {
    const more = new SentenceGate({
      ...a.gate,
      // Nothing said yet: the reply written anew may greet as the first one could; after a lead-in, never again.
      greeted: soFar === '' ? a.gate.greeted : true,
      // What this reply already said counts as said, as the previous reply does.
      previousReply: [a.gate.previousReply ?? '', soFar].filter((t) => t.trim() !== '').join('\n') || null,
      ...(voice
        ? {
            maxUnitChars: SPOKEN_UNIT_CHARS,
            spokenWordBudget: Math.max(0, spokenBudget - said.words),
            spoken: true,
          }
        : {}),
      keepDropped: true,
      // What it adds is new or nothing: never the stock line (lab, a call: "Great, Idris. That still stands from a
      // moment ago. Which part do you want to dig into?"). Adding nothing, the reply stands as it was.
      callerContinues: true,
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
      if (result.blocked !== null || result.fallback !== null || result.cut !== null || more.full)
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
          if (more.blocked !== null || more.fallback !== null || more.cut !== null || more.full) return;
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
        return { added, failed: true };
      }
    }
    if (more.blocked === null && more.fallback === null && more.cut === null && !more.full) {
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
    return { added, failed: false };
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
          early.repeat
        )
          return;
        const text = reply.push(chunk);
        if (text !== '') await release(gate.push(text));
        // The reply is complete and what follows is the response's other fields: stop the model.
        if (reply.isDone()) stop.abort();
        else if (!stop.signal.aborted && repeatedEarly()) {
          // The conversation again from its start: the continuation starts now (below), not once this reply ends.
          early.repeat = true;
          stop.abort();
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
      return interruptedAt(gate.text, attempts.at(-1)?.modelId ?? 'unknown', phaseAMs);
    }
    if (a.signal?.aborted) throw new GenerationFailure(err, attempts);
    if (gate.fallback !== null) return wholeInstead(gate.fallback, phaseAMs, null);
    if ((reply.isDone() || said.full || gate.cut !== null || early.repeat) && stop.signal.aborted) {
      // Stopped here once the reply was complete, all of a call's reply that can be said was said, the gate ended it
      // before the model's narration, or the reply said the conversation again from its start: the reply stands as
      // the stream gave it (and goes on below).
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
  // held by the gate, is never shown; nor is that of a reply stopped for repeating the conversation.
  if (gate.blocked === null && gate.fallback === null && !said.cut && !early.repeat) {
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
  if (gate.cut === 'injection_echo') {
    return declined(streamed.modelId, streamed.fallbackUsed, phaseAMs, streamed.firstTokenMs);
  }
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
  if (gate.cut !== null && (said.shown.match(/\p{L}[\p{L}'’-]*/gu) ?? []).length < MIN_KEPT_WORDS) {
    return wholeInstead(gate.cut, phaseAMs, null);
  }
  if (streamed.stopReason === 'max_tokens') notes.push('answer_truncated');
  // The reply was taken out of structured output, or cut where the response's other fields began.
  if (reply.shape !== 'prose') notes.push(`stream_structured_${reply.shape ?? 'unknown'}`);
  else if (reply.isDone()) notes.push('stream_fields_cut');
  if (gate.cut !== null) notes.push(`stream_${gate.cut}_cut`);
  else if (gate.full) notes.push('stream_reply_budget_cut');
  else if (said.cut) notes.push('stream_spoken_cut');
  if (early.repeat) notes.push('stream_repeat_stopped');
  let replyText = said.cut || early.repeat ? said.shown.trim() : reply.text;
  // How the streamed reply ended and what the gate left out (2026-10-22 lab: call replies of 19 to 90 streamed tokens
  // were said as "Got it." or a sentence and a question, and nothing recorded why). Counts only, except in the lab.
  const trace = gate.trace;
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
    repeatStopped: early.repeat,
    units: gate.stats.units,
    withheld: gate.stats.withheld,
    repeatsDropped: trace.repeatsDropped,
    reasksDropped: trace.reasksDropped,
    agendaDropped: trace.agendaDropped,
    greetingDropped: trace.greetingDropped,
    replyWords: wordCount(reply.text),
    shownWords: wordCount(said.shown),
    spokenWords: said.words,
    spokenBudget: voice ? spokenBudget : null,
    ...(traceText
      ? { replyText: reply.text, shownText: said.shown, dropped: JSON.stringify(trace.dropped) }
      : {}),
  });
  // The gate left out what repeated the conversation, and what is left is nothing, only the lead-in ("Okay, Idris."),
  // or a sliver of what was written (a sentence of a reply four times as long): the reply goes on once, from what was
  // said, with something new, or is written anew when nothing was said. Never on a flagged turn, for a short reply
  // that is meant to be short (a thanks), a reply whose preview was withheld, or once the founder spoke over it
  // ({@link mayContinue}). Whatever it adds, the reply is what was shown: what the gate left out is never kept.
  const shownWords = wordCount(said.shown);
  /** The continuation was asked to write the reply anew and wrote nothing new either (it did not fail). */
  let nothingNew = false;
  if (
    mayContinue() &&
    repeatedAway &&
    (early.repeat || isOnlyLeadIn(said.shown) || (shownWords < 20 && shownWords * 4 < wordCount(reply.text)))
  ) {
    const anew = said.shown.trim() === '';
    const went = await goOn(
      said.shown.trim(),
      trace.dropped.map((d) => d.text),
    );
    replyText = said.shown.trim();
    if (went.added !== '') notes.push('stream_continued');
    nothingNew = anew && !went.failed && went.added === '';
  }
  // Asked twice, the model said only what the conversation already said: the reply is the turn's hand-back, shown and
  // said now. Never the stock line, and no third call: a reply written whole would say the same again and the
  // validator would put the stock line in its place, a model call later (review, 2026-10-22). Nothing of the model's
  // is in it, so it has no annotations either.
  const turnBack = a.turnBack ?? null;
  if (nothingNew && said.shown.trim() === '' && turnBack !== null && a.signal?.aborted !== true) {
    timing.firstDeltaAt ??= performance.now();
    await a.emit({ event: 'turn.delta', turnId: a.turnId, seq: timing.deltas, text: turnBack });
    timing.deltas += 1;
    said.shown = turnBack;
    if (speech !== null) await speech.queue(turnBack);
    notes.push('stream_nothing_new');
    return {
      raw: {
        ...emptyAnnotations(a.mode ?? a.fallbackMode),
        answer: turnBack,
        spoken: voice ? turnBack : null,
      },
      modelId: streamed.modelId,
      fallbackUsed: streamed.fallbackUsed,
      attempts,
      latencyMs: Math.round(performance.now() - phaseAStarted),
      notes,
      gateBlocked: null,
      stream: details(phaseAMs, 0, streamed.firstTokenMs),
    };
  }
  // Still nothing said: the reply is written whole after all.
  if (said.shown.trim() === '' && gate.stats.withheld === 0) return wholeInstead('empty', phaseAMs, null);
  // A call's reply that ended on a statement hands the turn back now, not after the annotations.
  const handBack = voice ? (a.handBack ?? null) : null;
  if (
    handBack !== null &&
    speech !== null &&
    a.signal?.aborted !== true &&
    !endsWithHandBack(said.spoken) &&
    !endsWithHandBack(replyText) &&
    said.words + handBack.split(/\s+/).length <= SPOKEN_MAX_WORDS
  ) {
    // Shown and said, like any unit of the reply (the transcript is what was said).
    await a.emit({ event: 'turn.delta', turnId: a.turnId, seq: timing.deltas, text: ` ${handBack}` });
    timing.deltas += 1;
    await speech.queue(handBack);
    replyText = `${replyText.trimEnd()} ${handBack}`;
    notes.push('stream_hand_back');
  }

  // Phase B: the structured fields of exactly that reply.
  const phaseBStarted = performance.now();
  const budget = Math.min(ANNOTATION_BUDGET_MS, a.kit.config.turns.modelTimeoutMs);
  const timeout = AbortSignal.timeout(budget);
  let annotations: CoachAnnotations;
  let interrupted = false;
  try {
    const result = await gateway.generateStructured({
      purpose: a.meter.purpose,
      system: a.system,
      messages: annotationMessages(a.messages, replyText),
      ...(a.promptCache ? { promptCache: a.promptCache } : {}),
      schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
      zodSchema: CoachAnnotations,
      requestId: a.ctx.requestId,
      maxOutputTokens: ANNOTATION_MAX_TOKENS,
      timeoutMs: budget,
      signal: a.signal ? AbortSignal.any([a.signal, timeout]) : timeout,
    });
    attempts.push(...result.attempts);
    await record(a, result.attempts);
    annotations = result.value;
  } catch (err) {
    attempts.push(...attemptsOf(err));
    await record(a, attemptsOf(err));
    if (interruptedBy()) {
      // Spoken over once the reply was written: it stands whole, without annotations.
      interrupted = true;
      speech?.discard();
      logger.info('turn.interrupted', {
        requestId: a.ctx.requestId,
        turnId: a.turnId,
        phase: 'annotations',
        units: speech?.sent ?? 0,
      });
      notes.push('interrupted');
    } else if (a.signal?.aborted) {
      throw new GenerationFailure(err, attempts);
    } else {
      logger.warn('turn.annotations_unavailable', {
        requestId: a.ctx.requestId,
        turnId: a.turnId,
        code: isModelGatewayError(err) ? err.code : 'unknown',
      });
      notes.push('annotations_unavailable');
    }
    annotations = emptyAnnotations(a.mode ?? a.fallbackMode);
  }
  const phaseBMs = Math.round(performance.now() - phaseBStarted);

  return {
    raw: { ...annotations, answer: replyText, spoken: voice ? replyText : null },
    modelId: streamed.modelId,
    fallbackUsed: streamed.fallbackUsed,
    attempts,
    latencyMs: phaseAMs + phaseBMs,
    notes,
    gateBlocked: null,
    stream: { ...details(phaseAMs, phaseBMs, streamed.firstTokenMs), interrupted },
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
