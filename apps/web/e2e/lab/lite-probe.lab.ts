import { join } from 'node:path';

import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type * as LiveKit from 'livekit-client';

import { test } from '../support/fixtures';
import { REPO, errorName, writePrivate } from './lab-support';

/*
 * LITE protocol probe of the conversation lab's face suite (face_mode=lite-probe; spec lite-elevenlabs-design §8,
 * probes L1-L10): raw HeyGen LiveAvatar LITE sessions in the vendor's free SANDBOX (the Wayne avatar, about a minute
 * each, no credits), opened through the dev server's lab probe (`POST /api/v1/_lab/face/lite-sessions`, which keeps the
 * key). This page drives the session's `ws_url` itself, with synthetic speech (a formant synthesiser below: no
 * recording of anyone's voice), and joins the session's LiveKit room as the viewer to hear and watch what the avatar
 * returns. Nothing in the app changes; no app call runs.
 *
 *   s1  L1 start fields and ws_url host, L2 open -> session.state_updated, L3 agent.speak acks (one id for every chunk,
 *       or one id per chunk), L4 speak_started / speak_ended and the sound on the avatar's track against the send time
 *       (first chunks of 1000, 400 and 200 ms), L5 two utterances back to back and a turn sent as one utterance with a
 *       pause inside it, L8 agent.interrupt; last, the room taps' positive control (a second participant, on the
 *       room's agent token, publishes one `lab.control` marker that the viewer's taps must carry).
 *   s2  L1 again, L6 a second socket while an utterance is open (replacement), reopening after a close, L7 closing
 *       right after speak_end, and closing with an uncommitted buffer.
 *   s3  L1 again; L9 the viewer token publishing agent.speak-shaped and avatar.speak_text data on `agent-control`,
 *       then a synthetic speech AUDIO track into the room, against an idle baseline and a socket utterance as the
 *       positive control (sound on the avatar's track, speak events, video motion); L10 the socket from this
 *       localhost page (first), then from a browser page served at the production origin (Playwright fulfils that
 *       navigation itself; the vendor's socket is real), from Node with the production Origin, none and a foreign
 *       one, and from this page again (the session still accepts sockets).
 *
 * The page records socket frames (types, states, which of our ids a source names: labels such as U1, never the ids),
 * the avatar's audio onsets and offsets (the face suite's level meter), video motion (mean frame difference in the
 * middle of the avatar's frame), room data event types, and when each thing was sent. All of it goes to the private
 * folder (sealed); `ws_url` itself stays in memory and only its host, path shape and query key names are written.
 * ops/lab conversation_lab/face.py `public_lite_probe` turns it into public numbers and the design's hypotheses.
 */

const PROBE_TOKEN = process.env.LAB_FACE_PROBE_TOKEN ?? '';
const FACE = process.env.LAB_FACE_VENDOR === 'heygen' ? 'heygen' : 'stand-in';
const RUN = process.env.LAB_FACE_APP_MODE === 'lite-probe';
const API = process.env.E2E_API_URL ?? 'http://localhost:8787';
const LIVEKIT_UMD = join(
  REPO,
  'apps',
  'web',
  'node_modules',
  'livekit-client',
  'dist',
  'livekit-client.umd.js',
);
/** The sandbox's longest session (the vendor refuses more). */
const SESSION_SECONDS = 60;
/**
 * The production site's origin (the workflow's `production_origin` input, else the repository variable FA_SITE_URL,
 * handed over as LAB_PRODUCTION_ORIGIN with LAB_PRODUCTION_ORIGIN_SOURCE `input` or `repository`), else a
 * production-shaped CloudFront origin (AWS's documentation example, `stand-in`: L10's hypothesis is then not graded).
 */
const PRODUCTION = productionOrigin(
  process.env.LAB_PRODUCTION_ORIGIN,
  process.env.LAB_PRODUCTION_ORIGIN_SOURCE,
);
/** An origin nobody serves (`.invalid`), for whether the vendor checks Origin at all. */
const FOREIGN_ORIGIN = 'https://lab-foreign-origin.invalid';

function productionOrigin(
  raw: string | undefined,
  given: string | undefined,
): { origin: string; source: 'input' | 'repository' | 'stand-in' } {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]{1,200}(:\d{1,5})?$/i.test(value)) {
    return { origin: new URL(value).origin, source: given === 'input' ? 'input' : 'repository' };
  }
  return { origin: 'https://d111111abcdef8.cloudfront.net', source: 'stand-in' };
}

// ---- page instruments --------------------------------------------------------------------------------------

interface LiteFrame {
  at: number;
  socket: string;
  binary: boolean;
  type: string | null;
  state: string | null;
  newState: string | null;
  /** Which of our ids the frame's `source_event_id` names (a label such as U1, U1.c2, U1.end, I1), `other`, or null. */
  source: string | null;
  /** Labels of our ids anywhere else in the frame (one level deep), e.g. an utterance id on agent.state_updated. */
  refs: string[];
  hasEventId: boolean;
  errorType: string | null;
  warningType: string | null;
}
interface LiteSocket {
  label: string;
  where: string;
  created: number;
  open: number | null;
  connected: number | null;
  closed: number | null;
  closeCode: number | null;
  error: number | null;
}
interface LiteSent {
  at: number;
  socket: string;
  type: string;
  label: string | null;
  idLabel: string | null;
  audioMs: number | null;
}
interface LiteUtterance {
  socket: string;
  audioMs: number;
  firstChunkMs: number;
  chunks: number;
  ids: 'same' | 'distinct';
  end: boolean;
  closeAfterEnd: boolean;
}
interface LiteLab {
  onsets: number[];
  offsets: number[];
  frames: LiteFrame[];
  sockets: LiteSocket[];
  sent: LiteSent[];
  utterances: Record<string, LiteUtterance>;
  /** Room data the page's peer connections carried (raw data-channel tap: every channel, either side opened). */
  roomEvents: { at: number; type: string }[];
  /** Room data the viewer's Room delivered (`RoomEvent.DataReceived`): the viewer's room only. */
  roomData: { at: number; type: string }[];
  motion: { at: number; d: number }[];
  videoFrames: number;
  /** Remote audio tracks the meter listens to (0: nothing could be heard, so no sound measure counts). */
  audioTracks: number;
  level: number;
}
interface SpeakPlan {
  label: string;
  ms: number;
  firstMs: number;
  chunkMs: number;
  ids: 'same' | 'distinct';
  end: boolean;
  closeAfterEnd: boolean;
  seed: number;
}
interface LiteOps {
  synth: (ms: number, seed: number) => Float32Array<ArrayBuffer>;
  pcmBase64: (samples: Float32Array) => string;
  open: (label: string, url: string, where: string) => Promise<boolean>;
  speak: (socket: string, plan: SpeakPlan) => number | null;
  /** More chunks of an open utterance (the same id), then optionally its speak_end. */
  append: (socket: string, label: string, ms: number, seed: number, end: boolean) => number | null;
  /** speak_end of `label` on `socket` (the utterance's own id). */
  end: (socket: string, label: string) => number | null;
  interrupt: (socket: string, label: string) => number | null;
  close: (socket: string) => number | null;
}
type LiteWindow = Window & { __lite: LiteLab; __liteOps: LiteOps; __liteRoom?: LiveKit.Room };

/**
 * Runs in the page before anything else: the avatar's audio meter and video motion (tapping RTCPeerConnection's
 * remote tracks), room data event types (tapping its data channels), the synthesiser, and the socket driver.
 */
function liteLabInit(): void {
  const now = (): number => performance.timeOrigin + performance.now();
  const lab: LiteLab = {
    onsets: [],
    offsets: [],
    frames: [],
    sockets: [],
    sent: [],
    utterances: {},
    roomEvents: [],
    roomData: [],
    motion: [],
    videoFrames: 0,
    audioTracks: 0,
    level: 0,
  };
  const w = window as unknown as LiteWindow;
  w.__lite = lab;
  /** Our ids (never written) to their labels (written). */
  const ids = new Map<string, string>();
  const byLabel = new Map<string, string>();
  const sockets = new Map<string, WebSocket>();
  const RATE = 24_000;

  /** The face suite's level meter: an onset above 0.01 RMS, an offset after 250 ms at or below 0.004. */
  let meter: AudioContext | null = null;
  const tapAudio = (track: MediaStreamTrack): void => {
    lab.audioTracks += 1;
    const stream = new MediaStream([track]);
    const holder = new Audio();
    holder.muted = true;
    holder.srcObject = stream;
    void holder.play().catch(() => undefined);
    meter ??= new AudioContext();
    void meter.resume().catch(() => undefined);
    const analyser = meter.createAnalyser();
    analyser.fftSize = 512;
    meter.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let loud = false;
    let quietSince = 0;
    window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const level = Math.sqrt(sum / samples.length);
      lab.level = Math.max(lab.level * 0.9, level);
      const t = now();
      if (!loud && level > 0.01) {
        loud = true;
        lab.onsets.push(t);
      } else if (loud && level <= 0.004) {
        if (quietSince === 0) quietSince = t;
        if (t - quietSince >= 250) {
          loud = false;
          lab.offsets.push(quietSince);
          quietSince = 0;
        }
      } else {
        quietSince = 0;
      }
    }, 20);
  };

  /** Mean luma difference between frames 100 ms apart in the middle half of the picture (where the face is). */
  const watchVideo = (track: MediaStreamTrack): void => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => undefined);
    const counted = (): void => {
      lab.videoFrames += 1;
      video.requestVideoFrameCallback(counted);
    };
    video.requestVideoFrameCallback(counted);
    const side = 48;
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let previous: Float32Array | null = null;
    window.setInterval(() => {
      if (context === null || video.videoWidth === 0) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      context.drawImage(video, vw * 0.25, vh * 0.25, vw * 0.5, vh * 0.5, 0, 0, side, side);
      const pixels = context.getImageData(0, 0, side, side).data;
      const luma = new Float32Array(side * side);
      for (let i = 0; i < luma.length; i += 1) {
        luma[i] =
          0.299 * (pixels[i * 4] ?? 0) + 0.587 * (pixels[i * 4 + 1] ?? 0) + 0.114 * (pixels[i * 4 + 2] ?? 0);
      }
      if (previous !== null) {
        let sum = 0;
        for (let i = 0; i < luma.length; i += 1) sum += Math.abs((luma[i] ?? 0) - (previous[i] ?? 0));
        lab.motion.push({ at: now(), d: Math.round((sum / luma.length) * 1000) / 1000 });
      }
      previous = luma;
    }, 100);
  };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const tapped = new WeakSet<RTCDataChannel>();
  const tapChannel = (channel: RTCDataChannel): void => {
    if (tapped.has(channel)) return;
    tapped.add(channel);
    channel.addEventListener('message', (message: MessageEvent) => {
      const at = now();
      const record = (bytes: Uint8Array): void => {
        const type = /"(?:event_type|type)"\s*:\s*"([a-z_.]{1,64})"/.exec(decoder.decode(bytes))?.[1];
        lab.roomEvents.push({ at, type: type ?? 'undecoded' });
      };
      const data: unknown = message.data;
      if (data instanceof Blob) {
        void data
          .arrayBuffer()
          .then((buffer) => {
            record(new Uint8Array(buffer));
          })
          .catch(() => undefined);
      } else if (data instanceof ArrayBuffer) {
        record(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        record(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else if (typeof data === 'string') {
        record(new TextEncoder().encode(data));
      }
    });
  };
  const Native = window.RTCPeerConnection;
  class Tapped extends Native {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      this.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
        tapChannel(event.channel);
      });
      this.addEventListener('track', (event: RTCTrackEvent) => {
        if (event.track.kind === 'audio') tapAudio(event.track);
        if (event.track.kind === 'video') watchVideo(event.track);
      });
    }

    // livekit-client 2.x opens its own data channels (`_reliable`, `_lossy`; one peer connection by default) and
    // receives the room's data on them, so no 'datachannel' event fires: the channels it creates are tapped here
    // (as face.lab.ts does). The tap only listens; it never sends.
    override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, init);
      tapChannel(channel);
      return channel;
    }
  }
  window.RTCPeerConnection = Tapped;

  /**
   * Synthetic speech: a glottal pulse train (110-140 Hz, falling over each phrase) through three formant resonators
   * that move between five vowels about four times a second, with a syllable envelope that never falls silent (so
   * the level meter hears one continuous utterance), at 24 kHz. Deterministic per seed; no one's voice.
   */
  const synth = (ms: number, seed: number): Float32Array<ArrayBuffer> => {
    const n = Math.max(1, Math.round((RATE * ms) / 1000));
    const out = new Float32Array(n);
    const vowels: readonly (readonly [number, number, number])[] = [
      [730, 1090, 2440],
      [530, 1840, 2480],
      [270, 2290, 3010],
      [570, 840, 2410],
      [300, 870, 2240],
    ];
    let state = (seed * 2654435761) >>> 0 || 1;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const syllable = Math.round(RATE * 0.23);
    const formants = [0, 1, 2].map(() => ({ y1: 0, y2: 0 }));
    let phase = 0;
    let vowel = vowels[Math.floor(random() * vowels.length)] ?? vowels[0];
    let target = vowel;
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      if (i % syllable === 0) {
        vowel = target;
        target = vowels[Math.floor(random() * vowels.length)] ?? vowel;
      }
      const within = (i % syllable) / syllable;
      const pitch = 140 - 30 * (i / n) + 6 * Math.sin((2 * Math.PI * i) / (RATE * 0.9));
      phase += pitch / RATE;
      let source = 0;
      if (phase >= 1) {
        phase -= 1;
        source = 1;
      }
      source += (random() - 0.5) * 0.04;
      let sample = 0;
      for (let f = 0; f < 3; f += 1) {
        const from = vowel?.[f] ?? 500;
        const to = target?.[f] ?? from;
        const freq = from + (to - from) * Math.min(1, within * 1.6);
        const bandwidth = 60 + 40 * f;
        const r = Math.exp((-Math.PI * bandwidth) / RATE);
        const b1 = 2 * r * Math.cos((2 * Math.PI * freq) / RATE);
        const b2 = -r * r;
        const s = formants[f] ?? { y1: 0, y2: 0 };
        const y = (1 - r) * source + b1 * s.y1 + b2 * s.y2;
        s.y2 = s.y1;
        s.y1 = y;
        sample += y / (f + 1);
      }
      const envelope = 0.4 + 0.6 * Math.sin(Math.PI * within) ** 2;
      const edge = Math.min(1, i / (RATE * 0.02), (n - i) / (RATE * 0.02));
      out[i] = sample * envelope * edge;
      peak = Math.max(peak, Math.abs(out[i] ?? 0));
    }
    const gain = peak > 0 ? 0.5 / peak : 0;
    for (let i = 0; i < n; i += 1) out[i] = (out[i] ?? 0) * gain;
    return out;
  };

  /** PCM 16-bit little-endian, base64 (the LITE audio format). */
  const pcmBase64 = (samples: Float32Array): string => {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
      view.setInt16(i * 2, Math.round(v * 32767), true);
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  const label = (id: string, name: string): void => {
    ids.set(id, name);
    byLabel.set(name, id);
  };
  const str = (value: unknown): string | null =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(value) ? value : null;

  const open = (name: string, url: string, where: string): Promise<boolean> => {
    const record: LiteSocket = {
      label: name,
      where,
      created: now(),
      open: null,
      connected: null,
      closed: null,
      closeCode: null,
      error: null,
    };
    lab.sockets.push(record);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      record.error = now();
      return Promise.resolve(false);
    }
    socket.binaryType = 'arraybuffer';
    sockets.set(name, socket);
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        resolve(false);
      }, 8000);
      socket.addEventListener('open', () => {
        record.open = now();
      });
      socket.addEventListener('error', () => {
        record.error ??= now();
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        record.closed = now();
        record.closeCode = event.code;
        window.clearTimeout(timer);
        resolve(false);
      });
      socket.addEventListener('message', (message: MessageEvent) => {
        const at = now();
        const data: unknown = message.data;
        if (typeof data !== 'string') {
          lab.frames.push({
            at,
            socket: name,
            binary: true,
            type: null,
            state: null,
            newState: null,
            source: null,
            refs: [],
            hasEventId: false,
            errorType: null,
            warningType: null,
          });
          return;
        }
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = JSON.parse(data);
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          }
        } catch {
          /* recorded as a frame without a type */
        }
        const source = parsed.source_event_id;
        const refs: string[] = [];
        const scan = (value: unknown, depth: number): void => {
          if (typeof value === 'string') {
            const known = ids.get(value);
            if (known !== undefined && !refs.includes(known)) refs.push(known);
          } else if (depth < 2 && value !== null && typeof value === 'object') {
            for (const inner of Object.values(value as Record<string, unknown>)) scan(inner, depth + 1);
          }
        };
        for (const [key, value] of Object.entries(parsed)) {
          if (key !== 'source_event_id' && key !== 'event_id') scan(value, 1);
        }
        const nested = (key: string): Record<string, unknown> => {
          const value = parsed[key];
          return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        };
        const frame: LiteFrame = {
          at,
          socket: name,
          binary: false,
          type: str(parsed.type),
          state: str(parsed.state),
          newState: str(parsed.new_state),
          source: typeof source === 'string' ? (ids.get(source) ?? 'other') : null,
          refs,
          hasEventId: typeof parsed.event_id === 'string',
          errorType: str(nested('error').type),
          warningType: str(nested('warning').type),
        };
        lab.frames.push(frame);
        if (frame.type === 'session.state_updated' && frame.state === 'connected') {
          record.connected ??= at;
          window.clearTimeout(timer);
          resolve(true);
        }
      });
    });
  };

  const send = (name: string, command: Record<string, unknown>, sent: Omit<LiteSent, 'at' | 'socket'>) => {
    const socket = sockets.get(name);
    if (socket?.readyState !== WebSocket.OPEN) return null;
    const at = now();
    socket.send(JSON.stringify(command));
    lab.sent.push({ at, socket: name, ...sent });
    return at;
  };

  const chunked = (
    name: string,
    utterance: string,
    samples: Float32Array,
    firstMs: number,
    chunkMs: number,
    distinct: boolean,
    offset = 0,
  ): { first: number | null; chunks: number } => {
    let first: number | null = null;
    let chunks = 0;
    let at = 0;
    while (at < samples.length) {
      const size = Math.round((RATE * (chunks === 0 && offset === 0 ? firstMs : chunkMs)) / 1000);
      const part = samples.subarray(at, Math.min(samples.length, at + size));
      const index = offset + chunks + 1;
      // The first chunk opens the utterance and names it; later chunks reuse that id, or carry their own.
      let id = index === 1 ? null : (byLabel.get(utterance) ?? null);
      if (id === null || distinct) {
        id = crypto.randomUUID();
        label(id, index === 1 ? utterance : `${utterance}.c${String(index)}`);
      }
      const sentAt = send(
        name,
        { type: 'agent.speak', event_id: id, audio: pcmBase64(part) },
        {
          type: 'agent.speak',
          label: utterance,
          idLabel: ids.get(id) ?? null,
          audioMs: Math.round((part.length * 1000) / RATE),
        },
      );
      if (sentAt === null) break;
      first ??= sentAt;
      chunks += 1;
      at += size;
    }
    return { first, chunks };
  };

  const endUtterance = (name: string, utterance: string, distinct: boolean): number | null => {
    const own = byLabel.get(utterance);
    if (own === undefined) return null;
    let id = own;
    if (distinct) {
      id = crypto.randomUUID();
      label(id, `${utterance}.end`);
    }
    return send(
      name,
      { type: 'agent.speak_end', event_id: id },
      {
        type: 'agent.speak_end',
        label: utterance,
        idLabel: ids.get(id) ?? null,
        audioMs: null,
      },
    );
  };

  const ops: LiteOps = {
    synth,
    pcmBase64,
    open,
    speak: (name, plan) => {
      const samples = synth(plan.ms, plan.seed);
      const { first, chunks } = chunked(
        name,
        plan.label,
        samples,
        plan.firstMs,
        plan.chunkMs,
        plan.ids === 'distinct',
      );
      lab.utterances[plan.label] = {
        socket: name,
        audioMs: plan.ms,
        firstChunkMs: plan.firstMs,
        chunks,
        ids: plan.ids,
        end: plan.end,
        closeAfterEnd: plan.closeAfterEnd,
      };
      if (first === null) return null;
      if (plan.end) endUtterance(name, plan.label, plan.ids === 'distinct');
      if (plan.closeAfterEnd) ops.close(name);
      return first;
    },
    append: (name, utterance, ms, seed, end) => {
      const known = lab.utterances[utterance];
      if (known === undefined) return null;
      const { first, chunks } = chunked(
        name,
        utterance,
        synth(ms, seed),
        1000,
        1000,
        known.ids === 'distinct',
        known.chunks,
      );
      known.chunks += chunks;
      known.audioMs += ms;
      if (end) {
        known.end = true;
        endUtterance(name, utterance, known.ids === 'distinct');
      }
      return first;
    },
    end: (name, utterance) => {
      const known = lab.utterances[utterance];
      if (known === undefined) return null;
      known.end = true;
      // The utterance's own id: the socket that sends it may not be the one that opened it.
      return endUtterance(name, utterance, false);
    },
    interrupt: (name, interrupt) => {
      const id = crypto.randomUUID();
      label(id, interrupt);
      return send(
        name,
        { type: 'agent.interrupt', event_id: id },
        {
          type: 'agent.interrupt',
          label: interrupt,
          idLabel: interrupt,
          audioMs: null,
        },
      );
    },
    close: (name) => {
      const socket = sockets.get(name);
      if (socket === undefined) return null;
      const at = now();
      lab.sent.push({ at, socket: name, type: 'close', label: null, idLabel: null, audioMs: null });
      try {
        socket.close(1000);
      } catch {
        /* already closed */
      }
      return at;
    },
  };
  w.__liteOps = ops;
}

function readLab(page: Page): Promise<LiteLab> {
  return page.evaluate(() => (window as unknown as LiteWindow).__lite);
}

function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

/** Polls the page until `done(lab)` or `timeoutMs`; returns whether it held. */
async function until(page: Page, done: (lab: LiteLab) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(await readLab(page))) return true;
    await page.waitForTimeout(100);
  }
  return done(await readLab(page));
}

const event = (lab: LiteLab, type: string, source: string, after = 0): LiteFrame | undefined =>
  lab.frames.find((f) => f.type === type && f.source === source && f.at >= after);

/** Waits until utterance `label` ended (speak_ended or speak_interrupted for it), or `ms` passed. */
function utteranceDone(page: Page, label: string, ms: number): Promise<boolean> {
  return until(
    page,
    (lab) =>
      event(lab, 'agent.speak_ended', label) !== undefined ||
      event(lab, 'agent.speak_interrupted', label) !== undefined,
    ms,
  );
}

/** Waits for speak_started of `label`, else `fallbackMs` after `sentAt` (the vendor may not send it). */
async function startedOr(page: Page, label: string, sentAt: number, fallbackMs: number): Promise<number> {
  await until(page, (lab) => event(lab, 'agent.speak_started', label) !== undefined, fallbackMs);
  const lab = await readLab(page);
  return event(lab, 'agent.speak_started', label)?.at ?? sentAt + fallbackMs;
}

// ---- the session and its room --------------------------------------------------------------------------------

interface LiteSession {
  sessionId: string;
  url: string;
  token: string;
  controlUrl: string;
  /** The room's agent token (the room-tap control's second participant), when the vendor gave one. */
  agentToken: string | null;
  shape: unknown;
}

async function probeApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: { 'x-lab-probe-token': PROBE_TOKEN },
  });
}

async function openLiteSession(
  api: APIRequestContext,
): Promise<{ session: LiteSession | null; status: number; shape: unknown }> {
  const response = await api.post('/api/v1/_lab/face/lite-sessions', {
    data: { maxSeconds: SESSION_SECONDS },
  });
  const body = (await response.json().catch(() => ({}))) as Partial<LiteSession> & { shape?: unknown };
  if (
    response.status() !== 201 ||
    typeof body.sessionId !== 'string' ||
    typeof body.url !== 'string' ||
    typeof body.token !== 'string' ||
    typeof body.controlUrl !== 'string'
  ) {
    return { session: null, status: response.status(), shape: body.shape ?? null };
  }
  return {
    session: {
      sessionId: body.sessionId,
      url: body.url,
      token: body.token,
      controlUrl: body.controlUrl,
      agentToken: typeof body.agentToken === 'string' && body.agentToken !== '' ? body.agentToken : null,
      shape: body.shape ?? null,
    },
    status: 201,
    shape: body.shape ?? null,
  };
}

async function stopLiteSession(api: APIRequestContext, session: LiteSession | null): Promise<void> {
  if (session === null) return;
  await api.post(`/api/v1/_lab/face/sessions/${session.sessionId}/stop`).catch(() => undefined);
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * What may be written of `ws_url`: its scheme, host and port, its path with id-like segments as `{id}`, and the
 * names of its query parameters (never a value). The URL itself stays in memory.
 */
function controlShape(url: string): {
  scheme: string | null;
  host: string | null;
  port: string | null;
  pathShape: string | null;
  queryKeys: string[];
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { scheme: null, host: null, port: null, pathShape: null, queryKeys: [] };
  }
  const pathShape = parsed.pathname
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      if (!SEGMENT.test(segment)) return '{x}';
      const idLike =
        segment.length >= 24 ||
        (/[0-9]/.test(segment) && segment.length >= 8) ||
        /^[0-9a-f-]{16,}$/i.test(segment);
      return idLike ? '{id}' : segment;
    })
    .join('/');
  return {
    scheme: parsed.protocol.replace(/:$/, ''),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port === '' ? null : parsed.port,
    pathShape,
    queryKeys: [...new Set(parsed.searchParams.keys())].filter((key) => SEGMENT.test(key)).slice(0, 20),
  };
}

interface RoomSeen {
  connectedMs: number | null;
  firstVideoMs: number | null;
  canPublish: boolean | null;
  canPublishData: boolean | null;
  canPublishSources: number[] | null;
  error: string | null;
}

/** Joins the session's room as the viewer (the LITE client token), receive only. */
function joinRoom(page: Page, session: LiteSession): Promise<RoomSeen> {
  return page.evaluate(
    async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
      const w = window as unknown as LiteWindow;
      const now = (): number => performance.timeOrigin + performance.now();
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      w.__liteRoom = room;
      const begun = now();
      const seen: { firstVideo: number | null } = { firstVideo: null };
      const decoder = new TextDecoder('utf-8', { fatal: false });
      // The viewer room's own data (whatever packet the vendor might send), beside the raw data-channel tap.
      room.on(LK.RoomEvent.DataReceived, (payload: Uint8Array) => {
        const type = /"(?:event_type|type)"\s*:\s*"([a-z_.]{1,64})"/.exec(decoder.decode(payload))?.[1];
        w.__lite.roomData.push({ at: now(), type: type ?? 'undecoded' });
      });
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
          canPublish: permissions?.canPublish ?? null,
          canPublishData: permissions?.canPublishData ?? null,
          canPublishSources: permissions === undefined ? null : permissions.canPublishSources.map(Number),
          error: null,
        };
      } catch (err) {
        return {
          connectedMs: null,
          firstVideoMs: null,
          canPublish: null,
          canPublishData: null,
          canPublishSources: null,
          error: err instanceof Error ? err.name : 'error',
        };
      }
    },
    { url: session.url, token: session.token },
  );
}

/** What the room-tap control saw (all private; lite_probe.py grades room-data claims only when it was seen). */
interface RoomControl {
  /** When the marker was published (page clock): room data after it is the control's, not the vendor's. */
  at: number | null;
  joined: boolean;
  published: boolean;
  /** The viewer's raw data-channel tap carried the marker. */
  seenRaw: boolean;
  /** The viewer's Room delivered the marker (`RoomEvent.DataReceived`). */
  seenData: boolean;
  error: string | null;
}

/**
 * The room taps' positive control: a second participant (the room's agent token, in this page) publishes one marker
 * (`lab.control`, no speech) to the room, and the viewer's taps must carry it. Without it an empty room-event list
 * proves nothing (a deaf tap reads the same). Run last in its session, so nothing measured comes after it.
 */
function roomTapControl(page: Page, session: LiteSession): Promise<RoomControl> {
  if (session.agentToken === null) {
    return Promise.resolve({
      at: null,
      joined: false,
      published: false,
      seenRaw: false,
      seenData: false,
      error: 'no_agent_token',
    });
  }
  return page.evaluate(
    async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
      const lab = (window as unknown as LiteWindow).__lite;
      const now = (): number => performance.timeOrigin + performance.now();
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const bounded = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
        Promise.race([
          work,
          new Promise<T>((_, reject) =>
            setTimeout(() => {
              reject(new DOMException(`${what} did not finish`, 'TimeoutError'));
            }, ms),
          ),
        ]);
      const out = {
        at: null as number | null,
        joined: false,
        published: false,
        seenRaw: false,
        seenData: false,
        error: null as string | null,
      };
      const second = new LK.Room({ adaptiveStream: false, dynacast: false });
      // From here on the second participant's own channels are tapped too, so room data from now is not the viewer's.
      const at = now();
      out.at = at;
      try {
        await bounded(second.connect(url, token, { autoSubscribe: false }), 8000, 'connect');
        out.joined = true;
        await bounded(
          second.localParticipant.publishData(
            new TextEncoder().encode(JSON.stringify({ type: 'lab.control' })),
            {
              reliable: true,
              topic: 'lab-control',
            },
          ),
          3000,
          'publishData',
        );
        out.published = true;
        const until = now() + 4000;
        while (now() < until && !(out.seenRaw && out.seenData)) {
          await wait(100);
          out.seenRaw = lab.roomEvents.some((e) => e.type === 'lab.control' && e.at >= at);
          out.seenData = lab.roomData.some((e) => e.type === 'lab.control' && e.at >= at);
        }
      } catch (err) {
        out.error = err instanceof Error ? err.name : 'error';
      } finally {
        await second.disconnect().catch(() => undefined);
      }
      return out;
    },
    { url: session.url, token: session.agentToken },
  );
}

async function leaveRoom(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const w = window as unknown as LiteWindow;
      await w.__liteRoom?.disconnect();
      w.__liteRoom = undefined;
    })
    .catch(() => undefined);
}

/** A blank page at `origin` (a navigation Playwright fulfils itself), with the instruments and livekit-client. */
async function openPageAt(page: Page, origin: string, withLivekit: boolean): Promise<void> {
  const blank = `${origin}/__lab/lite-probe`;
  await page.route(blank, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>lab</title><body></body>',
    }),
  );
  await page.goto(blank);
  if (withLivekit) await page.addScriptTag({ path: LIVEKIT_UMD });
}

/** The Origin header Chromium sends on each WebSocket handshake of `page` (DevTools protocol), in order. */
async function watchHandshakeOrigins(context: BrowserContext, page: Page): Promise<string[]> {
  const origins: string[] = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketWillSendHandshakeRequest', (handshake) => {
    const headers = handshake.request.headers as Record<string, unknown>;
    const origin = headers.Origin ?? headers.origin;
    origins.push(typeof origin === 'string' ? origin : '');
  });
  return origins;
}

interface OriginAttempt {
  where: string;
  opened: boolean;
  connected: boolean;
  connectMs: number | null;
  closeCode: number | null;
  /** Whether the handshake carried the intended Origin (browser: as Chromium sent it; Node: as set). */
  originHeaderOk: boolean | null;
  pageOriginOk: boolean | null;
}

/** The socket from Node (the Playwright worker), with `origin` as its Origin header or none. */
function nodeAttempt(where: string, url: string, origin: string | null): Promise<OriginAttempt> {
  // Node's WebSocket (undici) takes request headers in its second argument; the DOM type does not say so.
  const Socket = WebSocket as unknown as new (
    url: string,
    init?: { headers: Record<string, string> },
  ) => WebSocket;
  const started = Date.now();
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    let socket: WebSocket;
    const finish = (connectMs: number | null, closeCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close(1000);
      } catch {
        /* already closed */
      }
      resolve({
        where,
        opened,
        connected: connectMs !== null,
        connectMs,
        closeCode,
        originHeaderOk: true,
        pageOriginOk: null,
      });
    };
    const timer = setTimeout(() => {
      finish(null, null);
    }, 6000);
    try {
      socket = new Socket(url, origin === null ? undefined : { headers: { Origin: origin } });
    } catch {
      clearTimeout(timer);
      resolve({
        where,
        opened,
        connected: false,
        connectMs: null,
        closeCode: null,
        originHeaderOk: null,
        pageOriginOk: null,
      });
      return;
    }
    socket.addEventListener('open', () => {
      opened = true;
    });
    socket.addEventListener('message', (message: MessageEvent) => {
      const data: unknown = message.data;
      if (
        typeof data === 'string' &&
        data.includes('"session.state_updated"') &&
        /"state"\s*:\s*"connected"/.test(data)
      ) {
        finish(Date.now() - started, null);
      }
    });
    socket.addEventListener('close', (closed: CloseEvent) => {
      finish(null, closed.code);
    });
  });
}

/** The socket from a browser page served at `origin` (a second page of the test's context). */
async function browserAttempt(
  context: BrowserContext,
  where: string,
  origin: string,
  url: string,
): Promise<OriginAttempt> {
  const page = await context.newPage();
  try {
    await page.addInitScript(liteLabInit);
    const origins = await watchHandshakeOrigins(context, page);
    await openPageAt(page, origin, false);
    const pageOrigin = await page.evaluate(() => location.origin);
    const connected = await page.evaluate(
      ([target, label]) => (window as unknown as LiteWindow).__liteOps.open(label, target, 'browser'),
      [url, where] as const,
    );
    const lab = await readLab(page);
    const record = lab.sockets[0];
    await page.evaluate((label) => (window as unknown as LiteWindow).__liteOps.close(label), where);
    await page.waitForTimeout(300);
    return {
      where,
      opened: record?.open !== null && record?.open !== undefined,
      connected,
      connectMs:
        record?.connected === null || record?.connected === undefined
          ? null
          : Math.round(record.connected - record.created),
      closeCode: connected ? null : (record?.closeCode ?? null),
      originHeaderOk: origins.length === 0 ? null : origins[0] === origin,
      pageOriginOk: pageOrigin === origin,
    };
  } finally {
    await page.close();
  }
}

// ---- the probe ---------------------------------------------------------------------------------------------

/** One probe session's record (all of it private; face.py makes the public numbers). */
interface SessionRecord {
  name: string;
  status: number;
  shape: unknown;
  control: ReturnType<typeof controlShape> | null;
  room: RoomSeen | null;
  marks: Record<string, number | null>;
  origins: OriginAttempt[];
  publish: Record<string, unknown>;
  roomControl: RoomControl | null;
  lab: LiteLab | null;
  error: string | null;
}

async function runSession(
  page: Page,
  api: APIRequestContext,
  name: string,
  body: (session: LiteSession, record: SessionRecord) => Promise<void>,
): Promise<SessionRecord> {
  const record: SessionRecord = {
    name,
    status: 0,
    shape: null,
    control: null,
    room: null,
    marks: {},
    origins: [],
    publish: {},
    roomControl: null,
    lab: null,
    error: null,
  };
  // A fresh page per session, so each session's record starts empty and the old room is gone.
  await openPageAt(page, API, true);
  const opened = await openLiteSession(api);
  record.status = opened.status;
  record.shape = opened.shape;
  const session = opened.session;
  try {
    if (session === null) return record;
    record.control = controlShape(session.controlUrl);
    record.room = await joinRoom(page, session);
    await body(session, record);
  } catch (err) {
    record.error = errorName(err);
  } finally {
    record.lab = await readLab(page).catch(() => null);
    await leaveRoom(page);
    await stopLiteSession(api, session);
  }
  return record;
}

function speak(page: Page, socket: string, plan: SpeakPlan): Promise<number | null> {
  return page.evaluate(([name, p]) => (window as unknown as LiteWindow).__liteOps.speak(name, p), [
    socket,
    plan,
  ] as const);
}

const plan = (label: string, ms: number, extra: Partial<SpeakPlan> = {}): SpeakPlan => ({
  label,
  ms,
  firstMs: 1000,
  chunkMs: 1000,
  ids: 'same',
  end: true,
  closeAfterEnd: false,
  seed: label.length * 7919 + ms,
  ...extra,
});

function openSocket(page: Page, label: string, url: string, where: string): Promise<boolean> {
  return page.evaluate(([l, u, w]) => (window as unknown as LiteWindow).__liteOps.open(l, u, w), [
    label,
    url,
    where,
  ] as const);
}

function closeSocket(page: Page, label: string): Promise<number | null> {
  return page.evaluate((l) => (window as unknown as LiteWindow).__liteOps.close(l), label);
}

/** s1: L1-L5 and L8 on one socket. */
async function sessionOne(page: Page, session: LiteSession, record: SessionRecord): Promise<void> {
  const { marks } = record;
  if (!(await openSocket(page, 'A', session.controlUrl, 'page-local'))) return;
  await page.waitForTimeout(1000);
  // L3 / L4: one id per chunk (the docs' wording), then one id for every chunk (what the app's adapter sends), with
  // first chunks of 1000, 400 and 200 ms.
  const utterances: SpeakPlan[] = [
    plan('U1', 3000, { ids: 'distinct' }),
    plan('U2', 2400, { firstMs: 400 }),
    plan('U3', 2200, { firstMs: 200 }),
  ];
  for (const u of utterances) {
    marks[u.label] = await speak(page, 'A', u);
    await utteranceDone(page, u.label, u.ms + 6000);
    await page.waitForTimeout(600);
  }
  // L5: the second utterance sent while the first plays.
  marks.U4 = await speak(page, 'A', plan('U4', 2000));
  const started4 = await startedOr(page, 'U4', marks.U4 ?? (await pageNow(page)), 1500);
  await page.waitForTimeout(Math.max(0, started4 + 500 - (await pageNow(page))));
  marks.U5 = await speak(page, 'A', plan('U5', 2000));
  await utteranceDone(page, 'U5', 9000);
  await page.waitForTimeout(600);
  // L5, one utterance per turn: two units of a turn appended to one utterance, 1.3 s apart (the next unit late).
  marks.U6 = await speak(page, 'A', plan('U6', 1000, { end: false }));
  await page.waitForTimeout(1300);
  marks.U6_append = await page.evaluate(() =>
    (window as unknown as LiteWindow).__liteOps.append('A', 'U6', 1000, 66, true),
  );
  await utteranceDone(page, 'U6', 7000);
  await page.waitForTimeout(600);
  // L8: interrupt a 4-second utterance a second after it started.
  marks.U7 = await speak(page, 'A', plan('U7', 4000));
  const started7 = await startedOr(page, 'U7', marks.U7 ?? (await pageNow(page)), 1500);
  await page.waitForTimeout(Math.max(0, started7 + 1000 - (await pageNow(page))));
  marks.I1 = await page.evaluate(() => (window as unknown as LiteWindow).__liteOps.interrupt('A', 'I1'));
  await page.waitForTimeout(3000);
  marks.end = await pageNow(page);
  // Last: the room taps' positive control (L4's "no speak events in the room" counts only when it was seen).
  record.roomControl = await roomTapControl(page, session);
}

/** s2: L6 replacement and reopening, L7 early close (committed and not). */
async function sessionTwo(page: Page, session: LiteSession, record: SessionRecord): Promise<void> {
  const { marks } = record;
  if (!(await openSocket(page, 'A', session.controlUrl, 'page-local'))) return;
  await page.waitForTimeout(800);
  // L6: an open (uncommitted) utterance on A; B opens; B commits it with the utterance's own id. Three seconds of
  // audio, so A is replaced while the utterance can still be playing (lite_probe.py grades survival only then).
  marks.U1 = await speak(page, 'A', plan('U1', 3000, { end: false }));
  await startedOr(page, 'U1', marks.U1 ?? (await pageNow(page)), 600);
  marks.B_open = await pageNow(page);
  const b = await openSocket(page, 'B', session.controlUrl, 'page-local');
  marks.U1_end = b
    ? await page.evaluate(() => (window as unknown as LiteWindow).__liteOps.end('B', 'U1'))
    : null;
  await utteranceDone(page, 'U1', 6000);
  await page.waitForTimeout(1500);
  // Reopening after our own close.
  marks.B_close = await closeSocket(page, 'B');
  await page.waitForTimeout(500);
  marks.C_open = await pageNow(page);
  if (!(await openSocket(page, 'C', session.controlUrl, 'page-local'))) return;
  await page.waitForTimeout(500);
  // L7: close right after speak_end (before any acknowledgement or speak_started).
  marks.U2 = await speak(page, 'C', plan('U2', 3000, { closeAfterEnd: true }));
  await page.waitForTimeout(4500);
  marks.D_open = await pageNow(page);
  if (!(await openSocket(page, 'D', session.controlUrl, 'page-local'))) return;
  await page.waitForTimeout(1500);
  // L7: close with an uncommitted buffer (chunks, no speak_end).
  marks.U3 = await speak(page, 'D', plan('U3', 2000, { end: false, closeAfterEnd: true }));
  await page.waitForTimeout(4000);
  marks.end = await pageNow(page);
}

/** s3: L10 origins, then L9 room data and a room audio track against an idle baseline and a socket utterance. */
async function sessionThree(
  page: Page,
  context: BrowserContext,
  session: LiteSession,
  record: SessionRecord,
): Promise<void> {
  const { marks } = record;
  // This page (localhost) first: its socket carries L9; L10's other origins come last, since each replaces it.
  const local = await watchHandshakeOrigins(context, page);
  const opened = await openSocket(page, 'M', session.controlUrl, 'page-local');
  const lab = await readLab(page);
  const m = lab.sockets.find((s) => s.label === 'M');
  record.origins.push({
    where: 'browser-local-origin',
    opened: m?.open !== null && m?.open !== undefined,
    connected: opened,
    connectMs:
      m?.connected === null || m?.connected === undefined ? null : Math.round(m.connected - m.created),
    closeCode: opened ? null : (m?.closeCode ?? null),
    originHeaderOk: local.length === 0 ? null : local[0] === new URL(API).origin,
    pageOriginOk: true,
  });
  if (!opened) {
    marks.end = await pageNow(page);
    return;
  }
  // Idle baseline: nothing sent.
  marks.idle_from = await pageNow(page);
  await page.waitForTimeout(2500);
  marks.idle_to = await pageNow(page);
  // L9 data: agent.speak-shaped commands (200 ms of synthetic speech each, under LiveKit's data packet size) and a
  // FULL-style avatar.speak_text, published by the viewer on `agent-control`.
  marks.data_from = await pageNow(page);
  record.publish.data = await page.evaluate(async () => {
    const w = window as unknown as LiteWindow;
    const room = w.__liteRoom;
    const results: { type: string; ok: boolean; error: string | null }[] = [];
    if (room === undefined) return results;
    const utterance = crypto.randomUUID();
    const messages: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      messages.push({
        type: 'agent.speak',
        event_id: utterance,
        audio: w.__liteOps.pcmBase64(w.__liteOps.synth(200, 900 + i)),
      });
    }
    messages.push({ type: 'agent.speak_end', event_id: utterance });
    messages.push({
      event_type: 'avatar.speak_text',
      event_id: crypto.randomUUID(),
      text: 'This is a lab check.',
    });
    for (const message of messages) {
      const type = String(message.type ?? message.event_type);
      try {
        await Promise.race([
          room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
            reliable: true,
            topic: 'agent-control',
          }),
          new Promise((_, reject) =>
            setTimeout(() => {
              reject(new DOMException('publishData did not finish', 'TimeoutError'));
            }, 3000),
          ),
        ]);
        results.push({ type, ok: true, error: null });
      } catch (err) {
        results.push({ type, ok: false, error: err instanceof Error ? err.name : 'error' });
      }
    }
    return results;
  });
  await page.waitForTimeout(4000);
  marks.data_to = await pageNow(page);
  // L9 track: a synthetic speech audio track published into the room (as a microphone, as an agent would).
  record.publish.track = await page.evaluate(async () => {
    const w = window as unknown as LiteWindow;
    const LK = (window as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
    const room = w.__liteRoom;
    if (room === undefined) return { ok: false, error: 'no_room', from: null, to: null };
    const context = new AudioContext();
    await context.resume().catch(() => undefined);
    const samples = w.__liteOps.synth(3500, 4242);
    const buffer = context.createBuffer(1, samples.length, 24_000);
    buffer.copyToChannel(samples, 0);
    const destination = context.createMediaStreamDestination();
    const player = context.createBufferSource();
    player.buffer = buffer;
    player.connect(destination);
    const track = destination.stream.getAudioTracks()[0];
    if (track === undefined) return { ok: false, error: 'no_track', from: null, to: null };
    try {
      // Bounded: the sandbox session lasts about a minute.
      await Promise.race([
        room.localParticipant.publishTrack(track, {
          source: LK.Track.Source.Microphone,
          name: 'lab-synthetic',
        }),
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new DOMException('publishTrack did not finish', 'TimeoutError'));
          }, 6000),
        ),
      ]);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.name : 'error', from: null, to: null };
    }
    // Let the avatar subscribe before the speech starts.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const from = performance.timeOrigin + performance.now();
    player.start();
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const to = performance.timeOrigin + performance.now();
    await room.localParticipant.unpublishTrack(track).catch(() => undefined);
    await context.close().catch(() => undefined);
    return { ok: true, error: null, from, to };
  });
  await page.waitForTimeout(1000);
  // Positive control: the same kind of speech over the socket.
  marks.U1 = await speak(page, 'M', plan('U1', 3000));
  await utteranceDone(page, 'U1', 9000);
  marks.control_to = await pageNow(page);
  await page.waitForTimeout(500);
  // L10: a browser page served at the production origin first (the go / no-go of design (a)), then Node with the
  // production Origin, none and a foreign one. Each replaces the socket before it (one socket per session) and is
  // closed; a last socket from this page then shows the session was still there to accept them, so a refusal above
  // it is the Origin's and not a session that had ended.
  record.origins.push(
    await browserAttempt(context, 'browser-production-origin', PRODUCTION.origin, session.controlUrl),
  );
  record.origins.push(await nodeAttempt('node-production-origin', session.controlUrl, PRODUCTION.origin));
  record.origins.push(await nodeAttempt('node-no-origin', session.controlUrl, null));
  record.origins.push(await nodeAttempt('node-foreign-origin', session.controlUrl, FOREIGN_ORIGIN));
  const after = await openSocket(page, 'Z', session.controlUrl, 'page-local');
  const z = (await readLab(page)).sockets.find((s) => s.label === 'Z');
  record.origins.push({
    where: 'browser-local-after',
    opened: z?.open !== null && z?.open !== undefined,
    connected: after,
    connectMs:
      z?.connected === null || z?.connected === undefined ? null : Math.round(z.connected - z.created),
    closeCode: after ? null : (z?.closeCode ?? null),
    originHeaderOk: local.length < 2 ? null : local.at(-1) === new URL(API).origin,
    pageOriginOk: true,
  });
  marks.end = await pageNow(page);
}

test.describe('Conversation lab · LITE protocol probe (HeyGen LiveAvatar sandbox, raw ws_url)', () => {
  // The instruments, in every lite-probe run (the dry run too): the synthesiser makes speech-level sound that the
  // meter hears over a loopback WebRTC track, and the motion sampler sees a moving picture and not a still one.
  test('lite probe instruments: synthetic speech meters on a loopback track, motion on a moving picture', async ({
    page,
  }) => {
    test.skip(!RUN, 'face_mode lite-probe only');
    const result: Record<string, unknown> = {};
    await page.addInitScript(liteLabInit);
    try {
      await openPageAt(page, API, false);
      Object.assign(
        result,
        await page.evaluate(async () => {
          const w = window as unknown as LiteWindow;
          const lab = w.__lite;
          const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
          const samples = w.__liteOps.synth(1500, 7);
          let sum = 0;
          let peak = 0;
          for (const s of samples) {
            sum += s * s;
            peak = Math.max(peak, Math.abs(s));
          }
          const rms = Math.sqrt(sum / samples.length);
          const encoded = w.__liteOps.pcmBase64(w.__liteOps.synth(1000, 7));
          const context = new AudioContext();
          await context.resume().catch(() => undefined);
          const buffer = context.createBuffer(1, samples.length, 24_000);
          buffer.copyToChannel(samples, 0);
          const destination = context.createMediaStreamDestination();
          const player = context.createBufferSource();
          player.buffer = buffer;
          player.connect(destination);
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 120;
          const draw = canvas.getContext('2d');
          let x = 0;
          const moving = window.setInterval(() => {
            if (draw === null) return;
            draw.fillStyle = '#000';
            draw.fillRect(0, 0, 160, 120);
            draw.fillStyle = '#fff';
            draw.fillRect(40 + (x % 60), 40, 30, 30);
            x += 9;
          }, 40);
          const a = new RTCPeerConnection();
          const b = new RTCPeerConnection();
          a.addEventListener('icecandidate', (e) => {
            if (e.candidate) void b.addIceCandidate(e.candidate);
          });
          b.addEventListener('icecandidate', (e) => {
            if (e.candidate) void a.addIceCandidate(e.candidate);
          });
          const audio = destination.stream.getAudioTracks()[0];
          const video = canvas.captureStream(25).getVideoTracks()[0];
          if (audio !== undefined) a.addTrack(audio, destination.stream);
          if (video !== undefined) a.addTrack(video);
          // The room tap: channels both sides create themselves (negotiated, as livekit-client's own), no
          // 'datachannel' event; the receiving side's tap must carry the sender's marker.
          const sender = a.createDataChannel('_reliable', { negotiated: true, id: 7 });
          b.createDataChannel('_reliable', { negotiated: true, id: 7 });
          const offer = await a.createOffer();
          await a.setLocalDescription(offer);
          await b.setRemoteDescription(offer);
          const answer = await b.createAnswer();
          await b.setLocalDescription(answer);
          await a.setRemoteDescription(answer);
          await wait(1500);
          const tapFrom = performance.timeOrigin + performance.now();
          for (let i = 0; i < 20 && sender.readyState !== 'open'; i += 1) await wait(100);
          // Binary, as livekit-client sends its data packets.
          if (sender.readyState === 'open') {
            sender.send(new TextEncoder().encode(JSON.stringify({ type: 'lab.control' })));
          }
          const movingFrom = performance.timeOrigin + performance.now();
          player.start();
          await wait(1800);
          window.clearInterval(moving);
          const stillFrom = performance.timeOrigin + performance.now() + 500;
          await wait(2000);
          const mean = (from: number, to: number) => {
            const values = lab.motion.filter((m) => m.at >= from && m.at < to).map((m) => m.d);
            return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
          };
          const result = {
            synthRms: Math.round(rms * 1000) / 1000,
            synthPeak: Math.round(peak * 1000) / 1000,
            base64Bytes: Math.round((encoded.length * 3) / 4),
            meterOnset: lab.onsets.some((t) => t >= movingFrom),
            meterOffset: lab.offsets.some((t) => t >= movingFrom),
            videoFrames: lab.videoFrames,
            motionMoving: mean(movingFrom, movingFrom + 1800),
            motionStill: mean(stillFrom, stillFrom + 1500),
            roomTap: lab.roomEvents.some((e) => e.type === 'lab.control' && e.at >= tapFrom),
          };
          a.close();
          b.close();
          await context.close().catch(() => undefined);
          return result;
        }),
      );
    } catch (err) {
      result.error = errorName(err);
    } finally {
      writePrivate('face/lite-probe-instruments.json', result);
    }
    expect(result.error ?? null).toBeNull();
    expect(result).toMatchObject({ meterOnset: true, base64Bytes: 48_000, roomTap: true });
    expect(Number(result.synthRms)).toBeGreaterThan(0.05);
    expect(Number(result.motionMoving)).toBeGreaterThan(Number(result.motionStill ?? 0));
  });

  test('lite probe: LITE ws_url driven directly in the sandbox (L1-L10)', async ({ page, context }) => {
    test.skip(!RUN, 'face_mode lite-probe only');
    test.skip(FACE !== 'heygen' || PROBE_TOKEN === '', 'needs the vendor sandbox (the lab on GitHub)');
    test.setTimeout(10 * 60_000);
    const api = await probeApi();
    const result: Record<string, unknown> = {
      version: 1,
      production_origin_source: PRODUCTION.source,
      sessions: [] as SessionRecord[],
      error: null,
    };
    const sessions = result.sessions as SessionRecord[];
    await page.addInitScript(liteLabInit);
    try {
      sessions.push(
        await runSession(page, api, 's1', (session, record) => sessionOne(page, session, record)),
      );
      sessions.push(
        await runSession(page, api, 's2', (session, record) => sessionTwo(page, session, record)),
      );
      sessions.push(
        await runSession(page, api, 's3', (session, record) => sessionThree(page, context, session, record)),
      );
    } catch (err) {
      result.error = errorName(err);
    } finally {
      writePrivate('face/lite-probe.json', result);
      await api.dispose();
    }
    expect(result.error, 'lite probe').toBeNull();
    expect(sessions.filter((s) => s.status === 201).length, 'LITE sandbox sessions started').toBe(3);
  });
});
