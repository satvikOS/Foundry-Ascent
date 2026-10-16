/**
 * Energy-based voice activity detection over the capture worklet's per-frame RMS (about every 50 ms).
 * It needs no model and no `wasm-unsafe-eval` in the CSP. The noise floor adapts while nobody speaks, so
 * a fan or a café does not count as speech; speech is a frame louder than both an absolute minimum and a
 * multiple of that floor.
 */
export interface VadOptions {
  /** RMS below this is never speech (normalised samples, 0–1). */
  readonly minRms: number;
  /** Speech must be this many times louder than the noise floor. */
  readonly floorRatio: number;
  /** Consecutive loud frames before speech starts (filters clicks and coughs). */
  readonly onsetFrames: number;
  /** How fast the floor follows the background while nobody speaks (0–1 per frame). */
  readonly floorAdapt: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minRms: 0.012,
  floorRatio: 3,
  onsetFrames: 2,
  floorAdapt: 0.05,
};

export interface VadResult {
  /** This frame is louder than the speech threshold. */
  readonly voiced: boolean;
  /** Speech is in progress (onset reached and not yet silent). */
  readonly speaking: boolean;
  /** Speech started on this frame. */
  readonly onset: boolean;
}

export class VoiceActivityDetector {
  private floor: number;
  private loudFrames = 0;
  private speaking = false;
  private readonly options: VadOptions;

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
    this.floor = this.options.minRms / this.options.floorRatio;
  }

  update(rms: number): VadResult {
    const { minRms, floorRatio, onsetFrames, floorAdapt } = this.options;
    const level = Number.isFinite(rms) && rms > 0 ? rms : 0;
    const voiced = level >= Math.max(minRms, this.floor * floorRatio);
    if (voiced) {
      this.loudFrames += 1;
    } else {
      this.loudFrames = 0;
      this.speaking = false;
      // Follow the background down quickly and up slowly.
      this.floor =
        level < this.floor ? level * 0.5 + this.floor * 0.5 : this.floor + (level - this.floor) * floorAdapt;
    }
    const onset = voiced && !this.speaking && this.loudFrames >= onsetFrames;
    if (onset) this.speaking = true;
    return { voiced, speaking: this.speaking, onset };
  }

  reset(): void {
    this.loudFrames = 0;
    this.speaking = false;
  }
}
