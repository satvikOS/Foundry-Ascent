/** Content-free, bounded call diagnostics. These are browser scheduling estimates, never acoustic proof. */
export type VoiceStage =
  | 'sessionSetup'
  /** A video call: from Start call to the face's first frame (its speak channel open). */
  | 'callToFirstFrame'
  /** From Start call to the vEIR's first word heard (the intro): through the face on a video call. */
  | 'callToFirstWord'
  | 'transcriptAfterVadEnd'
  | 'endpointing'
  | 'endpointDecision'
  | 'submitToPlayback'
  | 'vadEndToPlayback'
  | 'interruptToStopScheduled';
const STAGES: readonly VoiceStage[] = [
  'sessionSetup',
  'callToFirstFrame',
  'callToFirstWord',
  'transcriptAfterVadEnd',
  'endpointing',
  'endpointDecision',
  'submitToPlayback',
  'vadEndToPlayback',
  'interruptToStopScheduled',
];
export const VOICE_TIMING_LIMIT = 128;
/** Distinct counters kept (endpoint reasons and a few events): names are fixed categories, never content. */
const COUNTER_LIMIT = 32;
export class VoiceTimings {
  private readonly values = new Map<VoiceStage, number[]>();
  private readonly counters = new Map<string, number>();
  /** Counts an event of a fixed category (`endpoint.question`, `resumed`, `backchannel`). */
  count(name: string): void {
    if (!this.counters.has(name) && this.counters.size >= COUNTER_LIMIT) return;
    this.counters.set(name, Math.min(1_000_000, (this.counters.get(name) ?? 0) + 1));
  }
  record(stage: VoiceStage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const samples = this.values.get(stage) ?? [];
    samples.push(ms);
    if (samples.length > VOICE_TIMING_LIMIT) samples.splice(0, samples.length - VOICE_TIMING_LIMIT);
    this.values.set(stage, samples);
  }
  clear(): void {
    this.values.clear();
    this.counters.clear();
  }
  report() {
    return {
      measurement: 'browser scheduling estimate',
      audibleOutputVerified: false,
      window: VOICE_TIMING_LIMIT,
      stages: Object.fromEntries(
        STAGES.map((stage) => {
          const samples = [...(this.values.get(stage) ?? [])].sort((a, b) => a - b);
          const percentile = (p: number) => samples[Math.max(0, Math.ceil(samples.length * p) - 1)] ?? null;
          return [
            stage,
            { n: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
          ];
        }),
      ),
      counts: Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}
