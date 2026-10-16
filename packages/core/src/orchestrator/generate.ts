import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  COACH_RESPONSE_SCHEMA_NAME,
  CoachAnnotations,
  SPOKEN_MAX_WORDS,
  SentenceGate,
  clampWords,
  isModelGatewayError,
  type ChatMessage,
  type GateBlockReason,
  type GateResult,
  type GateStats,
  type ModelAttempt,
  type ModelPurpose,
  type SentenceGateOptions,
} from '@foundry/ai';
import { CoachResponse, type CoachMode, type TurnChannel, type TurnStreamEvent } from '@foundry/contracts';

import { type SessionSigningKey } from '../auth/session-token.js';
import { type RequestContext } from '../context.js';
import { type Kit } from '../internal/kit.js';
import { signSpeechUnit } from './speech-units.js';
import { annotationMessages, answerSystemPrompt, emptyAnnotations } from './turn-prompts.js';

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
 * (`interrupted`), produced nothing presentable (`empty`), or opened like structured output instead of prose
 * (`structured_output`). Units already sent are superseded by `turn.completed`.
 */
export type StreamFallback = 'interrupted' | 'empty' | 'structured_output';

export interface StreamDetails {
  /** Milliseconds from the start of the turn request to the first `turn.delta`; null when none was sent. */
  readonly firstDeltaMs: number | null;
  /** The model's own time to first text (gateway measure). */
  readonly modelFirstTokenMs: number | null;
  readonly deltas: number;
  readonly gate: GateStats;
  readonly phaseAMs: number;
  readonly phaseBMs: number;
  /** Set when the reply was written whole after all (any speech unit still held was dropped). */
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
 * The signed `turn.speech` units of one voice turn. Each unit is held until the next one is ready, so the
 * last unit can carry `final: true`; `finish` sends it (after an optional closing unit such as the spoken
 * narrowing caveat), `discard` drops it when the turn is blocked. Signing failures stop speech for the turn
 * (the reply stays readable) and are logged with ids only. Nothing is sent once `signal` (the caller's) is
 * aborted: the founder spoke over the vEIR or went away, and would never hear it.
 */
export class SpeechStream {
  #held: string | null = null;
  #seq = 0;
  #broken = false;

  constructor(
    private readonly key: Promise<SessionSigningKey>,
    private readonly ids: { readonly sessionId: string; readonly turnId: string; readonly requestId: string },
    private readonly emit: (event: TurnStreamEvent) => Promise<void>,
    private readonly onError: (fields: Record<string, string | number>) => void,
    private readonly signal?: AbortSignal,
  ) {}

  /** Units sent so far. */
  get sent(): number {
    return this.#seq;
  }

  async queue(text: string): Promise<void> {
    const unit = clampWords(text, Number.MAX_SAFE_INTEGER, MAX_SPEECH_UNIT_CHARS).text;
    if (unit === '' || this.#broken) return;
    if (this.#held !== null) await this.#send(this.#held, false);
    this.#held = unit;
  }

  async finish(closing?: string): Promise<void> {
    if (closing) await this.queue(closing);
    const last = this.#held;
    this.#held = null;
    if (last !== null) await this.#send(last, true);
  }

  discard(): void {
    this.#held = null;
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
  readonly channel: TurnChannel;
  /** The fixed mode, or null in auto mode. */
  readonly mode: CoachMode | null;
  readonly allowedModes: readonly CoachMode[];
  /** Mode the annotations fall back to when phase B fails in auto mode. */
  readonly fallbackMode: CoachMode;
  readonly signal: AbortSignal | undefined;
  /** `performance.now()` when the turn request reached the engine. */
  readonly startedAt: number;
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
const SPOKEN_UNIT_CHARS = 280;

function sum(attempts: readonly ModelAttempt[], pick: (a: ModelAttempt) => number): number {
  return attempts.reduce((acc, a) => acc + pick(a), 0);
}

async function record(a: GenerateArgs, attempts: readonly ModelAttempt[]): Promise<void> {
  await a.kit.recordUsage({ ctx: a.ctx, ventureId: a.meter.ventureId, purpose: a.meter.purpose, attempts });
}

function attemptsOf(err: unknown): readonly ModelAttempt[] {
  return isModelGatewayError(err) ? err.attempts : [];
}

/** The whole reply in one structured call (streaming switched off, or a stream that broke after text). */
export async function generateWhole(
  a: GenerateArgs,
  earlier: readonly ModelAttempt[] = [],
): Promise<Generation> {
  try {
    const result = await a.kit.deps.gateway.generateStructured({
      purpose: a.meter.purpose,
      system: a.system,
      messages: a.messages,
      schemaName: COACH_RESPONSE_SCHEMA_NAME,
      zodSchema: CoachResponse,
      requestId: a.ctx.requestId,
      timeoutMs: a.kit.config.turns.modelTimeoutMs,
      ...(a.signal ? { signal: a.signal } : {}),
    });
    await record(a, result.attempts);
    return {
      raw: result.value,
      modelId: result.modelId,
      fallbackUsed: result.fallbackUsed,
      attempts: [...earlier, ...result.attempts],
      latencyMs: Math.round(result.latencyMs),
      notes: [],
      gateBlocked: null,
      stream: null,
    };
  } catch (err) {
    await record(a, attemptsOf(err));
    throw new GenerationFailure(err, [...earlier, ...attemptsOf(err)]);
  }
}

/**
 * Validate-before-show streaming (phase A then phase B; see `turn-prompts.ts`).
 *
 * Phase A streams the reply through the sentence gate: each unit that passes goes out as `turn.delta` (and,
 * on a call, as a signed `turn.speech` unit). When the gate stops (cross-venture or identity), the model call
 * is cancelled and the turn ends blocked. When the stream fails before any text, the turn fails like a whole
 * reply would (the gateway already tried the fallback model). The reply is written whole instead (the
 * whole-reply path, with its own fallback model) when the stream breaks after text arrived, when it gives
 * nothing presentable, or when it opens like structured output instead of prose; `turn.completed` then
 * replaces whatever was streamed.
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
  const gate = new SentenceGate({
    ...a.gate,
    ...(voice ? { maxUnitChars: SPOKEN_UNIT_CHARS, spokenWordBudget: SPOKEN_MAX_WORDS, spoken: true } : {}),
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
        )
      : null;
  const stop = new AbortController();
  const signal = a.signal ? AbortSignal.any([a.signal, stop.signal]) : stop.signal;
  const timing = { firstDeltaAt: null as number | null, deltas: 0 };

  const release = async (result: GateResult): Promise<void> => {
    for (const unit of result.units) {
      // A unit withheld from the preview (text '') is still said on a call.
      if (unit.text !== '') {
        timing.firstDeltaAt ??= performance.now();
        await a.emit({ event: 'turn.delta', turnId: a.turnId, seq: timing.deltas, text: unit.text });
        timing.deltas += 1;
      }
      if (speech && unit.spoken !== '') await speech.queue(unit.spoken);
    }
    if (result.blocked !== null || result.fallback !== null) stop.abort();
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
  /** The reply written whole after all; a speech unit still held from the stream is dropped. */
  const wholeInstead = async (fallback: StreamFallback, phaseAMs: number, code: string | null) => {
    speech?.discard();
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
      notes: [`stream_${fallback}`],
      stream: { ...details(phaseAMs, 0, null), fallback },
    } satisfies Generation;
  };

  // Phase A: the reply, streamed through the gate.
  const phaseAStarted = performance.now();
  let answer: Awaited<ReturnType<typeof gateway.streamText>>;
  try {
    answer = await gateway.streamText(
      {
        purpose: a.meter.purpose,
        system: answerSystemPrompt(a.system, {
          channel: a.channel,
          mode: a.mode,
          allowedModes: a.allowedModes,
        }),
        messages: a.messages,
        maxOutputTokens: ANSWER_MAX_TOKENS[a.channel],
        timeoutMs: a.kit.config.turns.modelTimeoutMs,
        requestId: a.ctx.requestId,
        signal,
      },
      async (chunk) => {
        if (gate.blocked === null && gate.fallback === null) await release(gate.push(chunk));
      },
    );
  } catch (err) {
    attempts.push(...attemptsOf(err));
    await record(a, attemptsOf(err));
    const phaseAMs = Math.round(performance.now() - phaseAStarted);
    if (gate.blocked !== null)
      return blockedBy(gate.blocked, attempts.at(-1)?.modelId ?? 'unknown', phaseAMs);
    if (interruptedBy() && gate.text.trim() !== '') {
      return interruptedAt(gate.text, attempts.at(-1)?.modelId ?? 'unknown', phaseAMs);
    }
    if (a.signal?.aborted) throw new GenerationFailure(err, attempts);
    if (gate.fallback !== null) return wholeInstead(gate.fallback, phaseAMs, null);
    if (gate.text === '') throw new GenerationFailure(err, attempts);
    return wholeInstead('interrupted', phaseAMs, isModelGatewayError(err) ? err.code : 'unknown');
  }
  attempts.push(...answer.attempts);
  await record(a, answer.attempts);
  if (gate.blocked === null && gate.fallback === null) await release(gate.end());
  const phaseAMs = Math.round(performance.now() - phaseAStarted);
  if (gate.blocked !== null) return blockedBy(gate.blocked, answer.modelId, phaseAMs);
  if (gate.fallback !== null) return wholeInstead(gate.fallback, phaseAMs, null);
  // Nothing presentable (an empty or whitespace reply, or one the Markdown subset removes entirely).
  if (gate.stats.units + gate.stats.withheld === 0) return wholeInstead('empty', phaseAMs, null);
  if (answer.stopReason === 'max_tokens') notes.push('answer_truncated');

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
      messages: annotationMessages(a.messages, answer.text),
      schemaName: COACH_ANNOTATIONS_SCHEMA_NAME,
      zodSchema: CoachAnnotations,
      requestId: a.ctx.requestId,
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
    raw: { ...annotations, answer: answer.text, spoken: voice ? answer.text : null },
    modelId: answer.modelId,
    fallbackUsed: answer.fallbackUsed,
    attempts,
    latencyMs: phaseAMs + phaseBMs,
    notes,
    gateBlocked: null,
    stream: { ...details(phaseAMs, phaseBMs, answer.firstTokenMs), interrupted },
  };
}

/** Token and cost totals of a generation, for the turn record. */
export function generationTotals(g: Generation): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  return {
    inputTokens: sum(g.attempts, (a) => a.usage.inputTokens),
    outputTokens: sum(g.attempts, (a) => a.usage.outputTokens),
    costUsd: sum(g.attempts, (a) => a.costUsd),
  };
}
