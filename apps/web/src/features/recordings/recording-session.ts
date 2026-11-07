import type { RecordingView } from '@foundry/contracts';

import type { RecordedCall } from '@/lib/api/hooks/recording-upload';
import type { UploadProgress } from '@/lib/api/hooks/documents';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { CallSnapshot } from '@/lib/realtime/call-state';

import { CaptionRecorder, toWebVtt } from './captions';
import {
  CallRecorder,
  type CallRecorderInput,
  type RecordingAudio,
  type RecordingCapture,
  type RecordingPicture,
} from './call-recorder';

/*
 * The recording of a live call (ADR-0023): one per call engine, so it carries on while the call is minimized and
 * ends with the call. Record starts it: where the browser can share this tab it first asks for it (the call as the
 * founder sees it, recorded while the call screen is open; minimized, the composed call view is recorded instead), and
 * records the composed call view where it cannot or the founder did not share this tab, saying so. Stop (Cancel while
 * the browser asks), the browser's own Stop sharing, hanging up or the call ending any other way stops it and saves it (the
 * file and its captions go to the recordings store, then it shows in the conversation and under Recordings). A save
 * that fails keeps the file in this page so it can be tried again; nothing is kept anywhere else. While it is kept, a
 * new recording cannot start: the founder saves it (Try again) or lets it go (Discard) first, so a take is never lost
 * without their say. For the same reason, while a take exists only in this page (recording, saving, or waiting for
 * Try again) leaving the page asks first. A save refused because today's recordings are used up cannot succeed by
 * trying again: it says so, and Record is not offered again until the limit has passed.
 */

export type RecordingState =
  | { readonly status: 'idle' }
  /** The browser asks which screen to share. */
  | { readonly status: 'starting' }
  | {
      readonly status: 'recording';
      readonly callId: string;
      readonly startedAt: number;
      /** What the picture is: the shared screen, the composed call view, or none. */
      readonly capture: RecordingCapture;
      /** What the founder should know about it (this tab was not shared, so the call view is), until they close it. */
      readonly note: string | null;
    }
  | { readonly status: 'saving'; readonly percent: number | null }
  | { readonly status: 'saved'; readonly recording: RecordingView }
  | {
      readonly status: 'failed';
      /** What failed: the recording did not start, or it was not saved. */
      readonly title: string;
      readonly message: string;
      /** The take is kept in this page and can be saved again (Try again), or discarded. */
      readonly canRetry: boolean;
    };

/** The parts of the call engine a recording reads. */
export interface RecordedEngine {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => CallSnapshot;
  recordingSources(): RecordingAudio | null;
  levels(): { veir: number; founder: number };
}

/** The parts of the call's face a recording reads. */
export interface RecordedFace {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () =>
    | {
        readonly status: 'live';
        readonly media: HTMLVideoElement | null;
        readonly stream: MediaStream | null;
      }
    | { readonly status: string };
}

type Recorder = Pick<CallRecorder, 'start' | 'stop' | 'sync' | 'onLimit' | 'onScreenEnded' | 'capture'>;

export interface RecordingSessionDeps {
  createRecorder(input: CallRecorderInput): Recorder;
  /**
   * Asks to share this tab (the browser's prompt), in the Record press itself; null where it cannot be shared.
   * {@link requestScreen} in the browser.
   */
  requestScreen?(): Promise<MediaStream> | null;
  /**
   * Whether a shared screen is this tab (sharesThisTab in the browser): anything else, or anything when this is not
   * given, is not recorded.
   */
  isThisTab?(display: MediaStream): boolean;
  save(
    recording: RecordedCall,
    options: { readonly onProgress?: (progress: UploadProgress) => void },
  ): Promise<RecordingView>;
  /** Wall clock (ms): the recording's elapsed time on screen. */
  now(): number;
  /**
   * Makes leaving the page ask first (a take exists only in this page) until the returned release is called. The
   * browser's own `beforeunload` prompt: guardPageUnload (page-unload.ts).
   */
  guardUnload?(): () => void;
}

export interface RecordingSubject {
  /** The vEIR's name (drawn with the presence, and the name on its captions). */
  readonly veirName: string;
  /** The founder's name on their captions. */
  readonly founderName: string;
  readonly face: RecordedFace | null;
}

const IDLE: RecordingState = { status: 'idle' };
const START_FAILED = 'The recording didn’t start';
const SAVE_FAILED = 'The recording wasn’t saved';
const NOT_LIVE = 'The call isn’t live.';
/** The conversation lines a composed call view shows (as many as fit its panel are drawn). */
const TRANSCRIPT_LINES = 8;

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/**
 * Why this tab is not recorded when it was asked for: the person declined, the browser could not share it, or what
 * was shared is not this tab (another tab, a window, a whole screen: refused, it is never recorded).
 */
export type UnsharedReason = 'declined' | 'failed' | 'elsewhere';

/** What the founder should know about what is recorded, or null when it is what they expect. */
export function captureNote(capture: RecordingCapture, unshared: UnsharedReason | null): string | null {
  if (capture === 'sound') return 'This browser records the sound only.';
  if (capture === 'screen' || unshared === null) return null;
  return {
    declined: 'The screen wasn’t shared, so the call view is recorded.',
    failed: 'The browser couldn’t share this tab, so the call view is recorded.',
    elsewhere: 'Only this tab can be recorded, so the call view is recorded.',
  }[unshared];
}

export class RecordingSession {
  private state: RecordingState = IDLE;
  private readonly listeners = new Set<() => void>();
  private subject: RecordingSubject = { veirName: 'Your mentor', founderName: 'You', face: null };
  private active: {
    readonly recorder: Recorder;
    readonly captions: CaptionRecorder;
    readonly callId: string;
    readonly startedAt: number;
    readonly release: () => void;
  } | null = null;
  /** A recording whose save failed, kept in this page for another try. */
  private unsaved: RecordedCall | null = null;
  /** Until when (ms) the day's recordings are used up: none can be saved, so none starts. */
  private limitedUntil = 0;
  /** Releases the leave-the-page prompt, while a take exists only in this page. */
  private releaseUnload: (() => void) | null = null;
  /** The screen asked for and not answered yet (Stop meanwhile forgets it, and stops it once it comes). */
  private asking: { readonly release: () => void } | null = null;
  /** Whether the call screen is open (the shared tab shows the call only then). */
  private onScreen = true;
  onSaved: ((recording: RecordingView) => void) | null = null;

  constructor(
    private readonly engine: RecordedEngine,
    private readonly deps: RecordingSessionDeps,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RecordingState => this.state;

  /** Who and what the recording shows (the call screen keeps it current). */
  attach(subject: RecordingSubject): void {
    this.subject = subject;
  }

  /** The call screen opened or closed (minimized, or the call over): while it is closed the call view is recorded. */
  showing(open: boolean): void {
    this.onScreen = open;
  }

  private set(state: RecordingState): void {
    this.state = state;
    const holding = state.status === 'recording' || state.status === 'saving' || this.unsaved !== null;
    if (holding && this.releaseUnload === null) {
      this.releaseUnload = this.deps.guardUnload?.() ?? null;
    } else if (!holding && this.releaseUnload !== null) {
      this.releaseUnload();
      this.releaseUnload = null;
    }
    for (const listener of [...this.listeners]) listener();
  }

  /** Today's recordings are used up (a save said so): Record waits until the limit has passed. */
  limitReached(): boolean {
    return this.deps.now() < this.limitedUntil;
  }

  /**
   * Whether Record may start now: nothing recording or saving, no take whose save failed still waiting to be saved or
   * discarded, and today's recordings not used up.
   */
  canStart(): boolean {
    return (
      this.active === null &&
      this.asking === null &&
      this.state.status !== 'saving' &&
      this.unsaved === null &&
      !this.limitReached()
    );
  }

  /**
   * Starts recording the live call: asks to share this tab first where the browser can (called from the Record press,
   * so the browser may ask), then records it, or the composed call view when it was not shared. When it cannot record
   * (no live call, a browser that cannot) the state says why (`failed`, nothing to retry). Does nothing while
   * {@link canStart} is false.
   */
  start(): void {
    if (!this.canStart()) return;
    const callId = this.liveCallId();
    if (callId === null) {
      this.set({ status: 'failed', title: START_FAILED, message: NOT_LIVE, canRetry: false });
      return;
    }
    let asked: Promise<MediaStream> | null;
    try {
      asked = this.deps.requestScreen?.() ?? null;
    } catch {
      this.launch(null, 'failed');
      return;
    }
    if (asked === null) {
      this.launch(null, null);
      return;
    }
    // The call that was live at the press: when it ends while the browser asks, nothing is recorded (not even for a
    // call that starts meanwhile, which nobody pressed Record in), and Record is offered again at once.
    const offEngine = this.engine.subscribe(() => {
      if (this.asking !== null && this.liveCallId() !== callId) this.forgetAsking();
    });
    const token = { release: offEngine };
    this.asking = token;
    this.set({ status: 'starting' });
    const answered = (display: MediaStream | null, unshared: UnsharedReason | null) => {
      if (this.asking !== token) {
        stopTracks(display);
        return;
      }
      this.asking = null;
      offEngine();
      if (this.liveCallId() !== callId) {
        stopTracks(display);
        this.set(IDLE);
        return;
      }
      if (display !== null && this.deps.isThisTab?.(display) !== true) {
        stopTracks(display);
        this.launch(null, 'elsewhere');
        return;
      }
      this.launch(display, unshared);
    };
    asked.then(
      (display) => {
        answered(display, null);
      },
      (error: unknown) => {
        // Declining the browser's prompt is a NotAllowedError; anything else is the browser not managing it.
        const declined = error instanceof DOMException && error.name === 'NotAllowedError';
        answered(null, declined ? 'declined' : 'failed');
      },
    );
  }

  /** The live call's id, while it can be recorded (its sound is there), else null. */
  private liveCallId(): string | null {
    const snapshot = this.engine.getSnapshot();
    return snapshot.phase === 'live' && this.engine.recordingSources() !== null
      ? (snapshot.call?.id ?? null)
      : null;
  }

  /** Stops waiting for the browser's answer: nothing started (a screen shared after all is stopped once it comes). */
  private forgetAsking(): void {
    this.asking?.release();
    this.asking = null;
    this.set(IDLE);
  }

  /** Records `display` (this tab), or the call view when there is none (`unshared`: why, when it was asked for). */
  private launch(display: MediaStream | null, unshared: UnsharedReason | null): void {
    try {
      this.begin(display, unshared);
    } catch (error) {
      stopTracks(display);
      this.set({ status: 'failed', title: START_FAILED, message: messageOf(error), canRetry: false });
    }
  }

  private begin(display: MediaStream | null, unshared: UnsharedReason | null): void {
    const snapshot = this.engine.getSnapshot();
    const callId = snapshot.call?.id ?? null;
    const audio = this.engine.recordingSources();
    if (snapshot.phase !== 'live' || callId === null || audio === null) throw new Error(NOT_LIVE);
    const picture = (): RecordingPicture => {
      const face = this.subject.face?.getSnapshot();
      return face?.status === 'live' && 'media' in face
        ? { media: face.media, stream: face.stream }
        : { media: null, stream: null };
    };
    const captions = new CaptionRecorder();
    const recorder = this.deps.createRecorder({
      audio,
      name: this.subject.veirName,
      founderName: this.subject.founderName,
      level: () => this.engine.levels().veir,
      picture,
      transcript: () => captions.recent(TRANSCRIPT_LINES),
      display,
      onScreen: () => this.onScreen,
    });
    recorder.start();
    const startedAt = this.deps.now();
    captions.observe(snapshot.captions, 0);
    const onEngine = () => {
      const now = this.engine.getSnapshot();
      if (now.phase !== 'live' || now.call?.id !== callId) {
        void this.stop();
        return;
      }
      captions.observe(now.captions, this.deps.now() - startedAt);
      const sources = this.engine.recordingSources();
      if (sources !== null) recorder.sync(sources);
    };
    const onFace = () => {
      const sources = this.engine.recordingSources();
      if (sources !== null) recorder.sync(sources);
    };
    const offEngine = this.engine.subscribe(onEngine);
    const offFace = this.subject.face?.subscribe(onFace) ?? (() => undefined);
    recorder.onLimit = () => {
      void this.stop();
    };
    recorder.onScreenEnded = () => {
      void this.stop();
    };
    this.active = {
      recorder,
      captions,
      callId,
      startedAt,
      release: () => {
        offEngine();
        offFace();
      },
    };
    this.set({
      status: 'recording',
      callId,
      startedAt,
      capture: recorder.capture,
      note: captureNote(recorder.capture, unshared),
    });
  }

  /** The founder read the recording's note: it goes. */
  dismissNote(): void {
    if (this.state.status === 'recording' && this.state.note !== null)
      this.set({ ...this.state, note: null });
  }

  /**
   * Stops recording (Stop, the browser's Stop sharing, hanging up, the call ending) and saves it. While the browser
   * still asks which screen to share (Cancel), nothing has started: it is forgotten (a screen shared after all is
   * stopped).
   */
  async stop(): Promise<void> {
    if (this.asking !== null) {
      this.forgetAsking();
      return;
    }
    const active = this.active;
    if (active === null) return;
    this.active = null;
    active.release();
    const captionsEnd = this.deps.now() - active.startedAt;
    this.set({ status: 'saving', percent: null });
    let recorded: RecordedCall;
    try {
      const finished = await active.recorder.stop();
      const cues = active.captions.finish(Math.max(captionsEnd, finished.durationMs));
      recorded = {
        callId: active.callId,
        media: finished.media,
        mimeType: finished.mimeType,
        durationMs: finished.durationMs,
        captions:
          cues.length === 0
            ? null
            : {
                vtt: toWebVtt(cues, { veir: this.subject.veirName, founder: this.subject.founderName }),
                cues: cues.length,
              },
      };
    } catch (error) {
      this.set({ status: 'failed', title: SAVE_FAILED, message: messageOf(error), canRetry: false });
      return;
    }
    await this.save(recorded);
  }

  /** Tries again to save a recording whose save failed. */
  async retry(): Promise<void> {
    const recorded = this.unsaved;
    if (recorded === null || this.state.status !== 'failed') return;
    await this.save(recorded);
  }

  /** Forgets a saved or failed recording (Discard: a failed one's file is dropped). */
  dismiss(): void {
    if (this.state.status !== 'saved' && this.state.status !== 'failed') return;
    this.unsaved = null;
    this.set(IDLE);
  }

  private async save(recorded: RecordedCall): Promise<void> {
    this.unsaved = recorded;
    this.set({ status: 'saving', percent: 0 });
    try {
      const saved = await this.deps.save(recorded, {
        onProgress: (progress) => {
          if (this.state.status === 'saving') this.set({ status: 'saving', percent: progress.percent });
        },
      });
      this.unsaved = null;
      this.set({ status: 'saved', recording: saved });
      this.onSaved?.(saved);
    } catch (error) {
      // Today's recordings are used up: trying again cannot save it, so it is not kept for that.
      const limited = isApiError(error) && error.reason === DAILY_LIMIT_REASON;
      if (limited) {
        this.unsaved = null;
        this.limitedUntil = this.deps.now() + (error.retryAfter ?? 3_600) * 1000;
      }
      this.set({ status: 'failed', title: SAVE_FAILED, message: saveFailure(error), canRetry: !limited });
    }
  }
}

const DAILY_LIMIT_REASON = 'daily_recordings';

/** Why Record is not offered once today's recordings are used up (and why the save that found it failed). */
export const DAILY_LIMIT_TEXT = 'You’ve saved as many recordings as you can today.';

/** Why a save failed, in words that fit a recording (the generic conflict message would not). */
export function saveFailure(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'conflict') {
      return error.reason === 'recording_private_call'
        ? 'Private calls aren’t recorded.'
        : 'The recording didn’t finish uploading.';
    }
    if (error.reason === DAILY_LIMIT_REASON) return DAILY_LIMIT_TEXT;
    if (error.code === 'network_error') return 'The connection dropped while it was saving.';
  }
  return errorMessage(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The recording couldn’t be finished.';
}

const sessions = new WeakMap<object, RecordingSession>();

/** The call engine's recording (one per engine, created on first use). */
export function recordingSessionFor(engine: RecordedEngine, deps: RecordingSessionDeps): RecordingSession {
  let session = sessions.get(engine);
  if (!session) {
    session = new RecordingSession(engine, deps);
    sessions.set(engine, session);
  }
  return session;
}

/** The recording that runs in the browser (MediaRecorder on the shared screen or the call view, and the call's sound). */
export function browserRecorder(input: CallRecorderInput): CallRecorder {
  return new CallRecorder(input);
}
