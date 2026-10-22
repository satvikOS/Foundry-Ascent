import { type TurnStreamEvent } from '@foundry/contracts';

import { type LogFields } from '../logging.js';
import { ms, type RequestMetrics } from '../runtime/request-metrics.js';

/**
 * The stages of one turn request, read from the events the turn engine emits and the request's metrics
 * (docs/runbooks/latency.md). Times are milliseconds since the request reached the API; `…Ms` fields that
 * name a stage are its duration. Identifiers and numbers only: no text of the turn is read.
 *
 *   request ─ auth ─ preflight … admission ─ accepted ─ retrieval (embedding ∥ queries) ─ prompt ─ model
 *   first token ─ first validated sentence (turn.delta) / first spoken unit (turn.speech) ─ validating ─ end
 */
export class TurnTimeline {
  #accepted: number | null = null;
  #admissionMs: number | null = null;
  #retrievalStart: number | null = null;
  #retrievalDone: number | null = null;
  #reasoning: number | null = null;
  #validating: number | null = null;
  #firstDelta: number | null = null;
  #firstSpeech: number | null = null;
  #end: number | null = null;
  #voice = false;

  constructor(private readonly metrics: RequestMetrics) {}

  /** Records the arrival of `event` (call it as each event is emitted). */
  observe(event: TurnStreamEvent, now: number = performance.now()): void {
    const at = this.metrics.elapsed(now);
    switch (event.event) {
      case 'turn.accepted':
        this.#accepted ??= at;
        // The admission transaction (checks + the pending turn) is the last one before acceptance.
        this.#admissionMs ??= this.metrics.lastTransaction?.spanMs ?? null;
        break;
      case 'turn.status':
        if (event.phase === 'retrieving') {
          if (event.evidenceCount === null) this.#retrievalStart ??= at;
          else this.#retrievalDone ??= at;
        } else if (event.phase === 'reasoning') this.#reasoning ??= at;
        else if (event.phase === 'validating') this.#validating ??= at;
        break;
      case 'turn.delta':
        this.#firstDelta ??= at;
        break;
      case 'turn.speech':
        this.#voice = true;
        this.#firstSpeech ??= at;
        break;
      case 'turn.completed':
      case 'turn.blocked':
      case 'turn.error':
        this.#end ??= at;
        break;
    }
  }

  /** The `turn.timing` log fields. */
  fields(): LogFields {
    const m = this.metrics;
    const span = (from: number | null, to: number | null): number | null =>
      from === null || to === null ? null : ms(to - from);
    const modelStart = m.stream.startedAt;
    return {
      voice: this.#voice,
      authMs: ms(m.authMs),
      acceptedMs: ms(this.#accepted),
      admissionMs: ms(this.#admissionMs),
      retrievalMs: span(this.#retrievalStart, this.#retrievalDone),
      embedMs: m.embed.calls === 0 ? null : ms(m.embed.ms),
      embedCalls: m.embed.calls,
      promptMs: span(this.#retrievalDone, modelStart ?? this.#reasoning),
      modelStartMs: ms(modelStart),
      modelFirstTokenMs: span(modelStart, m.stream.firstTokenAt),
      firstDeltaMs: ms(this.#firstDelta),
      firstSpeechMs: ms(this.#firstSpeech),
      generationMs: span(this.#reasoning, this.#validating),
      structuredMs: m.structured.calls === 0 ? null : ms(m.structured.ms),
      finishMs: span(this.#validating, this.#end),
      totalMs: ms(this.#end),
      // Bedrock's prompt cache: the turn's input tokens and those read from and written to it, and the first
      // streamed call's (the one modelFirstTokenMs measures).
      ...m.tokenFields(),
      ...m.dbFields(),
      // LAB-P2: what else the process was serving, and the AWS connections the turn opened or reused.
      ...m.inflightFields(),
      ...m.connectionFields(),
    };
  }
}
