import { type ModelGateway } from '@foundry/ai';

/**
 * The latencies the local harness adds to make a laptop behave like production (docs/runbooks/latency.md).
 * Locally the database answers in well under a millisecond and the mock model at once; in production every
 * statement is an HTTPS call to the RDS Data API and Bedrock takes its time to think. Each value is one
 * round trip or one call, in milliseconds.
 */
export interface SimulatedLatency {
  /** One RDS Data API call (a statement, a BeginTransaction or a CommitTransaction). */
  readonly dbRoundTripMs: number;
  /** Bedrock: from the request to the first streamed text. */
  readonly modelFirstTokenMs: number;
  /** Bedrock: the time to stream each further word (the text arrives word by word, as tokens do). */
  readonly modelWordMs: number;
  /** Bedrock: one structured (whole-object) call, e.g. the annotations of a streamed reply. */
  readonly structuredMs: number;
  /** Titan: one query embedding. */
  readonly embedMs: number;
  /** Polly: from the request to the first audio bytes. */
  readonly speechFirstByteMs: number;
}

/**
 * Profiles. `production` is an estimate (stated in the runbook, to be replaced by the production numbers the
 * new log fields report): Data API calls from Lambda in the same region, Nova 2 Lite streaming, Titan V2 and
 * Polly neural. `local` adds nothing: what the code itself costs on this machine.
 */
export const LATENCY_PROFILES = {
  production: {
    dbRoundTripMs: 20,
    modelFirstTokenMs: 650,
    modelWordMs: 6,
    structuredMs: 1_400,
    embedMs: 90,
    speechFirstByteMs: 180,
  },
  local: {
    dbRoundTripMs: 0,
    modelFirstTokenMs: 0,
    modelWordMs: 0,
    structuredMs: 0,
    embedMs: 0,
    speechFirstByteMs: 0,
  },
} as const satisfies Record<string, SimulatedLatency>;

export type LatencyProfileName = keyof typeof LATENCY_PROFILES;

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      });

/**
 * The model gateway with the model's own time added: a stream's text arrives word by word, the first word
 * after the time to first token and each further one after `modelWordMs` (the inner gateway, a mock without
 * pauses, hands over whole sentences at once); a structured result after a whole call's time; vectors after
 * an embedding's time. The text and results are the inner gateway's, unchanged.
 */
export function simulatedGateway(inner: ModelGateway, latency: SimulatedLatency): ModelGateway {
  return {
    info: inner.info,
    async embed(texts, options) {
      await pause(latency.embedMs, options.signal);
      return inner.embed(texts, options);
    },
    async generateStructured(request) {
      await pause(latency.structuredMs, request.signal);
      return inner.generateStructured(request);
    },
    async streamText(request, onText) {
      let first = true;
      return inner.streamText(request, async (chunk) => {
        for (const word of chunk.match(/\S+\s*|\s+/g) ?? []) {
          await pause(first ? latency.modelFirstTokenMs : latency.modelWordMs, request.signal);
          first = false;
          if (request.signal?.aborted === true) return;
          await onText(word);
        }
      });
    },
  };
}
