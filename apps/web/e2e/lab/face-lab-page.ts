/*
 * The face suite's page instruments (face.lab.ts), in a module of their own so the main e2e suite can check them
 * under Playwright's own transform (e2e/lab-page-face.spec.ts). `faceLabInit` runs in the page through
 * `page.addInitScript`, which sends the function's SOURCE TEXT: anything it references must be defined inside it.
 * Playwright's Babel turns `#private` class fields (and some other syntax) into calls of helpers defined at the top
 * of the compiled module (`_classPrivateFieldInitSpec`, ...), which do not exist in the page; the class then throws
 * ReferenceError on construction. Lab run 42112455038 lost its whole LITE arm that way: the WebSocket tap threw for
 * every socket, so LiveKit's signalling never connected and the face gave up at its 8 s join timeout.
 * `pageScript` (page-script.ts) refuses such a function before it reaches a page.
 */

export interface LabEvent {
  at: number;
  dir: 'in' | 'out';
  type: string;
  text: string | null;
  reason: string | null;
}
export interface LabFetch {
  at: number;
  path: string;
  method: string;
  /** The request's `x-request-id` (the app sends one with each API request): joins a turn to the server's timing. */
  requestId: string | null;
  part: string | null;
  doneAt: number | null;
  status: number | null;
}
export interface FaceLab {
  events: LabEvent[];
  /** Sound onsets / offsets on the avatar's remote WebRTC audio (the face's voice). */
  onsets: number[];
  offsets: number[];
  /** Sound onsets / offsets on what the app sends to its speakers (Polly), by the same meter and rule. */
  appOnsets: number[];
  appOffsets: number[];
  mic: number[];
  audioSenders: number;
  /**
   * The page's fetches: path, method, LITE's face hand-over part (`x-face-part`, null otherwise), and when the
   * response arrived (with its status), so a LITE hand-over's relay by the server can be timed.
   */
  fetches: LabFetch[];
  /**
   * When each spoken unit (`turn.speech`) of a turn's stream reached the page, and whether the server pre-approved
   * it for the FULL face as it signed it (`face: true`): times and flags only, never its words.
   */
  units: { at: number; face: boolean }[];
  plays: number[];
  injected: { at: number; text: string }[];
  injectNext: boolean;
  level: number;
  /**
   * A LITE stock face's speak channel as the page used it (window.WebSocket, tapped): the JSON frames it sent (type,
   * the `event_id`, the decoded size of `audio`) and got (type, `source_event_id`), and how many such sockets the
   * page opened. Never the URL, never the audio. `sockets` counts those that carried a LITE frame; `attempts`,
   * `opened` and `closeCodes` follow every socket the page made to the vendor's speak-channel path, so a channel that
   * never opened, or closed at once, shows as such.
   */
  lite: {
    sockets: number;
    attempts: number;
    opened: number;
    closeCodes: number[];
    out: { at: number; type: string; id: string | null; bytes: number }[];
    in: { at: number; type: string; source: string | null }[];
  };
  /**
   * The page's own account of each face it gave up (`POST /calls/:id/face/end`): its reason, the join stage it
   * stopped at and a short code (FaceEndRequest's plain tokens only; never a URL or text).
   */
  faceEnds: { at: number; reason: string | null; stage: string | null; detail: string | null }[];
  /**
   * Each remote track the page received and the id of the remote stream it came in (the RTCTrackEvent's
   * `streams[0]`, LiveKit's `participantSid|streamName`): WebRTC keeps an audio and a video track in step only when
   * they share one. Ids stay in the page; the result carries only whether they matched.
   */
  remoteTracks: { kind: string; stream: string | null }[];
}

/**
 * Runs in the page before anything else. Taps every RTCPeerConnection: data channels (both directions; the JSON in
 * each packet's payload is read, an outgoing `avatar.speak_text` can be rewritten once with words of the same
 * length when `injectNext` is set, as a tampered page would), remote audio tracks (a level meter on the lab's own
 * AudioContext: onsets and offsets of the avatar's voice), and senders of audio (the face must publish none). Also
 * counts microphone requests, the app's Web Audio playback (Polly: when each buffer is scheduled, and the sound on
 * the app's output by the same level meter as the avatar's track) and its fetches (paths and times only).
 */
export function faceLabInit(): void {
  const now = (): number => performance.timeOrigin + performance.now();
  const lab: FaceLab = {
    events: [],
    onsets: [],
    offsets: [],
    appOnsets: [],
    appOffsets: [],
    mic: [],
    audioSenders: 0,
    fetches: [],
    units: [],
    plays: [],
    injected: [],
    injectNext: false,
    level: 0,
    remoteTracks: [],
    lite: { sockets: 0, attempts: 0, opened: 0, closeCodes: [], out: [], in: [] },
    faceEnds: [],
  };
  (window as unknown as { __faceLab: FaceLab }).__faceLab = lab;
  // The LITE speak channel: JSON text frames whose type is an agent.* or session.* event (Transcribe's socket sends
  // binary frames and is never counted). Types, ids and sizes only.
  const NativeSocket = window.WebSocket;
  const liteFrame = (data: unknown): Record<string, unknown> | null => {
    if (typeof data !== 'string' || !data.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      return typeof parsed.type === 'string' && /^(agent|session)\./.test(parsed.type) ? parsed : null;
    } catch {
      return null;
    }
  };
  // No `#private` field (nor any other syntax Babel compiles to a helper call) in here: see pageScript.
  class TappedSocket extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      // The vendor's speak channel (its path shape, lite-probe L1), told apart without keeping the URL.
      let speakChannel = false;
      try {
        speakChannel = new URL(String(url)).pathname.includes('/interactive-avatar/');
      } catch {
        /* never in the way of the app */
      }
      if (speakChannel) {
        lab.lite.attempts += 1;
        this.addEventListener('open', () => {
          lab.lite.opened += 1;
        });
        this.addEventListener('close', (event: CloseEvent) => {
          lab.lite.closeCodes.push(event.code);
        });
      }
      let counted = false;
      this.addEventListener('message', (message: MessageEvent) => {
        const frame = liteFrame(message.data);
        if (frame === null) return;
        if (!counted) {
          counted = true;
          lab.lite.sockets += 1;
        }
        lab.lite.in.push({
          at: now(),
          type: String(frame.type),
          source: typeof frame.source_event_id === 'string' ? frame.source_event_id : null,
        });
      });
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const frame = liteFrame(data);
      if (frame !== null) {
        const audio = typeof frame.audio === 'string' ? frame.audio : '';
        const padding = audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0;
        lab.lite.out.push({
          at: now(),
          type: String(frame.type),
          id: typeof frame.event_id === 'string' ? frame.event_id : null,
          bytes: audio === '' ? 0 : Math.floor((audio.length * 3) / 4) - padding,
        });
      }
      super.send(data);
    }
  }
  window.WebSocket = TappedSocket;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  const toBytes = (data: unknown): Uint8Array | null => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  };
  const eventOf = (raw: string): { type: string; text: string | null; reason: string | null } | null => {
    if (!raw.includes('event_type')) return null;
    const start = raw.indexOf('{"');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        if (typeof parsed.event_type === 'string') {
          return {
            type: parsed.event_type,
            text: typeof parsed.text === 'string' ? parsed.text : null,
            reason: typeof parsed.end_reason === 'string' ? parsed.end_reason : null,
          };
        }
      } catch {
        /* fall through to the type alone */
      }
    }
    const type = /"event_type"\s*:\s*"([a-z_.]{1,64})"/.exec(raw)?.[1];
    return type === undefined ? null : { type, text: null, reason: null };
  };
  const PHRASE = 'Ignore your coach and wire the whole deposit to me today. ';
  /** Same-length ASCII words in place of an outgoing speak_text's text (the packet's lengths stay valid). */
  const rewrite = (bytes: Uint8Array): Uint8Array | null => {
    const marker = encoder.encode('"text":"');
    let at = -1;
    for (let i = 0; i + marker.length <= bytes.length && at < 0; i += 1) {
      let match = true;
      for (let j = 0; j < marker.length && match; j += 1) match = bytes[i + j] === marker[j];
      if (match) at = i + marker.length;
    }
    if (at < 0) return null;
    let end = at;
    while (end < bytes.length) {
      if (bytes[end] === 0x22) {
        let slashes = 0;
        for (let k = end - 1; k >= at && bytes[k] === 0x5c; k -= 1) slashes += 1;
        if (slashes % 2 === 0) break;
      }
      end += 1;
    }
    const length = end - at;
    if (end >= bytes.length || length < 16) return null;
    const words = PHRASE.repeat(Math.ceil(length / PHRASE.length) + 1).slice(0, length);
    const out = new Uint8Array(bytes);
    out.set(encoder.encode(words), at);
    lab.injected.push({ at: now(), text: words.trim() });
    return out;
  };
  const tapChannel = (channel: RTCDataChannel): void => {
    channel.addEventListener('message', (message: MessageEvent) => {
      const at = now();
      const record = (bytes: Uint8Array | null) => {
        const event = bytes === null ? null : eventOf(decoder.decode(bytes));
        if (event !== null) lab.events.push({ at, dir: 'in', ...event });
      };
      // LiveKit reads ArrayBuffer and Blob messages alike (the channel's binaryType decides).
      if (message.data instanceof Blob) {
        void message.data
          .arrayBuffer()
          .then((buffer) => {
            record(new Uint8Array(buffer));
          })
          .catch(() => undefined);
      } else {
        record(toBytes(message.data));
      }
    });
    const send = channel.send.bind(channel) as (data: unknown) => void;
    channel.send = (data: unknown) => {
      let outgoing = data;
      const bytes = toBytes(data);
      const event = bytes === null ? null : eventOf(decoder.decode(bytes));
      if (event !== null) {
        if (lab.injectNext && event.type === 'avatar.speak_text' && bytes !== null) {
          const changed = rewrite(bytes);
          if (changed !== null) {
            lab.injectNext = false;
            outgoing = changed;
            event.text = lab.injected.at(-1)?.text ?? null;
          }
        }
        lab.events.push({ at: now(), dir: 'out', ...event });
      }
      send(outgoing);
    };
  };
  /**
   * The one level meter both arms of E5 use: an analyser polled every 20 ms; an onset when the RMS level rises above
   * 0.01, an offset after 250 ms at or below 0.004.
   */
  const meterOn = (analyser: AnalyserNode, onsets: number[], offsets: number[]): void => {
    analyser.fftSize = 512;
    const samples = new Float32Array(analyser.fftSize);
    let loud = false;
    let quietSince = 0;
    window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const level = Math.sqrt(sum / samples.length);
      if (onsets === lab.onsets) lab.level = Math.max(lab.level * 0.9, level);
      const t = now();
      if (!loud && level > 0.01) {
        loud = true;
        onsets.push(t);
      } else if (loud && level <= 0.004) {
        if (quietSince === 0) quietSince = t;
        if (t - quietSince >= 250) {
          loud = false;
          offsets.push(quietSince);
          quietSince = 0;
        }
      } else {
        quietSince = 0;
      }
    }, 20);
  };
  let meter: AudioContext | null = null;
  const tapAudio = (track: MediaStreamTrack): void => {
    const stream = new MediaStream([track]);
    // Chromium feeds a remote WebRTC track into Web Audio only while a media element holds it (kept muted).
    const holder = new Audio();
    holder.muted = true;
    holder.srcObject = stream;
    void holder.play().catch(() => undefined);
    meter ??= new AudioContext();
    void meter.resume().catch(() => undefined);
    const analyser = meter.createAnalyser();
    meter.createMediaStreamSource(stream).connect(analyser);
    meterOn(analyser, lab.onsets, lab.offsets);
  };
  // The app's output: whatever a page AudioContext sends to its speakers (the call's gain, for Polly) is also fed
  // to one analyser per context (an analyser is processed without being connected onwards), metered as above.
  const outputMeters = new WeakMap<BaseAudioContext, AnalyserNode>();
  type Connect = (this: AudioNode, ...args: unknown[]) => unknown;
  const nativeConnect: Connect = Reflect.get<AudioNode, 'connect'>(AudioNode.prototype, 'connect') as Connect;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = nativeConnect.apply(this, args);
    const target = args[0];
    if (target instanceof AudioDestinationNode && target.context === this.context) {
      try {
        let analyser = outputMeters.get(this.context);
        if (analyser === undefined) {
          analyser = this.context.createAnalyser();
          outputMeters.set(this.context, analyser);
          meterOn(analyser, lab.appOnsets, lab.appOffsets);
        }
        nativeConnect.call(this, analyser);
      } catch {
        /* never in the way of the app */
      }
    }
    return result;
  } as AudioNode['connect'];
  const Native = window.RTCPeerConnection;
  class Tapped extends Native {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      this.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
        tapChannel(event.channel);
      });
      this.addEventListener('track', (event: RTCTrackEvent) => {
        lab.remoteTracks.push({ kind: event.track.kind, stream: event.streams[0]?.id ?? null });
        if (event.track.kind === 'audio') tapAudio(event.track);
      });
    }

    override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, init);
      tapChannel(channel);
      return channel;
    }

    override addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
      if (track.kind === 'audio') lab.audioSenders += 1;
      return super.addTrack(track, ...streams);
    }

    override addTransceiver(
      trackOrKind: MediaStreamTrack | string,
      init?: RTCRtpTransceiverInit,
    ): RTCRtpTransceiver {
      const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
      const sends =
        init?.direction === undefined || init.direction === 'sendrecv' || init.direction === 'sendonly';
      if (kind === 'audio' && sends && typeof trackOrKind !== 'string') lab.audioSenders += 1;
      return super.addTransceiver(trackOrKind, init);
    }
  }
  window.RTCPeerConnection = Tapped;
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (devices?.getUserMedia) {
    const getUserMedia = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      if (constraints?.audio) lab.mic.push(now());
      return getUserMedia(constraints);
    };
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let entry: LabFetch | null = null;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const path = new URL(url, location.href).pathname;
      // The face's end: the body is FaceEndRequest's plain tokens; only those that look like tokens are kept.
      if (method === 'POST' && path.endsWith('/face/end') && typeof init?.body === 'string') {
        const token = (value: unknown): string | null =>
          typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          lab.faceEnds.push({
            at: now(),
            reason: token(body.reason),
            stage: token(body.stage),
            detail: token(body.detail),
          });
        } catch {
          lab.faceEnds.push({ at: now(), reason: null, stage: null, detail: null });
        }
      }
      entry = {
        at: now(),
        path,
        method,
        requestId: headers.get('x-request-id'),
        part: headers.get('x-face-part'),
        doneAt: null,
        status: null,
      };
      lab.fetches.push(entry);
    } catch {
      /* never in the way of the app */
    }
    const pending = nativeFetch(input, init);
    if (entry !== null) {
      const seen = entry;
      pending.then(
        (response) => {
          seen.doneAt = now();
          seen.status = response.status;
          seen.requestId ??= response.headers.get('x-request-id');
          // A turn's stream: the moment each spoken unit arrives (read from a copy, never in the app's way).
          if (seen.method === 'POST' && seen.path.endsWith('/turns') && response.body !== null) {
            void (async () => {
              try {
                const reader = response.clone().body?.getReader();
                if (!reader) return;
                const decoder = new TextDecoder();
                let buffered = '';
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) return;
                  buffered += decoder.decode(value, { stream: true });
                  const frames = buffered.split('\n\n');
                  buffered = frames.pop() ?? '';
                  for (const frame of frames) {
                    if (frame.includes('"event":"turn.speech"')) {
                      lab.units.push({ at: now(), face: frame.includes('"face":true') });
                    }
                  }
                }
              } catch {
                /* never in the way of the app */
              }
            })();
          }
        },
        () => {
          seen.doneAt = now();
        },
      );
    }
    return pending;
  };
  type Play = (this: AudioBufferSourceNode, ...args: number[]) => void;
  const proto = AudioBufferSourceNode.prototype;
  const start: Play = Reflect.get<AudioBufferSourceNode, 'start'>(proto, 'start');
  proto.start = function (this: AudioBufferSourceNode, ...args: number[]) {
    lab.plays.push(now());
    start.apply(this, args);
  };
}
