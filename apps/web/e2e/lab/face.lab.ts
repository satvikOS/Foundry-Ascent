import { join } from 'node:path';

import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import type * as LiveKit from 'livekit-client';

import { FOUNDER_STATE, OWNER_STATE, setFacesEnabled, test } from '../support/fixtures';
import {
  REPO,
  WRITE_HEADERS,
  acknowledgeNotices,
  appWithinBudget,
  callScreen,
  errorName,
  hangUp,
  startCall,
  typeOnCall,
  writePrivate,
} from './lab-support';

/*
 * Face suite of the conversation lab (docs/runbooks/conversation-lab.md, plan E "sandbox" checks): the HeyGen
 * LiveAvatar FULL stock face against the vendor's free SANDBOX (the Wayne avatar, sessions of about a minute, no
 * credits), headless and silent (`--disable-audio-output`). The local API holds the vendor key (the lab passes it
 * to that process only); this spec never sees it.
 *
 *   probe      raw sandbox rooms opened through the dev server's lab probe (LAB_FACE_PROBE_TOKEN): this page joins
 *              them with livekit-client and commands the avatar itself, to measure what the vendor does with
 *              `avatar.speak_text` (exact words, queue or cut, timing), `avatar.interrupt`, `avatar.speak_response`
 *              in restricted mode, which tokens may publish, the transcript endpoint, and how sessions end.
 *   call       a real call as the seeded founder, a platform admin of the synthetic venture: the stock face opens
 *              labelled "AI avatar", says the vEIR's admitted units, never asks for the microphone, and the call
 *              falls back to the presence when the sandbox session ends.
 *   injection  a tampered page rewrites the words of one `avatar.speak_text` after the server admitted them: the
 *              server's transcript check must end the face within a heartbeat (`call.face_injection`).
 *   polly      the same typed turn on a call without a face (Amazon Polly only): the A/B arm for first audio.
 *   call LITE  the same call arm with the app's face in LITE mode (the avatar lip-syncs the call's own Polly audio,
 *              which the page hands back to the server and the server relays over the speak socket), for the
 *              FULL / LITE / Polly comparison. The lab restarts the API in LITE for it (LAB_FACE_APP_MODE=lite)
 *              after the FULL pass, or runs only LITE (then the FULL-only tests skip).
 *
 * Every page records the vendor's room events by tapping the page's own WebRTC data channels (the JSON inside each
 * packet), the avatar's audio level, microphone requests and fetches, with the page clock. Words and texts go to
 * the private folder (sealed); ops/lab conversation_lab/face.py turns the files into public numbers.
 */

const PROBE_TOKEN = process.env.LAB_FACE_PROBE_TOKEN ?? '';
/** `heygen` (the vendor sandbox, the lab on GitHub) or `stand-in` (the mock dry run: the development face). */
const FACE = process.env.LAB_FACE_VENDOR === 'heygen' ? 'heygen' : 'stand-in';
const API = process.env.E2E_API_URL ?? 'http://localhost:8787';
/** The app's face mode in this pass (the lab sets MEDIA_FACE_MODE on the API to match): `full` or `lite`. */
const APP_MODE = process.env.LAB_FACE_APP_MODE === 'lite' ? 'lite' : 'full';
const LIVEKIT_UMD = join(
  REPO,
  'apps',
  'web',
  'node_modules',
  'livekit-client',
  'dist',
  'livekit-client.umd.js',
);
const HEARTBEAT_SECONDS = 15;
/** How long a turn waits for the first sound: the vendor, or the stand-in (which makes none) in a dry run. */
const FIRST_SOUND_MS = FACE === 'heygen' ? 45_000 : 8_000;

/** Founder lines (synthetic): one per measured turn. */
const LINES = [
  'What is the one thing I should test first with the clinic pilot?',
  'How would I know in two weeks whether that test worked?',
];
/** Words the probe asks the avatar to say (synthetic). */
const PROBE_TEXT = {
  exact: 'This is the first lab check, said exactly as written.',
  queue: ['First of three.', 'Second of three.', 'Third of three.'],
  long:
    'This is a long sentence for the interrupt check, and it keeps going for a while so that there is ' +
    'plenty of time to cut it off part of the way through, well before its natural end arrives.',
  queued: 'If you hear this, the interrupt did not clear the queue.',
  response: 'What is your name, and what do you do?',
};

// ---- page instruments --------------------------------------------------------------------------------------

interface LabEvent {
  at: number;
  dir: 'in' | 'out';
  type: string;
  text: string | null;
  reason: string | null;
}
interface LabFetch {
  at: number;
  path: string;
  method: string;
  part: string | null;
  doneAt: number | null;
  status: number | null;
}
interface FaceLab {
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
   * Each remote track the page received and the id of the remote stream it came in (the RTCTrackEvent's
   * `streams[0]`, LiveKit's `participantSid|streamName`): WebRTC keeps an audio and a video track in step only when
   * they share one. Ids stay in the page; the result carries only whether they matched.
   */
  remoteTracks: { kind: string; stream: string | null }[];
}

/**
 * Whether the page's remote audio and video arrived in one remote stream: true when an audio and a video track share
 * a stream id, false when both kinds came but never together, null when one kind is missing (nothing to compare).
 */
function sameStream(tracks: readonly { kind: string; stream: string | null }[]): boolean | null {
  const ids = (kind: string) =>
    new Set(tracks.filter((t) => t.kind === kind && t.stream !== null).map((t) => t.stream));
  const audio = ids('audio');
  const video = ids('video');
  if (audio.size === 0 || video.size === 0) return null;
  return [...audio].some((id) => video.has(id));
}

/**
 * Runs in the page before anything else. Taps every RTCPeerConnection: data channels (both directions; the JSON in
 * each packet's payload is read, an outgoing `avatar.speak_text` can be rewritten once with words of the same
 * length when `injectNext` is set, as a tampered page would), remote audio tracks (a level meter on the lab's own
 * AudioContext: onsets and offsets of the avatar's voice), and senders of audio (the face must publish none). Also
 * counts microphone requests, the app's Web Audio playback (Polly: when each buffer is scheduled, and the sound on
 * the app's output by the same level meter as the avatar's track) and its fetches (paths and times only).
 */
function faceLabInit(): void {
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
  };
  (window as unknown as { __faceLab: FaceLab }).__faceLab = lab;
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
      entry = {
        at: now(),
        path: new URL(url, location.href).pathname,
        method,
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

function readLab(page: Page): Promise<FaceLab> {
  return page.evaluate(() => (window as unknown as { __faceLab: FaceLab }).__faceLab);
}

function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

const inEvents = (lab: FaceLab, type: string, after = 0): LabEvent[] =>
  lab.events.filter((e) => e.dir === 'in' && e.type === type && e.at >= after);
const outEvents = (lab: FaceLab, type: string, after = 0): LabEvent[] =>
  lab.events.filter((e) => e.dir === 'out' && e.type === type && e.at >= after);
const firstAfter = (times: readonly number[], after: number): number | null =>
  times.find((t) => t >= after) ?? null;
const ms = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : Math.round(to - from);

/** Normalised words (case, punctuation and spacing aside) for comparing what was sent with what was said. */
function words(text: string | null): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The LITE face hand-overs the page POSTed (`/calls/:id/face/speak`), each a part of a unit's audio. */
const speakPosts = (lab: FaceLab, after = 0): LabFetch[] =>
  lab.fetches.filter((f) => f.method === 'POST' && f.path.endsWith('/face/speak') && f.at >= after);

/**
 * Waits (polling the page) until the face said everything it started and has been quiet for `quietMs`. A LITE face
 * (`pairedEvents: false`) need not pair its room events (the vendor's LITE events reach the server's socket; the room
 * may carry some or none): its quiet is no sound on the face's track or the app's output (no onset without its
 * offset) and no hand-over still waiting for the server.
 */
async function waitForFaceQuiet(
  page: Page,
  { quietMs = 1200, timeoutMs = 30_000, pairedEvents = true } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lab = await readLab(page);
    const t = await pageNow(page);
    const started = inEvents(lab, 'avatar.speak_started').length;
    const ended = inEvents(lab, 'avatar.speak_ended').length;
    const last = Math.max(
      0,
      ...lab.events.map((e) => e.at),
      ...lab.plays,
      ...lab.appOnsets,
      ...lab.appOffsets,
      ...(pairedEvents ? [] : [...lab.onsets, ...lab.offsets]),
    );
    const busy = pairedEvents
      ? started > ended
      : lab.onsets.length > lab.offsets.length ||
        lab.appOnsets.length > lab.appOffsets.length ||
        speakPosts(lab).some((f) => f.doneAt === null);
    if (!busy && t - last > quietMs) return;
    await page.waitForTimeout(200);
  }
}

// ---- the vendor probe -------------------------------------------------------------------------------------

/**
 * A blank page on the local API's origin (a secure context: localhost), served by the test itself (the API's own
 * responses forbid scripts), with the instruments and livekit-client loaded.
 */
async function openBlankPage(page: Page): Promise<void> {
  const blank = `${API}/__lab/face-probe`;
  await page.route(blank, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>lab</title><body></body>',
    }),
  );
  await page.goto(blank);
  await page.addScriptTag({ path: LIVEKIT_UMD });
}

async function probeApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: { 'x-lab-probe-token': PROBE_TOKEN },
  });
}

interface ProbeSession {
  sessionId: string;
  url: string;
  token: string;
}

async function openProbeSession(
  api: APIRequestContext,
  mode: 'full' | 'lite',
  maxSeconds: number,
): Promise<ProbeSession> {
  const response = await api.post('/api/v1/_lab/face/sessions', { data: { mode, maxSeconds } });
  expect(response.status(), `probe session (${mode})`).toBe(201);
  return (await response.json()) as ProbeSession;
}

async function stopProbeSession(api: APIRequestContext, session: ProbeSession): Promise<void> {
  await api.post(`/api/v1/_lab/face/sessions/${session.sessionId}/stop`).catch(() => undefined);
}

interface ProbeRoom {
  connectedMs: number | null;
  firstVideoMs: number | null;
  canPublishData: boolean | null;
  error: string | null;
}

/** Joins a probe session's room from the probe page with livekit-client (receive only; data commands). */
async function joinProbeRoom(page: Page, session: ProbeSession): Promise<ProbeRoom> {
  return page.evaluate(
    async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
      const w = window as unknown as {
        __probeRoom?: LiveKit.Room;
      };
      const now = (): number => performance.timeOrigin + performance.now();
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      w.__probeRoom = room;
      const begun = now();
      const seen: { firstVideo: number | null } = { firstVideo: null };
      const video = new Promise<void>((resolve) => {
        room.on(LK.RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === LK.Track.Kind.Video && seen.firstVideo === null) {
            seen.firstVideo = now();
            resolve();
          }
        });
      });
      try {
        await room.connect(url, token, { autoSubscribe: true });
        const connected = now();
        await Promise.race([video, new Promise((resolve) => setTimeout(resolve, 15_000))]);
        const permissions = room.localParticipant.permissions;
        return {
          connectedMs: Math.round(connected - begun),
          firstVideoMs: seen.firstVideo === null ? null : Math.round(seen.firstVideo - begun),
          canPublishData: permissions === undefined ? null : permissions.canPublishData,
          error: null,
        };
      } catch (err) {
        return {
          connectedMs: null,
          firstVideoMs: null,
          canPublishData: null,
          error: err instanceof Error ? err.name : 'error',
        };
      }
    },
    { url: session.url, token: session.token },
  );
}

/** Sends one command to the avatar from the probe page; returns the page time it went out. */
function command(page: Page, eventType: string, text?: string): Promise<number> {
  return page.evaluate(
    async ({ eventType, text }) => {
      const room = (window as unknown as { __probeRoom: LiveKit.Room }).__probeRoom;
      const payload = new TextEncoder().encode(
        JSON.stringify({ event_id: crypto.randomUUID(), event_type: eventType, ...(text ? { text } : {}) }),
      );
      const at = performance.timeOrigin + performance.now();
      await room.localParticipant.publishData(payload, { reliable: true, topic: 'agent-control' });
      return at;
    },
    { eventType, text: text ?? '' },
  );
}

async function leaveProbeRoom(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const w = window as unknown as { __probeRoom?: LiveKit.Room };
      await w.__probeRoom?.disconnect();
      w.__probeRoom = undefined;
    })
    .catch(() => undefined);
}

/** Polls the page until `done(lab)` or `timeoutMs`; returns whether it held. */
async function until(page: Page, done: (lab: FaceLab) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(await readLab(page))) return true;
    await page.waitForTimeout(100);
  }
  return done(await readLab(page));
}

// ---- the app's call ---------------------------------------------------------------------------------------

async function ownerApi(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, storageState: OWNER_STATE });
}

/** The ids of the audit events with `action` (newest first; null when the listing failed). */
async function auditIds(baseURL: string, action: string): Promise<number[] | null> {
  const owner = await ownerApi(baseURL);
  try {
    const response = await owner.get(`/api/v1/admin/audit?action=${encodeURIComponent(action)}&limit=200`);
    if (response.status() !== 200) return null;
    return ((await response.json()) as { items: { id: number }[] }).items.map((item) => item.id);
  } finally {
    await owner.dispose();
  }
}

async function faceSettings(baseURL: string, on: boolean): Promise<void> {
  const owner = await ownerApi(baseURL);
  try {
    const response = await owner.patch('/api/v1/admin/settings', {
      headers: WRITE_HEADERS,
      data: on
        ? { facesEnabled: true, faceMinutesPerCall: 5, faceMinutesPerPrincipalMonth: 120 }
        : { facesEnabled: false },
    });
    expect(response.status(), 'PATCH /admin/settings').toBe(200);
  } finally {
    await owner.dispose();
  }
}

interface FaceSessionSeen {
  provider: string | null;
  voicing: string | null;
  stockFace: boolean | null;
  livekitHost: string | null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function watchAvatarSession(page: Page): FaceSessionSeen[] {
  const seen: FaceSessionSeen[] = [];
  page.on('response', (response) => {
    if (!response.url().endsWith('/api/v1/calls/avatar-session') || !response.ok()) return;
    void response
      .json()
      .then((body: { provider?: string; voicing?: string; stockFace?: boolean; url?: string | null }) => {
        const host = hostOf(body.url ?? null);
        seen.push({
          provider: body.provider ?? null,
          voicing: body.voicing ?? null,
          stockFace: body.stockFace ?? null,
          livekitHost: host,
        });
      })
      .catch(() => undefined);
  });
  return seen;
}

const videoTile = (page: Page) => callScreen(page).locator('[data-slot="call-tile"][data-face="video"]');
const presenceTile = (page: Page) =>
  callScreen(page).locator('[data-slot="call-tile"][data-face="presence"]');

/** Each turn: page time sent, first face speak_started / audio onset / app playback after it, and the units said. */
interface TurnTiming {
  sentAt: number;
  firstSpeakStartedMs: number | null;
  firstFaceAudioMs: number | null;
  /** When the app scheduled its first buffer (before any sound): kept apart from the sound itself. */
  firstAppPlaybackMs: number | null;
  /** The first sound on the app's output, by the same meter as {@link firstFaceAudioMs}. */
  firstAppAudioMs: number | null;
  /** The turn's first hand-over to the face: FULL's `avatar.speak_text` on the room, LITE's `face/speak` POST. */
  firstHandOverMs: number | null;
  /** When the server answered that LITE hand-over (it relayed the audio over the speak socket); null in FULL. */
  firstHandOverDoneMs: number | null;
  /** The turn's first spoken unit (`turn.speech`) reaching the page. */
  firstUnitMs: number | null;
  /**
   * From that unit's arrival to the turn's first hand-over to the face. With FULL face pre-approval the unit is
   * already admitted, so the page hands it over at once: this is the round trip `face/say` used to add.
   */
  unitToHandOverMs: number | null;
}

async function measuredTurn(
  page: Page,
  line: string,
  { pairedEvents = true }: { pairedEvents?: boolean } = {},
): Promise<TurnTiming> {
  const before = await pageNow(page);
  await typeOnCall(page, line);
  // The turn request the call sent (page clock), else when the line was typed.
  let sentAt = before;
  await until(
    page,
    (lab) => lab.fetches.some((f) => f.method === 'POST' && f.path.endsWith('/turns') && f.at >= before),
    5_000,
  );
  const lab0 = await readLab(page);
  sentAt =
    lab0.fetches.find((f) => f.method === 'POST' && f.path.endsWith('/turns') && f.at >= before)?.at ??
    before;
  await until(
    page,
    (lab) =>
      inEvents(lab, 'avatar.speak_started', sentAt).length > 0 ||
      firstAfter(lab.plays, sentAt) !== null ||
      firstAfter(lab.appOnsets, sentAt) !== null,
    FIRST_SOUND_MS,
  );
  await waitForFaceQuiet(page, { timeoutMs: 40_000, pairedEvents });
  const lab = await readLab(page);
  // FULL hands the face words on the room, LITE audio to the server: a call only ever does one of the two.
  const speakText = outEvents(lab, 'avatar.speak_text', sentAt)[0]?.at ?? null;
  const speakPost = speakPosts(lab, sentAt)[0] ?? null;
  const firstUnit = lab.units.find((u) => u.at >= sentAt)?.at ?? null;
  const handOver = speakText ?? speakPost?.at ?? null;
  return {
    sentAt,
    firstSpeakStartedMs: ms(sentAt, inEvents(lab, 'avatar.speak_started', sentAt)[0]?.at ?? null),
    firstFaceAudioMs: ms(sentAt, firstAfter(lab.onsets, sentAt)),
    firstAppPlaybackMs: ms(sentAt, firstAfter(lab.plays, sentAt)),
    firstAppAudioMs: ms(sentAt, firstAfter(lab.appOnsets, sentAt)),
    firstHandOverMs: ms(sentAt, handOver),
    firstHandOverDoneMs: ms(sentAt, speakPost?.doneAt ?? null),
    firstUnitMs: ms(sentAt, firstUnit),
    unitToHandOverMs: ms(firstUnit, handOver),
  };
}

/** For every speak_text the page published: time to the vendor's next speak_started and to the next audio onset. */
function unitTimings(
  lab: FaceLab,
  after: number,
): { publishToStartedMs: number[]; publishToAudioMs: number[] } {
  const started = inEvents(lab, 'avatar.speak_started', after).map((e) => e.at);
  const publishToStartedMs: number[] = [];
  const publishToAudioMs: number[] = [];
  for (const out of outEvents(lab, 'avatar.speak_text', after)) {
    const s = firstAfter(started, out.at);
    const a = firstAfter(lab.onsets, out.at);
    if (s !== null) publishToStartedMs.push(Math.round(s - out.at));
    if (a !== null) publishToAudioMs.push(Math.round(a - out.at));
  }
  return { publishToStartedMs, publishToAudioMs };
}

/**
 * LITE: for every unit the page handed the server (its first `face/speak` part): time to the next speak_started (when
 * the room carries it), to the next audio onset on the face's track, and to the server's 204 (relayed to the vendor).
 */
function liteUnitTimings(
  lab: FaceLab,
  after: number,
): { handOverToStartedMs: number[]; handOverToAudioMs: number[]; handOverToDoneMs: number[] } {
  const started = inEvents(lab, 'avatar.speak_started', after).map((e) => e.at);
  const handOverToStartedMs: number[] = [];
  const handOverToAudioMs: number[] = [];
  const handOverToDoneMs: number[] = [];
  for (const post of speakPosts(lab, after).filter((f) => f.part === '0')) {
    const s = firstAfter(started, post.at);
    const a = firstAfter(lab.onsets, post.at);
    if (s !== null) handOverToStartedMs.push(Math.round(s - post.at));
    if (a !== null) handOverToAudioMs.push(Math.round(a - post.at));
    if (post.doneAt !== null && post.status === 204) handOverToDoneMs.push(Math.round(post.doneAt - post.at));
  }
  return { handOverToStartedMs, handOverToAudioMs, handOverToDoneMs };
}

// ---- the suite --------------------------------------------------------------------------------------------

// Not serial: one failing test must not skip the others (a single worker runs them in order anyway).
test.describe('Conversation lab · face (HeyGen LiveAvatar FULL and LITE, sandbox)', () => {
  test.use({ storageState: FOUNDER_STATE });

  // The instruments themselves, first and in every run (the dry run included): a loopback data channel in one page
  // carries a packet shaped like LiveKit's (bytes around a JSON payload); the tap must read it in both directions
  // and the injection must rewrite its words in place, same length, so the receiver gets the injected words.
  test('instruments: the page taps read and rewrite a data channel, and livekit-client loads', async ({
    page,
  }) => {
    const result: Record<string, unknown> = {};
    await page.addInitScript(faceLabInit);
    try {
      await openBlankPage(page);
      const loop = await page.evaluate(async () => {
        const lab = (window as unknown as { __faceLab: FaceLab }).__faceLab;
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.addEventListener('icecandidate', (e) => {
          if (e.candidate) void b.addIceCandidate(e.candidate);
        });
        b.addEventListener('icecandidate', (e) => {
          if (e.candidate) void a.addIceCandidate(e.candidate);
        });
        const channel = a.createDataChannel('_reliable');
        const received = new Promise<Uint8Array>((resolve) => {
          b.addEventListener('datachannel', (event) => {
            // The channel's default binaryType, as LiveKit leaves it: the tap reads a Blob or an ArrayBuffer alike.
            event.channel.addEventListener('message', (m: MessageEvent<Blob | ArrayBuffer>) => {
              if (m.data instanceof ArrayBuffer) {
                resolve(new Uint8Array(m.data));
                return;
              }
              void m.data.arrayBuffer().then((buffer) => {
                resolve(new Uint8Array(buffer));
              });
            });
          });
        });
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        await new Promise<void>((resolve) => {
          if (channel.readyState === 'open') resolve();
          channel.addEventListener('open', () => {
            resolve();
          });
        });
        const json = JSON.stringify({
          event_id: 'e-1',
          event_type: 'avatar.speak_text',
          text: 'Admitted words that the server signed off on, \u201cquoted\u201d.',
        });
        const body = new TextEncoder().encode(json);
        const packet = new Uint8Array([
          0x08,
          0x00,
          0x12,
          body.length + 4,
          0x12,
          body.length,
          ...body,
          0x22,
          0x01,
          0x61,
        ]);
        lab.injectNext = true;
        channel.send(packet);
        const got = await Promise.race([
          received,
          new Promise<null>((resolve) =>
            setTimeout(() => {
              resolve(null);
            }, 5000),
          ),
        ]);
        const text = got === null ? '' : new TextDecoder().decode(got);
        // The tap reads a Blob asynchronously: give it a moment.
        await new Promise((resolve) => setTimeout(resolve, 200));
        a.close();
        b.close();
        return {
          delivered: got !== null,
          sameLength: got !== null && got.length === packet.length,
          injectedArrived: text.includes('Ignore your coach'),
          admittedGone: !text.includes('Admitted words'),
          out: lab.events.filter((e) => e.dir === 'out' && e.type === 'avatar.speak_text').length,
          in: lab.events.filter((e) => e.dir === 'in' && e.type === 'avatar.speak_text').length,
          injected: lab.injected.length,
          injectCleared: !lab.injectNext,
          livekit:
            typeof (window as unknown as { LivekitClient?: { Room?: unknown } }).LivekitClient?.Room ===
            'function',
        };
      });
      Object.assign(result, loop);
      // The level meters, which E5 compares across its arms: a tone sent over a loopback WebRTC audio track must
      // give the remote-track meter (the face's voice) an onset, and a tone the page plays to its speakers through
      // Web Audio (as the app plays Polly) must give the app-output meter one. Same meter, same rule, both arms.
      const meters = await page.evaluate(async () => {
        const lab = (window as unknown as { __faceLab: FaceLab }).__faceLab;
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (done: () => boolean, ms: number): Promise<boolean> => {
          const deadline = performance.now() + ms;
          while (!done() && performance.now() < deadline) await wait(50);
          return done();
        };
        const source = new AudioContext();
        await source.resume().catch(() => undefined);
        const tone = source.createOscillator();
        const level = source.createGain();
        level.gain.value = 0.5;
        const out = source.createMediaStreamDestination();
        tone.connect(level);
        level.connect(out);
        tone.start();
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.addEventListener('icecandidate', (e) => {
          if (e.candidate) void b.addIceCandidate(e.candidate);
        });
        b.addEventListener('icecandidate', (e) => {
          if (e.candidate) void a.addIceCandidate(e.candidate);
        });
        const [track] = out.stream.getAudioTracks();
        if (track !== undefined) a.addTrack(track, out.stream);
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        const onsetsBefore = lab.onsets.length;
        const meter = await waitFor(() => lab.onsets.length > onsetsBefore, 8000);
        tone.stop();
        a.close();
        b.close();
        await source.close().catch(() => undefined);

        const speakers = new AudioContext();
        await speakers.resume().catch(() => undefined);
        const buffer = speakers.createBuffer(1, speakers.sampleRate, speakers.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i += 1)
          samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / speakers.sampleRate);
        const gain = speakers.createGain();
        gain.connect(speakers.destination);
        const play = speakers.createBufferSource();
        play.buffer = buffer;
        play.connect(gain);
        const appBefore = lab.appOnsets.length;
        const scheduledAt = performance.timeOrigin + performance.now();
        play.start();
        const appMeter = await waitFor(() => lab.appOnsets.length > appBefore, 4000);
        const heard = lab.appOnsets[appBefore];
        await speakers.close().catch(() => undefined);
        return {
          meter,
          appMeter,
          appScheduledToOnsetMs: heard === undefined ? null : Math.round(heard - scheduledAt),
        };
      });
      Object.assign(result, meters);
    } catch (err) {
      result.error = errorName(err);
    } finally {
      writePrivate('face/instruments.json', result);
    }
    expect(result).toMatchObject({
      delivered: true,
      sameLength: true,
      injectedArrived: true,
      admittedGone: true,
      out: 1,
      in: 1,
      injected: 1,
      injectCleared: true,
      livekit: true,
      meter: true,
      appMeter: true,
    });
  });

  test('probe: the vendor sandbox commanded directly', async ({ page }) => {
    test.skip(FACE !== 'heygen' || PROBE_TOKEN === '', 'needs the vendor sandbox (the lab on GitHub)');
    test.skip(APP_MODE !== 'full', 'the FULL pass only (the app runs its face in LITE)');
    test.setTimeout(6 * 60_000);
    const api = await probeApi();
    const result: Record<string, unknown> = {};
    const texts: Record<string, unknown> = {};
    await page.addInitScript(faceLabInit);
    try {
      await openBlankPage(page);
      // Session A: exact words, back-to-back texts, the transcript endpoint, then idle until the vendor ends it.
      const a = await openProbeSession(api, 'full', 120);
      const openedA = await pageNow(page);
      const roomA = await joinProbeRoom(page, a);
      result.full_room = roomA;
      if (roomA.error === null) {
        const sentExact = await command(page, 'avatar.speak_text', PROBE_TEXT.exact);
        await until(page, (lab) => inEvents(lab, 'avatar.speak_ended', sentExact).length > 0, 20_000);
        let lab = await readLab(page);
        const said = inEvents(lab, 'avatar.transcription', sentExact).map((e) => e.text ?? '');
        result.exact = {
          speak_started: inEvents(lab, 'avatar.speak_started', sentExact).length > 0,
          speak_ended: inEvents(lab, 'avatar.speak_ended', sentExact).length > 0,
          transcriptions: said.length,
          matches: said.some((s) => words(s) === words(PROBE_TEXT.exact)),
          publish_to_started_ms: ms(
            sentExact,
            inEvents(lab, 'avatar.speak_started', sentExact)[0]?.at ?? null,
          ),
          publish_to_audio_ms: ms(sentExact, firstAfter(lab.onsets, sentExact)),
          publish_to_transcription_ms: ms(
            sentExact,
            inEvents(lab, 'avatar.transcription', sentExact)[0]?.at ?? null,
          ),
        };
        texts.exact = { sent: PROBE_TEXT.exact, said };
        await page.waitForTimeout(800);

        const queueFrom = await pageNow(page);
        for (const text of PROBE_TEXT.queue) await command(page, 'avatar.speak_text', text);
        await until(page, (l) => inEvents(l, 'avatar.speak_ended', queueFrom).length >= 3, 25_000);
        await page.waitForTimeout(1500);
        lab = await readLab(page);
        const starts = inEvents(lab, 'avatar.speak_started', queueFrom).map((e) => e.at);
        const ends = inEvents(lab, 'avatar.speak_ended', queueFrom).map((e) => e.at);
        const queueSaid = inEvents(lab, 'avatar.transcription', queueFrom).map((e) => e.text ?? '');
        const inOrder =
          queueSaid.length === 3 && queueSaid.every((s, i) => words(s) === words(PROBE_TEXT.queue[i] ?? ''));
        const overlapping = starts.slice(1).some((s, i) => (ends[i] ?? Infinity) > s);
        result.queue = {
          starts: starts.length,
          ends: ends.length,
          transcriptions: queueSaid.length,
          in_order: inOrder,
          behaviour:
            starts.length === 3 && ends.length === 3 && inOrder && !overlapping
              ? 'queued'
              : starts.length < 3 || ends.length < starts.length || overlapping
                ? 'cut'
                : 'other',
          gaps_ms: starts.slice(1).map((s, i) => ms(ends[i] ?? null, s)),
        };
        texts.queue = { sent: PROBE_TEXT.queue, said: queueSaid };

        const readAt = Date.now();
        const transcript = await api.get(`/api/v1/_lab/face/sessions/${a.sessionId}/transcript`);
        const body =
          transcript.status() === 200
            ? ((await transcript.json()) as { complete: boolean; lines: { role: string; text: string }[] })
            : null;
        const avatarLines = (body?.lines ?? []).filter((l) => l.role === 'avatar').map((l) => l.text);
        result.transcript_endpoint = {
          status: transcript.status(),
          ms: Date.now() - readAt,
          complete: body?.complete ?? null,
          avatar_lines: avatarLines.length,
          user_lines: (body?.lines ?? []).filter((l) => l.role === 'user').length,
          has_exact: avatarLines.some((l) => words(l) === words(PROBE_TEXT.exact)),
          has_all_queue: PROBE_TEXT.queue.every((q) => avatarLines.some((l) => words(l) === words(q))),
        };
        texts.transcript = avatarLines;

        // Idle: no command until the vendor stops the session (the sandbox's own limit, or its idle timeout).
        await until(page, (l) => inEvents(l, 'session.stopped', openedA).length > 0, 100_000);
        lab = await readLab(page);
        const stopped = inEvents(lab, 'session.stopped', openedA)[0] ?? null;
        result.idle_end = {
          stopped: stopped !== null,
          end_reason: stopped?.reason ?? null,
          seconds: stopped === null ? null : Math.round((stopped.at - openedA) / 100) / 10,
        };
        result.full_user_transcriptions = inEvents(lab, 'user.transcription', openedA).length;
      }
      await leaveProbeRoom(page);
      await stopProbeSession(api, a);

      // Session B: interrupt (time to silence, queue cleared), speak_response ignored, and its own max duration.
      const maxB = 30;
      const b = await openProbeSession(api, 'full', maxB);
      const openedB = await pageNow(page);
      const roomB = await joinProbeRoom(page, b);
      result.full_room_b = roomB;
      if (roomB.error === null) {
        const sentLong = await command(page, 'avatar.speak_text', PROBE_TEXT.long);
        await command(page, 'avatar.speak_text', PROBE_TEXT.queued);
        await until(page, (l) => inEvents(l, 'avatar.speak_started', sentLong).length > 0, 15_000);
        await page.waitForTimeout(1500);
        const interruptAt = await command(page, 'avatar.interrupt');
        await until(page, (l) => inEvents(l, 'avatar.speak_ended', interruptAt).length > 0, 8_000);
        await page.waitForTimeout(6000);
        let lab = await readLab(page);
        const queuedSaid = inEvents(lab, 'avatar.transcription', sentLong)
          .map((e) => e.text ?? '')
          .some((s) => words(s) === words(PROBE_TEXT.queued));
        result.interrupt = {
          started_before: inEvents(lab, 'avatar.speak_started', sentLong).some((e) => e.at < interruptAt),
          to_speak_ended_ms: ms(interruptAt, inEvents(lab, 'avatar.speak_ended', interruptAt)[0]?.at ?? null),
          to_silence_ms: ms(interruptAt, firstAfter(lab.offsets, interruptAt)),
          queued_started_after: inEvents(lab, 'avatar.speak_started', interruptAt + 50).length,
          queued_transcribed: queuedSaid,
          queue_cleared: inEvents(lab, 'avatar.speak_started', interruptAt + 50).length === 0,
        };

        const responseAt = await command(page, 'avatar.speak_response', PROBE_TEXT.response);
        await page.waitForTimeout(8000);
        lab = await readLab(page);
        result.speak_response = {
          speak_started: inEvents(lab, 'avatar.speak_started', responseAt).length,
          avatar_transcriptions: inEvents(lab, 'avatar.transcription', responseAt).length,
          ignored:
            inEvents(lab, 'avatar.speak_started', responseAt).length === 0 &&
            inEvents(lab, 'avatar.transcription', responseAt).length === 0,
        };
        texts.speak_response = inEvents(lab, 'avatar.transcription', responseAt).map((e) => e.text);

        await until(page, (l) => inEvents(l, 'session.stopped', openedB).length > 0, (maxB + 45) * 1000);
        lab = await readLab(page);
        const stopped = inEvents(lab, 'session.stopped', openedB)[0] ?? null;
        result.max_duration = {
          requested_seconds: maxB,
          stopped: stopped !== null,
          end_reason: stopped?.reason ?? null,
          seconds: stopped === null ? null : Math.round((stopped.at - openedB) / 100) / 10,
        };
      }
      await leaveProbeRoom(page);
      await stopProbeSession(api, b);

      // Session C: may a LITE room token publish data at all? (FULL's must: commands go over the room.)
      const c = await openProbeSession(api, 'lite', 20);
      const roomC = await joinProbeRoom(page, c);
      result.lite_room = roomC;
      await leaveProbeRoom(page);
      await stopProbeSession(api, c);
      const lab = await readLab(page);
      result.probe_mic_requests = lab.mic.length;
      result.probe_audio_senders = lab.audioSenders;
    } catch (err) {
      result.error = errorName(err);
    } finally {
      writePrivate('face/probe.json', result);
      writePrivate('face/probe-texts.json', texts);
      await api.dispose();
    }
    expect(result.error ?? null, 'probe').toBeNull();
  });

  test('call: the stock face in a call, admins only, labelled, without the microphone', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.skip(APP_MODE !== 'full', 'the FULL pass only (the app runs its face in LITE)');
    test.setTimeout(6 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = { vendor: FACE };
    await page.addInitScript(faceLabInit);
    const sessions = watchAvatarSession(page);
    await faceSettings(baseURL, true);
    let started = false;
    try {
      await acknowledgeNotices(page);
      const call = await startCall(page);
      started = true;
      result.input_mode = call.inputMode;
      await expect(videoTile(page)).toBeVisible({ timeout: 30_000 });
      const live = await pageNow(page);
      const label = videoTile(page).locator('[data-slot="call-ai-avatar-label"]');
      result.label_visible = await label.isVisible();
      result.label_text_ok = ((await label.textContent()) ?? '').trim() === 'AI avatar';
      const micAtLive = (await readLab(page)).mic.length;
      // The greeting (the call's intro), when there is one, is said first.
      await waitForFaceQuiet(page, { timeoutMs: 20_000 });
      const turns: TurnTiming[] = [];
      for (const line of LINES) turns.push(await measuredTurn(page, line));
      let lab = await readLab(page);
      const units = unitTimings(lab, live);
      const sayResponses = lab.fetches.filter((f) => f.path.endsWith('/face/say')).length;
      result.session = sessions[0] ?? null;
      result.turns = turns.map(({ sentAt: _sentAt, ...rest }) => rest);
      result.units = units;
      result.speak_text_sent = outEvents(lab, 'avatar.speak_text', live).length;
      result.say_requests = sayResponses;
      // The reply's units the server pre-approved for the face as it signed them (no face/say for those).
      result.units_streamed = lab.units.filter((u) => u.at >= live).length;
      result.units_preapproved = lab.units.filter((u) => u.at >= live && u.face).length;
      result.app_playbacks_after_live = lab.plays.filter((t) => t >= live).length;
      result.mic_requests_after_live = lab.mic.length - micAtLive;
      result.audio_senders = lab.audioSenders;
      result.user_transcriptions = inEvents(lab, 'user.transcription').length;
      // Whether the avatar's voice and video arrive in one remote stream (WebRTC's lip sync), runbook §8.5.
      result.av_same_stream = sameStream(lab.remoteTracks);
      // The sandbox ends the session by itself (about a minute): the call goes on with the presence, quietly. The
      // stand-in never ends by itself: in the dry run its video track is ended instead (a dropped face).
      if (FACE !== 'heygen') {
        await videoTile(page)
          .locator('video')
          .evaluate((element: HTMLVideoElement) => {
            const stream = element.srcObject as MediaStream;
            for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
          });
      }
      const fellBack = await presenceTile(page)
        .waitFor({ state: 'visible', timeout: 120_000 })
        .then(() => true)
        .catch(() => false);
      const back = await pageNow(page);
      lab = await readLab(page);
      const stopped = inEvents(lab, 'session.stopped', live)[0] ?? null;
      result.fallback = {
        presence_back: fellBack,
        seconds_live: fellBack ? Math.round((back - live) / 100) / 10 : null,
        session_stopped_event: stopped !== null,
        end_reason: stopped?.reason ?? null,
        typed_line_editable: await callScreen(page)
          .getByRole('textbox', { name: /^Reply to / })
          .isEditable()
          .catch(() => false),
      };
      writePrivate('face/call-texts.json', {
        lines: LINES,
        said: outEvents(lab, 'avatar.speak_text', live).map((e) => e.text),
        transcribed: inEvents(lab, 'avatar.transcription', live).map((e) => e.text),
      });
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/call.json', result);
    }
    expect(result.error ?? null, 'call').toBeNull();
    expect(result.label_visible, 'the "AI avatar" label').toBe(true);
    expect(result.mic_requests_after_live, 'microphone requests after the face joined').toBe(0);
  });

  test('injection: words the server never admitted end the face within a heartbeat', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.skip(FACE !== 'heygen', 'the stand-in keeps no transcript (nothing to reconcile)');
    test.skip(APP_MODE !== 'full', 'the FULL pass only (a LITE face renders audio, not words)');
    test.setTimeout(5 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = {};
    await page.addInitScript(faceLabInit);
    await faceSettings(baseURL, true);
    const auditsBefore = new Set((await auditIds(baseURL, 'call.face_injection')) ?? []);
    let started = false;
    try {
      await acknowledgeNotices(page);
      await startCall(page);
      started = true;
      await expect(videoTile(page)).toBeVisible({ timeout: 30_000 });
      const live = await pageNow(page);
      await page.evaluate(() => {
        (window as unknown as { __faceLab: FaceLab }).__faceLab.injectNext = true;
      });
      await typeOnCall(page, LINES[0] ?? '');
      const injected = await until(page, (lab) => lab.injected.length > 0, 60_000);
      let lab = await readLab(page);
      const at = lab.injected[0]?.at ?? null;
      const ended = await presenceTile(page)
        .waitFor({ state: 'visible', timeout: (3 * HEARTBEAT_SECONDS + 15) * 1000 })
        .then(() => true)
        .catch(() => false);
      const back = await pageNow(page);
      lab = await readLab(page);
      const stopped = inEvents(lab, 'session.stopped', live)[0] ?? null;
      // The audits this test caused; the harness reads where each check ran (heartbeat or after the face ended)
      // from the lab's database (lab-face-audits.ts), since the admin listing carries no metadata. Whatever ended
      // the face, `session.stopped` reaches the page first (the page drops the face on it), so its ORDER says
      // nothing; its end_reason and the audits' atEnd do.
      let added: number[] = [];
      const auditDeadline = Date.now() + 20_000;
      while (Date.now() < auditDeadline && added.length === 0) {
        added = ((await auditIds(baseURL, 'call.face_injection')) ?? []).filter(
          (id) => !auditsBefore.has(id),
        );
        if (added.length === 0) await page.waitForTimeout(1000);
      }
      result.injected = injected;
      result.face_ended = ended;
      result.seconds_to_end = ended && at !== null ? Math.round((back - at) / 100) / 10 : null;
      // From the face going live (the video tile shown) to the injection: against the sandbox's ~60 s minute.
      result.seconds_into_session = at === null ? null : Math.round((at - live) / 100) / 10;
      result.heartbeat_seconds = HEARTBEAT_SECONDS;
      result.audit_injection_events = added.length;
      result.audit_ids = added;
      result.end_reason = stopped?.reason ?? null;
      writePrivate('face/injection-texts.json', { injected: lab.injected.map((i) => i.text) });
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/injection.json', result);
    }
    expect(result.error ?? null, 'injection').toBeNull();
  });

  test('polly: the same turns without a face (first audio, the A/B arm)', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.setTimeout(4 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = {};
    await page.addInitScript(faceLabInit);
    await setFacesEnabled(baseURL, false);
    let started = false;
    try {
      await acknowledgeNotices(page);
      await startCall(page);
      started = true;
      await expect(presenceTile(page)).toBeVisible({ timeout: 30_000 });
      await waitForFaceQuiet(page, { timeoutMs: 20_000 });
      const turns: TurnTiming[] = [];
      for (const line of LINES) turns.push(await measuredTurn(page, line));
      result.turns = turns.map(({ sentAt: _sentAt, ...rest }) => rest);
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/polly.json', result);
    }
    expect(result.error ?? null, 'polly').toBeNull();
  });

  // The same call arm with the app's face in LITE (the lab restarted the API with MEDIA_FACE_MODE=lite, and gave the
  // synthetic vEIR a face reference ready under likeness consent, as production LITE needs): the same founder turns
  // and meters as the FULL call and Polly alone. A LITE face renders the call's own Polly audio, handed back to the
  // server (`face/speak`) and relayed over the speak socket; the sandbox shows its own avatar whatever the reference.
  test("call LITE: the face lip-syncs the call's Polly audio, the same turns", async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.skip(APP_MODE !== 'lite', 'the LITE pass only (the app runs its face in FULL)');
    test.setTimeout(6 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = { vendor: FACE, mode: 'lite' };
    await page.addInitScript(faceLabInit);
    const sessions = watchAvatarSession(page);
    await faceSettings(baseURL, true);
    let started = false;
    try {
      await acknowledgeNotices(page);
      const call = await startCall(page);
      started = true;
      result.input_mode = call.inputMode;
      await expect(videoTile(page)).toBeVisible({ timeout: 30_000 });
      result.face_shown = true;
      const live = await pageNow(page);
      const micAtLive = (await readLab(page)).mic.length;
      // The greeting (the call's intro), when there is one, is said first.
      await waitForFaceQuiet(page, { timeoutMs: 20_000, pairedEvents: false });
      const turns: TurnTiming[] = [];
      for (const line of LINES) turns.push(await measuredTurn(page, line, { pairedEvents: false }));
      const lab = await readLab(page);
      const posts = speakPosts(lab, live);
      result.session = sessions[0] ?? null;
      result.turns = turns.map(({ sentAt: _sentAt, ...rest }) => rest);
      result.units = liteUnitTimings(lab, live);
      result.speak_requests = posts.length;
      result.speak_accepted = posts.filter((f) => f.status === 204).length;
      result.speak_text_sent = outEvents(lab, 'avatar.speak_text', live).length;
      result.app_playbacks_after_live = lab.plays.filter((t) => t >= live).length;
      result.mic_requests_after_live = lab.mic.length - micAtLive;
      result.audio_senders = lab.audioSenders;
    } catch (err) {
      result.face_shown ??= false;
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/call-lite.json', result);
    }
    expect(result.error ?? null, 'call (LITE)').toBeNull();
  });
});
