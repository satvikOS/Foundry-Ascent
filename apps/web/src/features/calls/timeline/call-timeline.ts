import type { AudioLevels } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';

import { TimelineRecorder } from './timeline-model';

type FrameListener = (levels: AudioLevels) => void;

/**
 * A live call's one animation-frame loop and its conversation timeline. While the call is live and the page is
 * visible, each frame reads the engine's measured levels once and hands them to whatever presents the call (the
 * sphere, the character) and to the timeline recorder, so nothing else loops. The vEIR's bins are the playback
 * analyser's level while it is speaking; the founder's are the microphone's while their voice is detected (never
 * the vEIR's echo while it speaks). Everything stays in this page's memory and is dropped with the call.
 */
export class CallTimeline {
  readonly recorder = new TimelineRecorder();
  private readonly frameListeners = new Set<FrameListener>();
  private frame = 0;
  private running = false;
  private callId: string | null = null;
  private founderLine: string | null = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly engine: CallEngine,
    private readonly frames: {
      readonly request: (callback: FrameRequestCallback) => number;
      readonly cancel: (handle: number) => void;
      readonly now: () => number;
      readonly visible: () => boolean;
    } = {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => {
        cancelAnimationFrame(handle);
      },
      now: () => performance.now(),
      visible: () => document.visibilityState !== 'hidden',
    },
  ) {
    this.unsubscribe.push(engine.subscribe(this.sync));
    this.unsubscribe.push(
      engine.onSpeak((unit) => {
        this.recorder.annotate('veir', unit.text, { upcoming: true });
      }),
    );
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.sync);
      this.unsubscribe.push(() => {
        document.removeEventListener('visibilitychange', this.sync);
      });
    }
    this.sync();
  }

  /** Every frame's levels while the call is live and the page visible (the presentation follows them). */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  private readonly sync = (): void => {
    const s = this.engine.getSnapshot();
    const id = s.call?.id ?? null;
    if (s.phase === 'idle' || s.phase === 'starting') {
      if (this.callId !== null || this.recorder.turns().length > 0) this.recorder.reset();
      this.callId = null;
    } else if (id !== null && id !== this.callId) {
      this.callId = id;
      this.recorder.reset();
    }
    if (s.phase === 'ended' || s.phase === 'failed') this.recorder.finish();
    // The founder's finished line (the endpointer took it): the words of their latest turn.
    const line = s.captions.founderLive ? null : s.captions.founder;
    if (line && line !== this.founderLine) this.recorder.annotate('student', line);
    this.founderLine = line;
    const run = s.phase === 'live' && this.frames.visible();
    if (run && !this.running) {
      this.running = true;
      this.frame = this.frames.request(this.tick);
    } else if (!run && this.running) {
      this.running = false;
      this.frames.cancel(this.frame);
      for (const listener of this.frameListeners) listener({ veir: 0, founder: 0 });
    }
  };

  private readonly tick = (): void => {
    if (!this.running) return;
    const levels = this.engine.levels();
    for (const listener of this.frameListeners) listener(levels);
    const s = this.engine.getSnapshot();
    const veirSpeaking = s.activity === 'speaking' && !s.held;
    const founderSpeaking = !veirSpeaking && this.engine.founderVoiced();
    this.recorder.sample(this.frames.now(), {
      veir: veirSpeaking ? levels.veir : null,
      student: founderSpeaking ? levels.founder : null,
    });
    this.frame = this.frames.request(this.tick);
  };

  dispose(): void {
    this.running = false;
    this.frames.cancel(this.frame);
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.frameListeners.clear();
  }
}

const timelines = new WeakMap<CallEngine, CallTimeline>();

/** The call engine's timeline and frame loop (one per engine, created on first use). */
export function callTimeline(engine: CallEngine): CallTimeline {
  let timeline = timelines.get(engine);
  if (!timeline) {
    timeline = new CallTimeline(engine);
    timelines.set(engine, timeline);
  }
  return timeline;
}
