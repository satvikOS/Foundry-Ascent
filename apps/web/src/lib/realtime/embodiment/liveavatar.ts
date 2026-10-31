import type { AvatarSessionResponse } from '@foundry/contracts';

import type {
  AudioLevels,
  AvatarMountOptions,
  AvatarProvider,
  AvatarState,
  FaceLoss,
  FaceRelay,
  SpokenUnit,
} from '../avatar';
import {
  speakingTimeMs,
  type FaceRenderer,
  type FaceRendererOutput,
  type FaceRenderHandlers,
  type FaceUnitAudio,
  type SpeechUnitToPlay,
} from '../playback';
import {
  createFaceMediaElement,
  holdInMutedElement,
  onNextGesture,
  tapFaceAudio,
  type FaceAudioTap,
  type FaceMediaElement,
  type FaceTapMode,
} from './face-media';

export type { FaceAudioTap, FaceMediaElement, FaceTapMode } from './face-media';

/**
 * The vEIR's face through HeyGen LiveAvatar (docs/architecture/calls.md §4, docs/runbooks/avatars.md), in LITE
 * (voicing `audio`) or FULL (voicing `text`) mode.
 *
 * **Seen and heard together** (both modes, face-media.ts): the avatar's video and audio tracks play in one media
 * element (one `MediaStream`, unmuted), which the call tile shows, so the voice no longer crosses the call's Web
 * Audio graph and its extra latency (WebRTC's own audio/video sync applies when the vendor sends both tracks in one
 * stream, face-media.ts). The call measures the face's sound through an analyser connected to nothing (nothing plays
 * twice); ducking, barge-in and the end act on that element (volume, `muted`, `pause`). If the browser refuses the
 * element's sound (autoplay policy; a call starts with a click and captures the microphone, so this is rare), the
 * element plays muted and the sound goes through the call's own output instead; at the founder's next click, tap or
 * key the element tries its sound again, and that copy is removed only once the element plays sounding.
 *
 * **FULL** (a stock avatar with its stock voice, labelled "AI avatar"): the browser joins the room the same way
 * and still publishes no track (no microphone, no camera: plain livekit-client, so no microphone prompt). When a
 * signed unit's turn comes, it is sent to the vendor as `{event_id, event_type: 'avatar.speak_text', text}` on
 * `agent-control` (reliable) once the server admitted it: a unit the server admitted as it signed it (`faceApproved`,
 * face pre-approval) is sent at once; any other (the intro, a face that joined mid-turn) is asked for first
 * (`POST /calls/:id/face/say`, chained in order and usually done ahead, while the unit before it is heard) and sent
 * only on a 204. The unit counts as heard from
 * `avatar.speak_started` (or the face's audio level), and to its end at `avatar.speak_ended` (or its estimated
 * length). Units go to the vendor one at a time, each after the last one ended, so it makes no difference whether
 * the vendor queues commands or a new one cuts off the one it is saying. Barge-in sends `avatar.interrupt` (and
 * tells the server); a unit the face does not start saying in time is interrupted at the vendor first and then
 * spoken by the call itself in the stock voice, so two voices never overlap. While the founder may speak, the
 * avatar takes its listening pose (`avatar.start_listening` / `avatar.stop_listening`). Barge-in also silences the
 * face's element at once (the vendor's interrupt takes a round trip); the next unit turns it up again.
 *
 * **LITE**:
 * The browser only **watches**: it joins the vendor's LiveKit room with the room token the API minted
 * (`POST /calls/avatar-session`), subscribes to the avatar participant's (`heygen`) video and audio, and never
 * publishes anything (no microphone, no camera, no data). The face's speak channel (`ws_url`) stays on the
 * server. When a unit's turn comes, `render` hands the unit's audio back to the server through the relay
 * (`POST /calls/:id/face/speak`, checked against the server's manifest) and the vendor renders it: its audio
 * arrives on the room's audio track and plays with the video in the face's element. The unit counts as heard from
 * the face's first sound (the vendor's
 * `avatar.speak_started` event when the room carries it, else the audio track's level); a face that stays
 * silent gives the unit back to the call, which plays it itself. The SDK (livekit-client) loads only for a call
 * with this face, in its own chunk.
 */

/** The avatar's participant identity in the vendor's room (LiveAvatar web SDK 0.0.19). */
export const LIVEAVATAR_PARTICIPANT = 'heygen';
/** The topic the vendor's agent events arrive on in the room. */
export const LIVEAVATAR_EVENTS_TOPIC = 'agent-response';
/** The topic FULL commands go to the vendor on (reliable data, never a track). */
export const LIVEAVATAR_COMMAND_TOPIC = 'agent-control';
/** A face that shows no first frame by then is given up (the stage also gives up at 8 s). */
const FIRST_FRAME_MS = 8_000;
/** A unit the face does not start saying by then is played by the call itself. */
const ONSET_TIMEOUT_MS = 3_000;
/** Level above which the face's audio counts as speech. */
const ONSET_LEVEL = 0.01;
const POLL_MS = 40;
/** Beyond a unit's own length before it counts as heard to its end. */
const TAIL_MS = 250;

/** A remote track as the adapter uses it. */
export interface RoomTrack {
  readonly kind: 'audio' | 'video';
  readonly mediaStreamTrack: MediaStreamTrack;
}

/** The part of a LiveKit room the adapter uses: it watches, and in FULL sends commands. It never publishes a track. */
export interface LiveAvatarRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  onTrack(listener: (track: RoomTrack, participant: string) => void): void;
  onTrackGone(listener: (track: RoomTrack) => void): void;
  onDisconnected(listener: () => void): void;
  onData(listener: (payload: Uint8Array, topic: string | undefined) => void): void;
  /** FULL: sends the vendor one command on `topic`, reliably (data only). */
  publish(topic: string, payload: Uint8Array<ArrayBuffer>): Promise<void>;
}

export interface LiveAvatarDeps {
  createRoom(): LiveAvatarRoom;
  createStream(tracks: readonly MediaStreamTrack[]): MediaStream;
  /** The face's one media element (video and audio together), holding nothing yet. */
  createMediaElement(): FaceMediaElement;
  /**
   * Measures the face's audio track on the call's context: `analyser` only (connected to nothing), or also routed
   * into `output.destination` (`output`: the browser refused the element's sound).
   */
  tapAudio(track: MediaStreamTrack, output: FaceRendererOutput, mode: FaceTapMode): FaceAudioTap;
  /** Calls back once at the founder's next click, tap or key on the page (inside its handler); returns its cancel. */
  onGesture?(callback: () => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A command's `event_id` (default: a random UUID). */
  eventId?(): string;
}

/** The browser's room (livekit-client, loaded with this chunk). */
export async function browserLiveAvatarDeps(): Promise<LiveAvatarDeps> {
  const { Room, RoomEvent, Track } = await import('livekit-client');
  const kindOf = (kind: unknown): 'audio' | 'video' | null =>
    kind === Track.Kind.Audio ? 'audio' : kind === Track.Kind.Video ? 'video' : null;
  return {
    createRoom: () => {
      // Receive only: nothing is ever published from this page.
      const room = new Room({ adaptiveStream: false, dynacast: false });
      return {
        connect: (url, token) => room.connect(url, token, { autoSubscribe: true }),
        disconnect: () => {
          void room.disconnect();
        },
        onTrack: (listener) => {
          room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
            const kind = kindOf(track.kind);
            if (kind !== null)
              listener({ kind, mediaStreamTrack: track.mediaStreamTrack }, participant.identity);
          });
        },
        onTrackGone: (listener) => {
          room.on(RoomEvent.TrackUnsubscribed, (track) => {
            const kind = kindOf(track.kind);
            if (kind !== null) listener({ kind, mediaStreamTrack: track.mediaStreamTrack });
          });
        },
        onDisconnected: (listener) => {
          room.on(RoomEvent.Disconnected, listener);
        },
        onData: (listener) => {
          room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
            listener(payload, topic);
          });
        },
        // Data only: no track is ever published (no microphone prompt, nothing for the vendor to hear).
        publish: (topic, payload) => room.localParticipant.publishData(payload, { reliable: true, topic }),
      };
    },
    ...browserFaceMediaDeps(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number);
    },
  };
}

/** The browser's face element and audio tap (shared with the development stand-in). */
export function browserFaceMediaDeps(): Pick<
  LiveAvatarDeps,
  'createStream' | 'createMediaElement' | 'tapAudio' | 'onGesture'
> {
  return {
    createStream: (tracks) => new MediaStream([...tracks]),
    createMediaElement: createFaceMediaElement,
    tapAudio: (track, output, mode) =>
      tapFaceAudio(new MediaStream([track]), output, mode, holdInMutedElement),
    onGesture: onNextGesture,
  };
}

/** `element.play()` as a promise, also when it throws at once (an environment without media playback). */
function playing(element: FaceMediaElement): Promise<void> {
  try {
    return element.play();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error('play_failed'));
  }
}

/** Whether `play()` was refused by the browser's autoplay policy (not merely cut short by a new source). */
function refusedByPolicy(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'NotAllowedError';
}

function abortError(): DOMException {
  return new DOMException('face_closed', 'AbortError');
}

interface AgentEvent {
  readonly event_type?: string;
  readonly type?: string;
  readonly end_reason?: unknown;
}

/** The vendor's `end_reason` of a stopped session, when it is a plain short token (anything else is dropped). */
function vendorReason(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

export interface LiveAvatarFaceOptions {
  /** `audio` (LITE, default): the face renders the call's audio. `text` (FULL): the vendor voices admitted words. */
  readonly voicing?: 'audio' | 'text';
  /** `heygen`, or `fake` for the development stand-in of a FULL face (an in-page room). */
  readonly provider?: 'heygen' | 'fake';
}

/** A unit's key while it waits for (or has) the server's admission. */
function unitKey(unit: SpeechUnitToPlay): string {
  return `${unit.turnId ?? 'intro'}.${String(unit.seq)}`;
}

export class LiveAvatarFace implements AvatarProvider {
  readonly id: 'heygen' | 'fake';
  readonly drawsFace = true;
  readonly voicing: 'audio' | 'text';

  private room: LiveAvatarRoom | null = null;
  private relay: FaceRelay | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  /** The video alone, for the thumbnail (muted, decorative). */
  private stream: MediaStream | null = null;
  /** The one element that plays the face's video and audio together (the call tile shows it). */
  private element: FaceMediaElement | null = null;
  private tap: FaceAudioTap | null = null;
  /** The call's output the tap measures on (and routes into, when the element may not sound). */
  private output: FaceRendererOutput | null = null;
  /** Whether the element itself sounds (false: the browser refused it, and the call's output plays the face). */
  private audible = true;
  /** The call's level for the face (ducking). */
  private volume = 1;
  /** Barge-in or a unit given back: the face is silent until the next unit it renders. */
  private silenced = false;
  private cancelGesture: (() => void) | null = null;
  /** The element is trying its sound again (a gesture); the call's output still plays the face meanwhile. */
  private trying = false;
  private live = false;
  private readonly lostListeners = new Set<(loss: FaceLoss) => void>();
  /** The vendor's own speak events for the unit being rendered, when the room carries them; and the face's loss. */
  private speakEvents: { started(): void; ended(): void; lost(): void } | null = null;
  private readonly face: FaceRenderer;
  /** FULL: the server's admission of each unit, in order (one chain), usually asked for ahead of its turn. */
  private readonly admissions = new Map<string, Promise<void>>();
  private admissionChain: Promise<unknown> = Promise.resolve();
  /** Aborts every admission still in flight when the face goes. */
  private lifetime = new AbortController();
  /** FULL: whether the avatar was sent its listening pose. */
  private listening = false;

  constructor(
    private readonly deps: LiveAvatarDeps,
    options: LiveAvatarFaceOptions = {},
  ) {
    this.voicing = options.voicing ?? 'audio';
    this.id = options.provider ?? 'heygen';
    this.face = {
      voicing: this.voicing,
      ready: () => this.live,
      prepare: (unit) => {
        if (this.voicing === 'text' && this.live && unit.sig !== undefined)
          void this.admit(unit).catch(() => undefined);
      },
      render: (buffer, output, handlers, audio, unit) =>
        this.voicing === 'text'
          ? this.renderText(unit, output, handlers)
          : this.render(buffer, output, handlers, audio),
      setVolume: (volume) => {
        this.volume = Math.min(1, Math.max(0, volume));
        this.applyVolume();
      },
      level: () => this.tap?.level() ?? 0,
    };
  }

  mount(_stage: HTMLElement, _options: AvatarMountOptions): void {
    // The face draws itself (the vendor's video); nothing to mount.
  }

  setState(state: AvatarState): void {
    // LITE: the vendor's idle and listening loop is the face's listening state. FULL: the listening pose is a
    // command, sent while the founder may speak and taken back otherwise.
    if (this.voicing !== 'text' || !this.live) return;
    const listening = state === 'listening';
    if (listening === this.listening) return;
    this.listening = listening;
    void this.command(listening ? 'avatar.start_listening' : 'avatar.stop_listening');
  }

  setLevels(_levels: AudioLevels): void {
    // The vendor lip-syncs the audio it renders.
  }

  speak(_unit: SpokenUnit): void {
    // Units reach the face through `render` (the relay), never as text.
  }

  async connect(session: AvatarSessionResponse, signal: AbortSignal, relay: FaceRelay): Promise<void> {
    // The stand-in's in-page room needs no URL; the vendor's always has one.
    if (session.provider !== this.id || !session.token || (this.id === 'heygen' && !session.url)) {
      throw new Error('not_liveavatar_session');
    }
    const stopped = () => signal.aborted;
    if (stopped()) throw abortError();
    this.relay = relay;
    const room = this.deps.createRoom();
    this.room = room;
    const firstFrame = new Promise<void>((resolve, reject) => {
      const timer = this.deps.setTimeout(() => {
        reject(new Error('face_no_video'));
      }, FIRST_FRAME_MS);
      signal.addEventListener(
        'abort',
        () => {
          this.deps.clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
      room.onTrack((track, participant) => {
        if (participant !== LIVEAVATAR_PARTICIPANT || this.room !== room) return;
        if (track.kind === 'audio') {
          if (track.mediaStreamTrack === this.audioTrack) return;
          this.audioTrack = track.mediaStreamTrack;
          // A tap of an earlier track measures nothing any more.
          if (this.tap !== null) this.retap();
          this.showMedia();
          return;
        }
        this.videoTrack = track.mediaStreamTrack;
        this.stream = this.deps.createStream([track.mediaStreamTrack]);
        track.mediaStreamTrack.addEventListener('ended', () => {
          this.lose({ reason: 'video_ended' });
        });
        this.showMedia();
        this.deps.clearTimeout(timer);
        resolve();
      });
    });
    room.onTrackGone((track) => {
      if (track.mediaStreamTrack === this.videoTrack) this.lose({ reason: 'video_unsubscribed' });
    });
    room.onDisconnected(() => {
      this.lose({ reason: 'room_disconnected' });
    });
    room.onData((payload, topic) => {
      if (topic !== LIVEAVATAR_EVENTS_TOPIC) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(new TextDecoder().decode(payload)) as AgentEvent;
      } catch {
        return;
      }
      const name = event.event_type ?? event.type;
      if (name === 'avatar.speak_started' || name === 'agent.speak_started') this.speakEvents?.started();
      if (name === 'avatar.speak_ended' || name === 'agent.speak_ended') this.speakEvents?.ended();
      // FULL: the vendor ended the session (idle, its limit, no credits): the call goes on with the presence.
      if (name === 'session.stopped' && this.voicing === 'text') {
        const detail = vendorReason(event.end_reason);
        this.lose({ reason: 'vendor_stopped', ...(detail === undefined ? {} : { vendorReason: detail }) });
      }
    });
    try {
      await Promise.all([room.connect(session.url ?? '', session.token), firstFrame]);
    } catch (err) {
      this.release();
      throw err;
    }
    if (stopped()) {
      this.release();
      throw abortError();
    }
    this.live = true;
  }

  video(): MediaStream | null {
    return this.stream;
  }

  /** The one element that plays the face's video and audio together; the call tile shows this very element. */
  media(): FaceMediaElement | null {
    return this.element;
  }

  renderer(): FaceRenderer {
    return this.face;
  }

  onLost(listener: (loss: FaceLoss) => void): () => void {
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  unmount(): void {
    this.lostListeners.clear();
    this.release();
  }

  // Internals -----------------------------------------------------------------------------------------

  /**
   * The face's element holds its video and (once it arrived) its audio in one stream and plays it, sounding: the
   * browser then keeps the two in step.
   */
  private showMedia(): void {
    const video = this.videoTrack;
    if (video === null) return;
    let element = this.element;
    if (element === null) {
      element = this.deps.createMediaElement();
      element.addEventListener('pause', this.resume);
      this.element = element;
    }
    const tracks = this.audioTrack === null ? [video] : [video, this.audioTrack];
    element.srcObject = this.deps.createStream(tracks);
    this.applyVolume();
    this.play();
  }

  /** The browser paused the element (it was moved, or its sound refused): it plays again. */
  private readonly resume = (): void => {
    if (this.element?.paused === true) this.play();
  };

  private play(): void {
    const element = this.element;
    if (element === null) return;
    playing(element).catch((err: unknown) => {
      if (this.element !== element || this.trying) return;
      if (refusedByPolicy(err) && this.audible && !element.muted) this.refuseSound();
    });
  }

  /**
   * The browser refused the element's sound (autoplay policy). The face still shows (a muted element may play) and
   * its sound goes through the call's own output, without the element, rather than not at all; at the founder's
   * next click, tap or key the element tries its sound again ({@link trySound}).
   */
  private refuseSound(): void {
    this.audible = false;
    this.applyVolume();
    this.play();
    if (this.tap !== null) this.retap();
    this.awaitGesture();
  }

  private awaitGesture(): void {
    this.cancelGesture?.();
    this.cancelGesture =
      this.deps.onGesture?.(() => {
        this.cancelGesture = null;
        this.trySound();
      }) ?? null;
  }

  /**
   * Inside the founder's gesture: the element asks to sound again (unmuted at volume 0, and `play()` called within
   * the gesture, which is what lets Safari sound it), while the call's output still plays the face. Only once that
   * `play()` resolved with the element still playing unmuted is the element turned up and the copy in the call's
   * output removed (one moment, never both heard). A gesture that granted nothing (the browser refused again)
   * leaves the call's output as it was, mutes the element again and waits for the next gesture: the face's voice
   * never drops for a refused try.
   */
  private trySound(): void {
    const element = this.element;
    if (element === null || this.audible || this.trying) return;
    this.trying = true;
    element.volume = 0;
    element.muted = false;
    playing(element).then(
      () => {
        if (this.element !== element) return;
        this.trying = false;
        if (element.paused || element.muted) {
          this.refusedAgain();
          return;
        }
        this.audible = true;
        this.applyVolume();
        if (this.tap !== null) this.retap();
      },
      () => {
        if (this.element !== element) return;
        this.trying = false;
        this.refusedAgain();
      },
    );
  }

  /** A gesture's try was refused: the element plays muted again, the call's output still plays the face. */
  private refusedAgain(): void {
    this.applyVolume();
    this.play();
    this.awaitGesture();
  }

  /** The element's volume and `muted`, and the routed copy's gain, from the call's level and barge-in. */
  private applyVolume(): void {
    const element = this.element;
    // While a gesture's try is pending, the element stays unmuted at volume 0 (the call's output is heard).
    if (element !== null && !this.trying) {
      element.volume = this.silenced ? 0 : this.volume;
      // `muted` too: some browsers (iOS) ignore `volume`.
      element.muted = this.silenced || !this.audible;
    }
    this.tap?.mute?.(this.silenced);
  }

  /** Barge-in, or a unit given back to the call: the face is silent at once (the vendor stops a moment later). */
  private silence(): void {
    if (this.silenced) return;
    this.silenced = true;
    this.applyVolume();
  }

  /** The face renders a unit again: it is heard again. */
  private unsilence(): void {
    if (!this.silenced) return;
    this.silenced = false;
    this.applyVolume();
    if (this.element?.paused === true) this.play();
  }

  /** FULL: sends the vendor one command (best effort; a room that cannot take it is about to drop). */
  private command(eventType: string, fields: Record<string, string> = {}): Promise<void> {
    const room = this.room;
    if (room === null) return Promise.reject(new Error('face_closed'));
    const eventId = this.deps.eventId?.() ?? crypto.randomUUID();
    const payload = new TextEncoder().encode(
      JSON.stringify({ event_id: eventId, event_type: eventType, ...fields }),
    );
    const sent = room.publish(LIVEAVATAR_COMMAND_TOPIC, payload);
    sent.catch(() => undefined);
    return sent;
  }

  /**
   * FULL: the server's admission of a unit (once per unit, in the order asked; a refusal does not hold up the
   * units after it). A unit the server pre-approved as it signed it is already admitted: nothing is asked.
   */
  private admit(unit: SpeechUnitToPlay): Promise<void> {
    if (unit.faceApproved === true) return Promise.resolve();
    const key = unitKey(unit);
    const known = this.admissions.get(key);
    if (known !== undefined) return known;
    const say = this.relay?.say?.bind(this.relay);
    if (say === undefined) return Promise.reject(new Error('face_closed'));
    const signal = this.lifetime.signal;
    const admitted = this.admissionChain.then(() => say(unit, signal));
    this.admissionChain = admitted.catch(() => undefined);
    admitted.catch(() => undefined);
    // At most a few units wait ahead; a long call never accumulates them.
    if (this.admissions.size >= 16) this.admissions.clear();
    this.admissions.set(key, admitted);
    return admitted;
  }

  /**
   * FULL: has the vendor say one signed unit's words, once the server admitted it. Heard from the vendor's
   * `avatar.speak_started` (or the face's audio level), to `avatar.speak_ended` (or the unit's estimated length).
   * A unit not started in time is interrupted at the vendor, then given back to the call (`failed`).
   */
  private renderText(
    unit: SpeechUnitToPlay | undefined,
    output: FaceRendererOutput,
    handlers: FaceRenderHandlers,
  ): () => void {
    let stopped = false;
    let published = false;
    let began = false;
    let finished = false;
    const timers = new Set<unknown>();
    const relay = this.relay;
    const later = (callback: () => void, ms: number) => {
      const handle = this.deps.setTimeout(() => {
        timers.delete(handle);
        callback();
      }, ms);
      timers.add(handle);
    };
    const clearAll = () => {
      for (const handle of timers) this.deps.clearTimeout(handle);
      timers.clear();
    };
    const silence = () => {
      // Quiet in the page at once, then at the vendor.
      this.silence();
      void this.command('avatar.interrupt').catch(() => undefined);
      relay?.interrupt();
    };
    const end = (outcome: 'ended' | 'failed') => {
      if (stopped || finished) return;
      finished = true;
      clearAll();
      if (this.speakEvents === events) this.speakEvents = null;
      // Quiet at the vendor first: the call then speaks the unit itself, never over the face.
      if (outcome === 'failed' && published && !began) silence();
      handlers.onEnd(outcome);
    };
    const start = () => {
      if (stopped || began || finished) return;
      began = true;
      handlers.onStart();
      later(
        () => {
          end('ended');
        },
        speakingTimeMs(unit?.text ?? '') + TAIL_MS,
      );
    };
    const events = {
      started: start,
      ended: () => {
        if (began) end('ended');
      },
      // The face went away before this unit's first sound: the call says it now, not after the onset timeout.
      lost: () => {
        later(() => {
          if (!began) end('failed');
        }, 0);
      },
    };

    if (relay?.say === undefined || !this.live || unit?.sig === undefined) {
      later(() => {
        end('failed');
      }, 0);
    } else {
      // The face's sound is measured (never played) on the call's context; the element plays it.
      const tap = this.ensureTap(output);
      this.unsilence();
      this.speakEvents = events;
      this.admit(unit).then(
        () => {
          this.admissions.delete(unitKey(unit));
          if (stopped || finished) return;
          if (!this.live) {
            end('failed');
            return;
          }
          published = true;
          this.command('avatar.speak_text', { text: unit.text }).catch(() => {
            end('failed');
          });
          const poll = (waited: number) => {
            if (stopped || began || finished) return;
            if (tap !== null && tap.level() > ONSET_LEVEL) {
              start();
              return;
            }
            if (waited >= ONSET_TIMEOUT_MS) {
              end('failed');
              return;
            }
            later(() => {
              poll(waited + POLL_MS);
            }, POLL_MS);
          };
          poll(0);
        },
        () => {
          // Not admitted (the server refused it): nothing is sent to the vendor.
          this.admissions.delete(unitKey(unit));
          end('failed');
        },
      );
    }
    return () => {
      stopped = true;
      clearAll();
      if (this.speakEvents === events) this.speakEvents = null;
      // Barge-in or the end: silent in the page at once, whatever the vendor still has in flight.
      this.silence();
      if (published && !finished) silence();
    };
  }

  private render(
    buffer: AudioBuffer | null,
    output: FaceRendererOutput,
    handlers: FaceRenderHandlers,
    audio: FaceUnitAudio | null,
  ): () => void {
    let stopped = false;
    let relayed = false;
    let began = false;
    let finished = false;
    const timers = new Set<unknown>();
    const controller = new AbortController();
    const relay = this.relay;
    const later = (callback: () => void, ms: number) => {
      const handle = this.deps.setTimeout(() => {
        timers.delete(handle);
        callback();
      }, ms);
      timers.add(handle);
    };
    const clearAll = () => {
      for (const handle of timers) this.deps.clearTimeout(handle);
      timers.clear();
    };
    const end = (outcome: 'ended' | 'failed') => {
      if (stopped || finished) return;
      finished = true;
      clearAll();
      if (this.speakEvents === events) this.speakEvents = null;
      if (outcome === 'failed' && relayed && !began) {
        // Silent in the page, and at the vendor: the call plays the unit itself, never over the face.
        this.silence();
        relay?.interrupt();
      }
      handlers.onEnd(outcome);
    };
    const start = () => {
      if (stopped || began || finished) return;
      began = true;
      handlers.onStart();
      later(
        () => {
          end('ended');
        },
        (buffer?.duration ?? 0) * 1000 + TAIL_MS,
      );
    };
    const events = {
      started: start,
      ended: () => {
        if (began) end('ended');
      },
      lost: () => {
        later(() => {
          if (!began) end('failed');
        }, 0);
      },
    };

    const tap = audio !== null && relay !== null && this.live ? this.ensureTap(output) : null;
    if (buffer === null || audio === null || relay === null || tap === null) {
      // A unit the server did not give the face (or no face audio yet): the call plays it itself.
      later(() => {
        end('failed');
      }, 0);
    } else {
      this.unsilence();
      this.speakEvents = events;
      relay.speak(audio, controller.signal).then(
        () => {
          relayed = true;
          if (stopped || finished) return;
          // The face's first sound: the vendor's event, or its audio track's level.
          const poll = (waited: number) => {
            if (stopped || began || finished) return;
            if (tap.level() > ONSET_LEVEL) {
              start();
              return;
            }
            if (waited >= ONSET_TIMEOUT_MS) {
              end('failed');
              return;
            }
            later(() => {
              poll(waited + POLL_MS);
            }, POLL_MS);
          };
          poll(0);
        },
        () => {
          end('failed');
        },
      );
    }
    return () => {
      stopped = true;
      controller.abort();
      clearAll();
      if (this.speakEvents === events) this.speakEvents = null;
      // Barge-in or the end: silent in the page at once; the server tells the vendor.
      this.silence();
      if (relayed) relay?.interrupt();
    };
  }

  /** The tap on the face's audio track (once), or null while it has none. */
  private ensureTap(output: FaceRendererOutput): FaceAudioTap | null {
    this.output = output;
    if (this.tap !== null) return this.tap;
    if (this.audioTrack === null) return null;
    this.tap = this.deps.tapAudio(this.audioTrack, output, this.audible ? 'analyser' : 'output');
    this.tap.mute?.(this.silenced);
    return this.tap;
  }

  /** A new tap for the current track and mode (the element's sound refused or allowed again, a new track). */
  private retap(): void {
    this.tap?.disconnect();
    this.tap = null;
    if (this.output !== null) this.ensureTap(this.output);
  }

  /** The face went away: `loss` says which trigger fired (sent to the server with the face's end, audited). */
  private lose(loss: FaceLoss): void {
    if (!this.live) return;
    this.live = false;
    this.speakEvents?.lost();
    for (const listener of [...this.lostListeners]) listener(loss);
  }

  private release(): void {
    this.live = false;
    this.speakEvents?.lost();
    this.speakEvents = null;
    this.listening = false;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.admissions.clear();
    this.admissionChain = Promise.resolve();
    this.cancelGesture?.();
    this.cancelGesture = null;
    this.trying = false;
    this.tap?.disconnect();
    this.tap = null;
    this.output = null;
    const element = this.element;
    this.element = null;
    if (element !== null) {
      // The end: nothing of the face plays on.
      element.removeEventListener('pause', this.resume);
      element.pause();
      element.srcObject = null;
      element.remove();
    }
    this.room?.disconnect();
    this.room = null;
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.audible = true;
    this.silenced = false;
    this.volume = 1;
  }
}
