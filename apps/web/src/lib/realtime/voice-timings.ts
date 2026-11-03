/** Content-free, bounded call diagnostics. These are browser scheduling estimates, never acoustic proof. */
export type VoiceStage =
  | 'sessionSetup'
  | 'transcriptAfterVadEnd'
  | 'endpointing'
  | 'submitToPlayback'
  | 'vadEndToPlayback'
  | 'interruptToStopScheduled';
const STAGES: readonly VoiceStage[] = [
  'sessionSetup',
  'transcriptAfterVadEnd',
  'endpointing',
  'submitToPlayback',
  'vadEndToPlayback',
  'interruptToStopScheduled',
];
export const VOICE_TIMING_LIMIT = 128;
export class VoiceTimings {
  private readonly values = new Map<VoiceStage, number[]>();
  record(stage: VoiceStage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const samples = this.values.get(stage) ?? [];
    samples.push(ms);
    if (samples.length > VOICE_TIMING_LIMIT) samples.splice(0, samples.length - VOICE_TIMING_LIMIT);
    this.values.set(stage, samples);
  }
  clear(): void {
    this.values.clear();
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
    };
  }
}
