import type { LiteSocket } from './lite-socket';

/**
 * A LiveAvatar LITE speak channel without the vendor (docs/architecture/calls.md §4.4): the stand-in for the unit
 * tests and for the development stand-in of a LITE stock face (`EMBODIMENT_PROVIDER=fake`,
 * `MEDIA_FACE_LITE_ROUTE=browser`). It answers the way the conversation lab measured the vendor's sandbox (run
 * 42087743218): `session.state_updated` `connected` once after it opens; one `agent.audio_buffer_appended` per
 * `agent.speak` and one `agent.audio_buffer_committed` per `agent.speak_end` (source = the utterance id);
 * `agent.speak_started` a moment after an utterance's first chunk and `agent.speak_ended` once its sealed audio
 * played out; a second utterance **cuts** the first (recorded in `cuts`); `agent.interrupt` answers
 * `agent.speak_interrupted` and `agent.audio_buffer_cleared` (the interrupt's id), and a `agent.speak_ended` still
 * follows. It says nothing aloud and records everything it was sent.
 */

export interface FakeLiteSocketOptions {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  /** Open → `connected` (default 5 ms). */
  readonly connectDelayMs?: number;
  /** First chunk → `speak_started` (default 300 ms). */
  readonly startDelayMs?: number;
  /** `stall`: never says `speak_started`; `refuse`: never connects. */
  readonly behaviour?: 'normal' | 'stall' | 'refuse';
  /** Every command, as it arrives. */
  onCommand?(command: FakeLiteCommand): void;
  /** The avatar starts or stops speaking (the stand-in moves its mouth). */
  onSpeaking?(speaking: boolean): void;
}

/** One command the page sent. */
export interface FakeLiteCommand {
  readonly type: string;
  readonly eventId: string | null;
  /** `agent.speak`: the audio's decoded length. */
  readonly bytes: number;
}

interface Speaking {
  readonly id: string;
  audioMs: number;
  startedAt: number | null;
  sealed: boolean;
  readonly timers: unknown[];
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** Bytes a base64 string decodes to. */
function decodedBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export class FakeLiteSocket implements LiteSocket {
  readyState = CONNECTING;
  /** Every command, in order. */
  readonly commands: FakeLiteCommand[] = [];
  /** Utterances opened (their ids), in order. */
  readonly utterances: string[] = [];
  /** Utterances a second utterance cut off. */
  readonly cuts: string[] = [];
  /** Utterances that played to their end. */
  readonly said: string[] = [];
  /** Audio received per utterance (ms). */
  readonly audioMs = new Map<string, number>();
  private speaking: Speaking | null = null;
  private readonly listeners: Record<
    'open' | 'close' | 'error' | 'message',
    ((event: { readonly data: unknown }) => void)[]
  > = { open: [], close: [], error: [], message: [] };

  constructor(private readonly options: FakeLiteSocketOptions) {
    options.setTimeout(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      for (const listener of this.listeners.open) listener({ data: null });
      if (options.behaviour === 'refuse') return;
      this.emit({ type: 'session.state_updated', state: 'connected' });
    }, options.connectDelayMs ?? 5);
  }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('not_open');
    const command = JSON.parse(data) as { type?: string; event_id?: string; audio?: string };
    const type = command.type ?? '';
    const eventId = command.event_id ?? null;
    const bytes = typeof command.audio === 'string' ? decodedBytes(command.audio) : 0;
    const record = { type, eventId, bytes };
    this.commands.push(record);
    this.options.onCommand?.(record);
    if (type === 'agent.speak' && eventId !== null) this.speak(eventId, bytes);
    else if (type === 'agent.speak_end' && eventId !== null) this.speakEnd(eventId);
    else if (type === 'agent.interrupt' && eventId !== null) this.interrupt(eventId);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.stop();
    this.readyState = CLOSED;
    for (const listener of this.listeners.close) listener({ data: null });
  }

  /** The vendor drops the channel (its session ended). */
  drop(): void {
    this.close();
  }

  /** Commands of `type` sent so far. */
  count(type: string): number {
    return this.commands.filter((c) => c.type === type).length;
  }

  private emit(event: Record<string, unknown>): void {
    const data = JSON.stringify({ event_id: `srv-${String(this.commands.length)}`, ...event });
    for (const listener of [...this.listeners.message]) listener({ data });
  }

  private speak(id: string, bytes: number): void {
    let current = this.speaking;
    if (current?.id !== id) {
      // A new utterance: whatever was being said is cut off (the vendor does not queue).
      if (current !== null) {
        this.cuts.push(current.id);
        this.stop();
      }
      current = { id, audioMs: 0, startedAt: null, sealed: false, timers: [] };
      this.speaking = current;
      this.utterances.push(id);
      const utterance = current;
      if (this.options.behaviour !== 'stall') {
        utterance.timers.push(
          this.options.setTimeout(() => {
            if (this.speaking !== utterance) return;
            utterance.startedAt = this.options.now();
            this.emit({ type: 'agent.speak_started', source_event_id: id });
            this.options.onSpeaking?.(true);
            this.scheduleEnd(utterance);
          }, this.options.startDelayMs ?? 300),
        );
      }
    }
    const ms = bytes / 48;
    current.audioMs += ms;
    this.audioMs.set(id, (this.audioMs.get(id) ?? 0) + ms);
    this.emit({ type: 'agent.audio_buffer_appended', source_event_id: id });
  }

  private speakEnd(id: string): void {
    this.emit({ type: 'agent.audio_buffer_committed', source_event_id: id });
    const current = this.speaking;
    if (current?.id !== id) return;
    current.sealed = true;
    this.scheduleEnd(current);
  }

  private scheduleEnd(utterance: Speaking): void {
    if (!utterance.sealed || utterance.startedAt === null) return;
    const left = Math.max(0, utterance.startedAt + utterance.audioMs - this.options.now());
    utterance.timers.push(
      this.options.setTimeout(() => {
        if (this.speaking !== utterance) return;
        this.speaking = null;
        this.said.push(utterance.id);
        this.options.onSpeaking?.(false);
        this.emit({ type: 'agent.speak_ended', source_event_id: utterance.id });
      }, left),
    );
  }

  private interrupt(interruptId: string): void {
    const current = this.speaking;
    if (current !== null) {
      this.emit({ type: 'agent.speak_interrupted', source_event_id: current.id });
      this.stop();
      // The vendor still reports the interrupted utterance's end a moment later.
      this.options.setTimeout(() => {
        this.emit({ type: 'agent.speak_ended', source_event_id: current.id });
      }, 50);
    }
    this.emit({ type: 'agent.audio_buffer_cleared', source_event_id: interruptId });
  }

  private stop(): void {
    const current = this.speaking;
    if (current === null) return;
    for (const timer of current.timers) this.options.clearTimeout(timer);
    this.speaking = null;
    this.options.onSpeaking?.(false);
  }
}
