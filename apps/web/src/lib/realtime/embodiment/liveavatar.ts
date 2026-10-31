import type { AvatarSessionResponse } from '@foundry/contracts';

import type {
  AudioLevels,
  AvatarMountOptions,
  AvatarProvider,
  AvatarState,
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

/**
 * The vEIR's face through HeyGen LiveAvatar (docs/architecture/calls.md §4, docs/runbooks/avatars.md), in LITE
 * (voicing `audio`) or FULL (voicing `text`) mode.
 *
 * **FULL** (a stock avatar with its stock voice, labelled "AI avatar"): the browser joins the room the same way
 * and still publishes no track (no microphone, no camera: plain livekit-client, so no microphone prompt). When a
 * signed unit's turn comes, `render` asks the server to admit it (`POST /calls/:id/face/say`, chained in order and
 * usually done ahead, while the unit before it is heard) and only on a 204 sends the vendor
 * `{event_id, event_type: 'avatar.speak_text', text}` on `agent-control` (reliable). The unit counts as heard from
 * `avatar.speak_started` (or the face's audio level), and to its end at `avatar.speak_ended` (or its estimated
 * length). Units go to the vendor one at a time, each after the last one ended, so it makes no difference whether
 * the vendor queues commands or a new one cuts off the one it is saying. Barge-in sends `avatar.interrupt` (and
 * tells the server); a unit the face does not start saying in time is interrupted at the vendor first and then
 * spoken by the call itself in the stock voice, so two voices never overlap. While the founder may speak, the
 * avatar takes its listening pose (`avatar.start_listening` / `avatar.stop_listening`).
 *
 * **LITE**:
 * The browser only **watches**: it joins the vendor's LiveKit room with the room token the API minted
 * (`POST /calls/avatar-session`), subscribes to the avatar participant's (`heygen`) video and audio, and never
 * publishes anything (no microphone, no camera, no data). The face's speak channel (`ws_url`) stays on the
 * server. When a unit's turn comes, `render` hands the unit's audio back to the server through the relay
 * (`POST /calls/:id/face/speak`, checked against the server's manifest) and the vendor renders it: its audio
 * arrives on the room's audio track, which plays into the call's own gain (ducking, loudness and captions
 * unchanged) while the `<video>` stays muted. The unit counts as heard from the face's first sound (the vendor's
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

/** The face's audio routed into the call's output, and its loudness. */
export interface FaceAudioTap {
  level(): number;
  disconnect(): void;
}

export interface LiveAvatarDeps {
  createRoom(): LiveAvatarRoom;
  createStream(tracks: readonly MediaStreamTrack[]): MediaStream;
  /** Routes the face's audio track into `output.destination` and measures it. */
  tapAudio(track: MediaStreamTrack, output: FaceRendererOutput): FaceAudioTap;
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
    createStream: (tracks) => new MediaStream([...tracks]),
    tapAudio: (track, output) => {
      const stream = new MediaStream([track]);
      // Chromium plays a remote WebRTC track into Web Audio only while a media element holds it (kept muted).
      const holder = new Audio();
      holder.muted = true;
      holder.srcObject = stream;
      void holder.play().catch(() => undefined);
      const context = output.context as unknown as AudioContext;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      const samples = new Float32Array(analyser.fftSize);
      source.connect(output.destination);
      source.connect(analyser);
      return {
        level: () => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const s of samples) sum += s * s;
          return Math.sqrt(sum / samples.length);
        },
        disconnect: () => {
          source.disconnect();
          holder.srcObject = null;
        },
      };
    },
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number);
    },
  };
}

function abortError(): DOMException {
  return new DOMException('face_closed', 'AbortError');
}

interface AgentEvent {
  readonly event_type?: string;
  readonly type?: string;
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
  private stream: MediaStream | null = null;
  private tap: FaceAudioTap | null = null;
  private live = false;
  private readonly lostListeners = new Set<() => void>();
  /** The vendor's own speak events for the unit being rendered, when the room carries them. */
  private speakEvents: { started(): void; ended(): void } | null = null;
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
        if (participant !== LIVEAVATAR_PARTICIPANT) return;
        if (track.kind === 'audio') {
          this.audioTrack = track.mediaStreamTrack;
          return;
        }
        this.videoTrack = track.mediaStreamTrack;
        this.stream = this.deps.createStream([track.mediaStreamTrack]);
        track.mediaStreamTrack.addEventListener('ended', () => {
          this.lose();
        });
        this.deps.clearTimeout(timer);
        resolve();
      });
    });
    room.onTrackGone((track) => {
      if (track.mediaStreamTrack === this.videoTrack) this.lose();
    });
    room.onDisconnected(() => {
      this.lose();
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
      if (name === 'session.stopped' && this.voicing === 'text') this.lose();
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

  renderer(): FaceRenderer {
    return this.face;
  }

  onLost(listener: () => void): () => void {
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
   * units after it).
   */
  private admit(unit: SpeechUnitToPlay): Promise<void> {
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
    };

    if (relay?.say === undefined || !this.live || unit?.sig === undefined) {
      later(() => {
        end('failed');
      }, 0);
    } else {
      // The face's audio plays into the call's own output (ducking, loudness and captions unchanged).
      const tap = this.ensureTap(output);
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
      if (outcome === 'failed' && relayed && !began) relay?.interrupt();
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
    };

    const tap = audio !== null && relay !== null && this.live ? this.ensureTap(output) : null;
    if (buffer === null || audio === null || relay === null || tap === null) {
      // A unit the server did not give the face (or no face audio yet): the call plays it itself.
      later(() => {
        end('failed');
      }, 0);
    } else {
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
      if (relayed) relay?.interrupt();
    };
  }

  /** The face's audio track routed into the call's output (once), or null while it has none. */
  private ensureTap(output: FaceRendererOutput): FaceAudioTap | null {
    if (this.tap !== null) return this.tap;
    if (this.audioTrack === null) return null;
    this.tap = this.deps.tapAudio(this.audioTrack, output);
    return this.tap;
  }

  private lose(): void {
    if (!this.live) return;
    this.live = false;
    for (const listener of [...this.lostListeners]) listener();
  }

  private release(): void {
    this.live = false;
    this.speakEvents = null;
    this.listening = false;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.admissions.clear();
    this.admissionChain = Promise.resolve();
    this.tap?.disconnect();
    this.tap = null;
    this.room?.disconnect();
    this.room = null;
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
  }
}
