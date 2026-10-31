import { browserFakeFaceDeps, FakeFaceAvatar } from './fake-face';
import {
  LIVEAVATAR_COMMAND_TOPIC,
  LIVEAVATAR_EVENTS_TOPIC,
  LIVEAVATAR_PARTICIPANT,
  browserFaceMediaDeps,
  type LiveAvatarDeps,
  type LiveAvatarRoom,
  type RoomTrack,
} from './liveavatar';

/**
 * A LiveAvatar FULL room without the vendor (docs/architecture/calls.md §4): the stand-in for the unit tests and
 * for the development stand-in of a FULL face (`EMBODIMENT_PROVIDER=fake`, `MEDIA_FACE_MODE=full`). It shows the
 * avatar's audio track (when it has one) and video track once joined, as the vendor's room does, records every
 * command the page sends (`published`; a track can never be published, there is no API for it), and answers
 * `avatar.speak_text` the way the vendor documents it: on `agent-response`, `avatar.speak_started` and
 * `avatar.transcription` a moment later, then `avatar.speak_ended` after the words' length. It says nothing aloud.
 *
 * What the vendor does with a second `avatar.speak_text` while it is still speaking is not documented, so the room
 * does either: `queue` says them one after another, `cut` drops what it is saying for the new words (recorded in
 * `cutOff`). `avatar.interrupt` stops what it says and clears its queue.
 */

export interface FakeLiveAvatarRoomOptions {
  /** A second `avatar.speak_text` while speaking: queued (`queue`, default) or cutting off the first (`cut`). */
  readonly behaviour?: 'queue' | 'cut';
  /** The avatar's video track, shown once joined (null: none, so the face never shows its first frame). */
  readonly video: () => Promise<MediaStreamTrack | null>;
  /** The avatar's audio track, shown just before its video (default: none). */
  readonly audio?: () => Promise<MediaStreamTrack | null>;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** From the command to `avatar.speak_started`. */
  readonly startDelayMs?: number;
  /** Speaking time per character of the words. */
  readonly msPerCharacter?: number;
  /** Every command the page sent, as it arrives. */
  onPublish?(command: FakeRoomCommand): void;
  /** The avatar starts or stops speaking (the stand-in moves its mouth). */
  onSpeaking?(speaking: boolean): void;
  /** The room is left. */
  onDisconnect?(): void;
}

/** One command the page sent the room. */
export interface FakeRoomCommand {
  readonly topic: string;
  readonly eventType: string;
  readonly eventId: string | null;
  /** `avatar.speak_text` only. */
  readonly text: string | null;
}

export class FakeLiveAvatarRoom implements LiveAvatarRoom {
  /** Every command the page sent, in order. */
  readonly published: FakeRoomCommand[] = [];
  /** Words the avatar stopped saying because a new `avatar.speak_text` cut them off (`cut` only). */
  readonly cutOff: string[] = [];
  /** Words the avatar said to their end. */
  readonly said: string[] = [];
  connected = false;
  private readonly listeners = {
    track: [] as ((track: RoomTrack, participant: string) => void)[],
    gone: [] as ((track: RoomTrack) => void)[],
    disconnected: [] as (() => void)[],
    data: [] as ((payload: Uint8Array, topic: string | undefined) => void)[],
  };
  private speaking: { readonly text: string; readonly timers: unknown[] } | null = null;
  private readonly queue: string[] = [];
  private videoTrack: MediaStreamTrack | null = null;
  /** Each join and leave; a join that was left while it waited for its video shows none. */
  private epoch = 0;

  constructor(private readonly options: FakeLiveAvatarRoomOptions) {}

  async connect(_url: string, token: string): Promise<void> {
    if (!token) throw new Error('no_token');
    this.connected = true;
    this.epoch += 1;
    const joined = this.epoch;
    const audio = (await this.options.audio?.()) ?? null;
    if (joined !== this.epoch) return;
    if (audio !== null) {
      for (const listener of this.listeners.track) {
        listener({ kind: 'audio', mediaStreamTrack: audio }, LIVEAVATAR_PARTICIPANT);
      }
    }
    const track = await this.options.video();
    if (joined !== this.epoch || track === null) return;
    this.videoTrack = track;
    for (const listener of this.listeners.track) {
      listener({ kind: 'video', mediaStreamTrack: track }, LIVEAVATAR_PARTICIPANT);
    }
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.epoch += 1;
    this.silence();
    this.options.onDisconnect?.();
  }

  onTrack(listener: (track: RoomTrack, participant: string) => void): void {
    this.listeners.track.push(listener);
  }

  onTrackGone(listener: (track: RoomTrack) => void): void {
    this.listeners.gone.push(listener);
  }

  onDisconnected(listener: () => void): void {
    this.listeners.disconnected.push(listener);
  }

  onData(listener: (payload: Uint8Array, topic: string | undefined) => void): void {
    this.listeners.data.push(listener);
  }

  publish(topic: string, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('not_connected'));
    let parsed: { event_type?: unknown; event_id?: unknown; text?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload)) as typeof parsed;
    } catch {
      return Promise.reject(new Error('not_json'));
    }
    const command: FakeRoomCommand = {
      topic,
      eventType: typeof parsed.event_type === 'string' ? parsed.event_type : '',
      eventId: typeof parsed.event_id === 'string' ? parsed.event_id : null,
      text: typeof parsed.text === 'string' ? parsed.text : null,
    };
    this.published.push(command);
    this.options.onPublish?.(command);
    if (topic !== LIVEAVATAR_COMMAND_TOPIC) return Promise.resolve();
    if (command.eventType === 'avatar.speak_text' && command.text !== null) this.speakText(command.text);
    if (command.eventType === 'avatar.interrupt') this.silence();
    return Promise.resolve();
  }

  /** The vendor ends the session (`session.stopped`), as at its idle timeout or without credits. */
  stopSession(reason = 'IDLE_TIMEOUT'): void {
    this.emit({ event_type: 'session.stopped', end_reason: reason });
  }

  /** The avatar's video ends (the vendor dropped). */
  dropVideo(): void {
    const track = this.videoTrack;
    if (track === null) return;
    for (const listener of this.listeners.gone) listener({ kind: 'video', mediaStreamTrack: track });
  }

  /** Sends the page an event on `agent-response`. */
  emit(event: Record<string, unknown>): void {
    const payload = new TextEncoder().encode(JSON.stringify(event));
    for (const listener of this.listeners.data) listener(payload, LIVEAVATAR_EVENTS_TOPIC);
  }

  private speakText(text: string): void {
    if (this.speaking !== null) {
      if ((this.options.behaviour ?? 'queue') === 'queue') {
        this.queue.push(text);
        return;
      }
      this.cutOff.push(this.speaking.text);
      this.stopSpeaking();
    }
    this.say(text);
  }

  private say(text: string): void {
    const timers: unknown[] = [];
    this.speaking = { text, timers };
    const startDelay = this.options.startDelayMs ?? 120;
    timers.push(
      this.options.setTimeout(() => {
        this.emit({ event_type: 'avatar.speak_started' });
        this.emit({ event_type: 'avatar.transcription', text });
        this.options.onSpeaking?.(true);
      }, startDelay),
    );
    timers.push(
      this.options.setTimeout(
        () => {
          this.speaking = null;
          this.said.push(text);
          this.options.onSpeaking?.(false);
          this.emit({ event_type: 'avatar.speak_ended' });
          const next = this.queue.shift();
          if (next !== undefined) this.say(next);
        },
        startDelay + text.length * (this.options.msPerCharacter ?? 60),
      ),
    );
  }

  /** Stops what the avatar says (its end is reported), leaving the queue. */
  private stopSpeaking(): void {
    const current = this.speaking;
    if (current === null) return;
    for (const timer of current.timers) this.options.clearTimeout(timer);
    this.speaking = null;
    this.options.onSpeaking?.(false);
    this.emit({ event_type: 'avatar.speak_ended' });
  }

  private silence(): void {
    this.queue.length = 0;
    this.stopSpeaking();
  }
}

/** The page event each command of the stand-in's room is announced with (the end-to-end suite listens). */
export const STAND_IN_COMMAND_EVENT = 'foundry:face-command';

/**
 * The development stand-in of a FULL face in the browser: the real FULL adapter over a {@link FakeLiveAvatarRoom}
 * whose video is the stand-in's canvas face (no one's likeness) and whose mouth moves while it "speaks". It is
 * silent: its audio track carries silence, played with the video in the face's one element and measured by the
 * same analyser as the vendor's, so the page's media path is the real one. Every command is announced as a
 * {@link STAND_IN_COMMAND_EVENT} page event.
 */
export function standInLiveAvatarDeps(): LiveAvatarDeps {
  const timers = {
    setTimeout: (callback: () => void, ms: number): unknown => window.setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => {
      window.clearTimeout(handle as number);
    },
  };
  return {
    createRoom: () => {
      const canvas = new FakeFaceAvatar(browserFakeFaceDeps());
      let silence: AudioContext | null = null;
      return new FakeLiveAvatarRoom({
        ...timers,
        // A track of silence (nothing connected to it), like an idle avatar's.
        audio: () => {
          try {
            silence = new AudioContext();
            return Promise.resolve(silence.createMediaStreamDestination().stream.getAudioTracks()[0] ?? null);
          } catch {
            return Promise.resolve(null);
          }
        },
        video: async () => {
          const controller = new AbortController();
          await canvas.connect(
            {
              provider: 'fake',
              token: 'fake.stand-in',
              expiresAt: null,
              voiceId: null,
              voicing: 'audio',
              url: null,
              stockFace: true,
            },
            controller.signal,
            { speak: () => Promise.reject(new Error('silent')), interrupt: () => undefined },
          );
          return canvas.video()?.getVideoTracks()[0] ?? null;
        },
        onPublish: (command) => {
          window.dispatchEvent(new CustomEvent(STAND_IN_COMMAND_EVENT, { detail: command }));
        },
        onSpeaking: (speaking) => {
          canvas.setLevels({ veir: speaking ? 0.12 : 0, founder: 0 });
        },
        onDisconnect: () => {
          canvas.unmount();
          void silence?.close().catch(() => undefined);
          silence = null;
        },
      });
    },
    ...browserFaceMediaDeps(),
    ...timers,
  };
}
