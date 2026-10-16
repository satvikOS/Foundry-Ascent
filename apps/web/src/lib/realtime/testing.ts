/**
 * Fakes for the realtime engine's browser edges (WebSocket, Web Audio, the capture worklet, speech
 * synthesis). Imported by *.test.ts files only.
 */
import type { CoachResponse, TurnView } from '@foundry/contracts';

import { encodeMessage } from './event-stream';
import type { WebSocketLike } from './transcribe';

export const IDS = {
  venture: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  session: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02',
  turn: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f03',
  memory: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a04',
  persona: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
  escalation: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07',
} as const;

const NOW = '2026-10-01T12:00:00.000Z';

export function makeReply(overrides: Partial<CoachResponse> = {}): CoachResponse {
  return {
    mode: 'coach',
    answer: 'Twelve interviews is a good start [E1]. What did they say about price?',
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [{ owner: 'Maya', action: 'Interview five library staff', target_date: '2026-10-21' }],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
    spoken: 'Twelve interviews is a good start. What did they say about price?',
    ...overrides,
  };
}

export function makeVoiceTurn(overrides: Partial<TurnView> = {}): TurnView {
  return {
    id: IDS.turn,
    sessionId: IDS.session,
    ordinal: 1,
    mode: 'coach',
    founderText: 'We interviewed twelve clinics.',
    status: 'completed',
    response: makeReply(),
    evidence: [],
    validator: null,
    usage: null,
    createdAt: NOW,
    completedAt: NOW,
    blocked: null,
    channel: 'voice',
    author: null,
    myFeedback: null,
    ...overrides,
  };
}

const text = new TextEncoder();

export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = 'blob';
  sent: Uint8Array[] = [];
  closedWith: number | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error('send() before open');
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closedWith = code ?? 1000;
    this.readyState = 3;
    this.onclose?.({ code: this.closedWith, wasClean: true } as CloseEvent);
  }

  // Test controls ------------------------------------------------------------------------------------

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  serverSend(bytes: Uint8Array): void {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.onmessage?.({ data: buffer } as MessageEvent);
  }

  serverDrop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, wasClean: false } as CloseEvent);
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('No socket was opened');
    return socket;
  }
}

/** A Transcribe `TranscriptEvent` as AWS frames it. */
export function transcriptEvent(
  resultId: string,
  transcript: string,
  options: { partial?: boolean; stable?: boolean } = {},
): Uint8Array {
  const partial = options.partial ?? true;
  const stable = options.stable ?? !partial;
  const items = transcript
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ Content: word, Type: 'pronunciation', Stable: stable }));
  const payload = {
    Transcript: {
      Results: [
        {
          ResultId: resultId,
          IsPartial: partial,
          StartTime: 0,
          EndTime: 1,
          Alternatives: [{ Transcript: transcript, Items: items }],
        },
      ],
    },
  };
  return encodeMessage(
    { ':content-type': 'application/json', ':event-type': 'TranscriptEvent', ':message-type': 'event' },
    text.encode(JSON.stringify(payload)),
  );
}

export function exceptionEvent(type: string, message: string): Uint8Array {
  return encodeMessage(
    { ':content-type': 'application/json', ':exception-type': type, ':message-type': 'exception' },
    text.encode(JSON.stringify({ Message: message })),
  );
}

// Microphone ------------------------------------------------------------------------------------------

/** A microphone track: `enabled`, `stop()` and the events a browser fires on it (`ended`, `mute`, `unmute`). */
export class FakeTrack extends EventTarget {
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = 'live';
  stopped = 0;
  stop = (): void => {
    this.stopped += 1;
    this.readyState = 'ended';
  };
  /** Test control: the device was unplugged or its permission revoked. */
  unplug(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
  /** Test control: the system muted or unmuted the source (another app took it, an OS mute). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
  }
}

/** A one-track microphone stream. */
export function fakeMicStream(track = new FakeTrack()): { track: FakeTrack; stream: MediaStream } {
  return {
    track,
    stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
  };
}

// Web Audio --------------------------------------------------------------------------------------------

export class FakeAudioParam {
  value = 1;
  setTargetAtTime(value: number): void {
    this.value = value;
  }
  cancelScheduledValues(): void {
    /* no automation in the fake */
  }
}

export class FakeNode {
  connections: FakeNode[] = [];
  connect<T extends FakeNode>(node: T): T {
    this.connections.push(node);
    return node;
  }
  disconnect(): void {
    this.connections = [];
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeAudioParam();
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  level = 0;
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.level);
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onended?.();
  }
  /** Test control: the buffer played to its end. */
  finish(): void {
    this.onended?.();
  }
}

export class FakeWorkletNode extends FakeNode {
  readonly port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (_message: unknown) => undefined,
  };
  emit(pcm: Int16Array, rms: number): void {
    this.port.onmessage?.({ data: { pcm: pcm.buffer, rms } } as MessageEvent);
  }
}

export class FakeAudioContext {
  state: AudioContextState = 'running';
  /** Test control: false keeps the context suspended on resume() (a browser waiting for a gesture). */
  resumeAllowed = true;
  private readonly stateListeners = new Set<() => void>();
  currentTime = 0;
  readonly destination = new FakeNode();
  readonly sources: FakeBufferSource[] = [];
  readonly worklets: FakeWorkletNode[] = [];
  readonly analysers: FakeAnalyser[] = [];
  readonly modules: string[] = [];
  decodeFails = false;
  closed = false;
  readonly audioWorklet = {
    addModule: (url: string): Promise<void> => {
      this.modules.push(url);
      return Promise.resolve();
    },
  };

  createGain(): FakeGain {
    return new FakeGain();
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  createMediaStreamSource(): FakeNode {
    return new FakeNode();
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    if (this.decodeFails) return Promise.reject(new Error('decode failed'));
    return Promise.resolve({ duration: data.byteLength / 1000, length: data.byteLength } as AudioBuffer);
  }
  resume(): Promise<void> {
    if (this.resumeAllowed) this.setState('running');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.setState('closed');
    return Promise.resolve();
  }
  addEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.add(listener);
  }
  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.delete(listener);
  }
  /** Test control: the browser changed the context's state (fires `statechange`). */
  setState(state: AudioContextState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of [...this.stateListeners]) listener();
  }
  createWorkletNode(): FakeWorkletNode {
    const node = new FakeWorkletNode();
    this.worklets.push(node);
    return node;
  }
}

// Speech synthesis -----------------------------------------------------------------------------------

export class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = '';
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  constructor(readonly text: string) {}
}

/** A browser voice as `getVoices()` lists it. */
export function fakeVoice(name: string, localService: boolean, lang = 'en-US'): SpeechSynthesisVoice {
  return { name, lang, localService, default: false, voiceURI: name };
}

export class FakeSpeechSynthesis {
  spoken: FakeUtterance[] = [];
  cancelled = 0;
  /** The device's voices (default: one local English voice; online voices are never used). */
  voices: SpeechSynthesisVoice[] = [fakeVoice('Samantha', true)];
  speak(utterance: FakeUtterance): void {
    this.spoken.push(utterance);
  }
  cancel(): void {
    this.cancelled += 1;
    const current = this.spoken.at(-1);
    current?.onerror?.();
  }
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }
  /** Test control: the current utterance finished. */
  finish(): void {
    this.spoken.at(-1)?.onend?.();
  }
}

/** Resolves after pending promise callbacks (microtasks) have run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
