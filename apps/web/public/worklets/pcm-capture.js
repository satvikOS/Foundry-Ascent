/**
 * Microphone capture for vEIR calls (apps/web/src/lib/realtime/capture.ts).
 *
 * Runs on the audio rendering thread. It downsamples the microphone from the context rate (usually 44.1 or
 * 48 kHz) to 16 kHz by averaging each output sample's span of input samples (a box filter, which also keeps
 * aliasing down for speech), converts to 16-bit PCM and posts one frame every `frameMs` with its RMS level:
 * `{ pcm: ArrayBuffer (Int16, little-endian), rms: number }`. The buffer is transferred, not copied.
 *
 * Served as a static file from our own origin, so `script-src 'self'` covers it (no blob: URLs).
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    const targetRate = settings.targetSampleRate || 16000;
    const frameMs = settings.frameMs || 50;
    this.ratio = sampleRate / targetRate;
    this.frameSamples = Math.max(1, Math.round((targetRate * frameMs) / 1000));
    this.frame = new Int16Array(this.frameSamples);
    this.filled = 0;
    this.sumSquares = 0;
    this.accumulator = 0;
    this.accumulated = 0;
    this.position = 0;
  }

  emit(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.filled] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    this.sumSquares += clamped * clamped;
    this.filled += 1;
    if (this.filled === this.frameSamples) {
      const rms = Math.sqrt(this.sumSquares / this.frameSamples);
      this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
      this.frame = new Int16Array(this.frameSamples);
      this.filled = 0;
      this.sumSquares = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const length = input[0].length;
    for (let i = 0; i < length; i += 1) {
      let sample = 0;
      for (let c = 0; c < channels; c += 1) sample += input[c][i];
      this.accumulator += sample / channels;
      this.accumulated += 1;
      this.position += 1;
      if (this.position >= this.ratio) {
        this.position -= this.ratio;
        this.emit(this.accumulator / this.accumulated);
        this.accumulator = 0;
        this.accumulated = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
