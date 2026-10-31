import { type DocumentContentType } from '@foundry/contracts';
import { type z } from 'zod';

import {
  ExtractionFailedError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  type Clock,
  type CoreLogFields,
  type CoreLogger,
  EmbodimentSessionError,
  type EmbodimentProvider,
  type FaceSessionHandle,
  type FaceTranscript,
  type FaceTranscriptLine,
  type FaceSessionRequest,
  type StartedFaceSession,
  type VerifiedFaceAudio,
  type VoiceProvider,
  type VoiceSynthesisInput,
  type EnqueueOptions,
  type ExtractedText,
  type JobMessage,
  type JobQueue,
  type ObjectStore,
  type PresignGetInput,
  type PresignPutInput,
  type PresignedDownload,
  type PresignedUpload,
  SpeechSynthesisError,
  type SpeechSynthesisInput,
  type SpeechSynthesizer,
  type SynthesizedSpeech,
  SttGrantError,
  type IssuedSttGrant,
  type SttGrantIssuer,
  type SttGrantRequest,
  type TextExtractor,
} from '../ports.js';

/** In-memory ObjectStore: presigned URLs are fake; tests `put` the bytes a browser would upload. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly presigned: PresignPutInput[] = [];
  readonly deleted: string[] = [];
  /** When set, getObject throws this error once (transient-failure tests). */
  failNextGet: Error | null = null;

  presignPut(input: PresignPutInput): Promise<PresignedUpload> {
    this.presigned.push(input);
    return Promise.resolve({
      url: `https://uploads.test/${encodeURI(input.key)}?signature=fake`,
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  readonly presignedGets: PresignGetInput[] = [];

  presignGet(input: PresignGetInput): Promise<PresignedDownload> {
    this.presignedGets.push(input);
    return Promise.resolve({
      url: `https://downloads.test/${encodeURI(input.key)}?disposition=${input.disposition}&signature=fake`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  put(key: string, data: Uint8Array | string): void {
    this.objects.set(key, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  getObject(key: string, options: { readonly maxBytes: number }): Promise<Uint8Array> {
    if (this.failNextGet) {
      const err = this.failNextGet;
      this.failNextGet = null;
      return Promise.reject(err);
    }
    const data = this.objects.get(key);
    if (!data) return Promise.reject(new ObjectNotFoundError('object not found'));
    if (data.byteLength > options.maxBytes)
      return Promise.reject(new ObjectTooLargeError('object too large'));
    return Promise.resolve(data);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }
}

/** In-memory JobQueue (jobs are drained by the test). */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: { job: JobMessage; deduplicationId: string | null; delaySeconds: number }[] = [];
  failNext = false;

  enqueue(job: JobMessage, options?: EnqueueOptions): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    this.jobs.push({
      job,
      deduplicationId: options?.deduplicationId ?? null,
      delaySeconds: options?.delaySeconds ?? 0,
    });
    return Promise.resolve();
  }

  drain(): JobMessage[] {
    return this.jobs.splice(0).map((j) => j.job);
  }
}

/**
 * Test extractor: UTF-8 text for text/markdown; PDF/DOCX bytes are treated as UTF-8 text too unless they
 * start with "%CORRUPT" (simulated unreadable file).
 */
export class Utf8TextExtractor implements TextExtractor {
  extract(data: Uint8Array, _contentType: z.infer<typeof DocumentContentType>): Promise<ExtractedText> {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    if (text.startsWith('%CORRUPT')) return Promise.reject(new ExtractionFailedError('unreadable document'));
    return Promise.resolve({ text });
  }
}

/**
 * Test speech synthesizer: "audio" is the UTF-8 text prefixed with `MP3:`; the first engine of the input is
 * used unless `unsupported` lists it. `failNext` makes the next call fail like a service outage; `delayMs`
 * makes every call take that long (concurrent requests then overlap like real ones).
 */
export class FakeSpeechSynthesizer implements SpeechSynthesizer {
  readonly calls: SpeechSynthesisInput[] = [];
  failNext = false;
  unsupported: readonly string[] = [];
  delayMs = 0;

  async synthesize(input: SpeechSynthesisInput): Promise<SynthesizedSpeech> {
    this.calls.push(input);
    if (this.delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }
    if (this.failNext) {
      this.failNext = false;
      throw new SpeechSynthesisError('speech service unavailable');
    }
    const engine = input.engines.find((e) => !this.unsupported.includes(e));
    if (engine === undefined) throw new SpeechSynthesisError('no supported engine');
    if (input.format === 'pcm_16000') {
      return {
        audio: streamOf(fakePcm(input.text, 16_000)),
        contentType: 'audio/pcm',
        sampleRateHertz: 16_000,
        characters: input.text.length,
        engine,
        voiceId: input.voiceId,
      };
    }
    const bytes = new TextEncoder().encode(`MP3:${input.text}`);
    return {
      audio: streamOf(bytes),
      contentType: 'audio/mpeg',
      characters: input.text.length,
      engine,
      voiceId: input.voiceId,
    };
  }
}

/**
 * Test speech-to-text grants: a fake `wss://` URL carrying the request's language and rate (no credentials).
 * `failNext` makes the next grant fail like a signing error.
 */
export class FakeSttGrantIssuer implements SttGrantIssuer {
  readonly calls: SttGrantRequest[] = [];
  failNext = false;

  issue(request: SttGrantRequest): Promise<IssuedSttGrant> {
    this.calls.push(request);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new SttGrantError('no credentials'));
    }
    const n = String(this.calls.length);
    return Promise.resolve({
      url: `wss://stt.test.invalid:8443/stream-transcription-websocket?language-code=${request.languageCode}&sample-rate=${String(request.sampleRateHertz)}&grant=${n}`,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000).toISOString(),
    });
  }
}

/** A stream of one chunk. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Deterministic 16-bit PCM for `text`: 40 ms per character of a quiet ramp (never silence, never content). */
export function fakePcm(text: string, sampleRate: number): Uint8Array {
  const samples = Math.max(1, Math.round(text.length * 0.04 * sampleRate));
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, (i % 200) - 100, true);
  return out;
}

/**
 * Test vendor faces (the `EmbodimentProvider` port): sessions carry a counter (no credentials), and every call
 * is recorded. `id` and `likeness` say which face it stands for; `failNext` makes the next session fail like a
 * vendor outage, `failSpeak` every speak.
 */
export class FakeEmbodimentProvider implements EmbodimentProvider {
  readonly sessions: FaceSessionRequest[] = [];
  readonly spoken: { readonly handle: FaceSessionHandle; readonly audio: VerifiedFaceAudio }[] = [];
  readonly interrupts: FaceSessionHandle[] = [];
  readonly keepAlives: FaceSessionHandle[] = [];
  readonly ended: { readonly handle: FaceSessionHandle; readonly reason: string }[] = [];
  /** `lite` (renders our audio) unless constructed for `full` (voices admitted text). */
  readonly mode: 'lite' | 'full';
  readonly voicing: 'audio' | 'text';
  /** A stock avatar (labelled "AI avatar"): FULL faces are. */
  stock: boolean;
  /** Shown to platform admins only. */
  adminsOnly = false;
  /** FULL: the vendor's transcript lines per session (what the avatar said), as `transcriptSince` returns them. */
  readonly transcripts = new Map<string, FaceTranscriptLine[]>();
  /** The vendor transcript cannot be read (rejects). */
  failTranscript = false;
  /** The vendor has more transcript than one read takes (the read says it is not complete). */
  transcriptIncomplete = false;
  /** Every transcript read: the session and the cursor it read from. */
  readonly transcriptReads: { readonly sessionRef: string; readonly since: number | null }[] = [];
  failNext = false;
  failSpeak = false;
  /** How many of the next `end` calls fail (after being recorded), like a vendor 5xx. */
  failEnds = 0;
  /** A vendor sandbox (offered to platform admins only). */
  sandbox = false;
  /** The control channel each session gets (a credential at a real vendor). */
  control: string | null = 'wss://face.test.invalid/control';

  constructor(
    readonly id: EmbodimentProvider['id'] = 'fake',
    readonly likeness = false,
    readonly usdPerMinute = 0.093,
    mode: 'lite' | 'full' = 'lite',
  ) {
    this.mode = mode;
    this.voicing = mode === 'full' ? 'text' : 'audio';
    this.stock = mode === 'full';
    // FULL has no server-held control channel: the browser sends the vendor its commands over the room.
    if (mode === 'full') this.control = null;
  }

  /** Records a line the avatar said in a session (FULL). */
  said(sessionRef: string, text: string, role: 'avatar' | 'user' = 'avatar'): void {
    const lines = this.transcripts.get(sessionRef) ?? [];
    lines.push({ role, text, at: lines.length + 1 });
    this.transcripts.set(sessionRef, lines);
  }

  transcriptSince(handle: FaceSessionHandle, since: number | null): Promise<FaceTranscript> {
    this.transcriptReads.push({ sessionRef: handle.sessionRef, since });
    if (this.failTranscript) return Promise.reject(new EmbodimentSessionError('transcript unavailable'));
    const lines = this.transcripts.get(handle.sessionRef) ?? [];
    return Promise.resolve({
      lines: lines.filter((line) => since === null || line.at >= since),
      complete: !this.transcriptIncomplete,
    });
  }

  createSession(request: FaceSessionRequest): Promise<StartedFaceSession> {
    this.sessions.push(request);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new EmbodimentSessionError('vendor unavailable'));
    }
    const n = String(this.sessions.length);
    return Promise.resolve({
      browser: {
        token: `${this.id}.session-${n}`,
        url: this.id === 'fake' ? null : `wss://room-${n}.test.invalid`,
        expiresAt: new Date(Date.now() + Math.min(request.maxSeconds, 60) * 1000).toISOString(),
      },
      sessionRef: `sess-${n}`,
      control: this.control === null ? null : `${this.control}/${n}`,
    });
  }

  speak(handle: FaceSessionHandle, audio: VerifiedFaceAudio): Promise<void> {
    this.spoken.push({ handle, audio });
    return this.failSpeak ? Promise.reject(new EmbodimentSessionError('vendor dropped')) : Promise.resolve();
  }

  interrupt(handle: FaceSessionHandle): Promise<void> {
    this.interrupts.push(handle);
    return Promise.resolve();
  }

  keepAlive(handle: FaceSessionHandle): Promise<void> {
    this.keepAlives.push(handle);
    return Promise.resolve();
  }

  end(handle: FaceSessionHandle, reason: string): Promise<void> {
    this.ended.push({ handle, reason });
    if (this.failEnds > 0) {
      this.failEnds -= 1;
      return Promise.reject(new EmbodimentSessionError('vendor unavailable'));
    }
    return Promise.resolve();
  }
}

/**
 * Test cloned voice (the `VoiceProvider` port): records every unit it was handed; MP3 is the text prefixed with
 * `CLONE:`, PCM is {@link fakePcm} at 24 kHz. `failNext` makes the next call fail like a vendor outage.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly calls: VoiceSynthesisInput[] = [];
  readonly model = 'test_model';
  failNext = false;

  constructor(
    readonly id: VoiceProvider['id'] = 'elevenlabs',
    readonly usdPer1kCharacters = 0.04,
  ) {}

  synthesize(input: VoiceSynthesisInput): Promise<SynthesizedSpeech> {
    this.calls.push(input);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new SpeechSynthesisError('voice vendor unavailable'));
    }
    const text = input.unit.text;
    return Promise.resolve(
      input.format === 'pcm_24000'
        ? {
            audio: streamOf(fakePcm(text, 24_000)),
            contentType: 'audio/pcm',
            sampleRateHertz: 24_000,
            characters: text.length,
            engine: 'clone',
            voiceId: input.voiceRef,
          }
        : {
            audio: streamOf(new TextEncoder().encode(`CLONE:${text}`)),
            contentType: 'audio/mpeg',
            characters: text.length,
            engine: 'clone',
            voiceId: input.voiceRef,
          },
    );
  }
}

/** Manually advanced clock. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start: Date | string = new Date()) {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(date: Date | string): void {
    this.#now = new Date(date).getTime();
  }
}

export interface LogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: CoreLogFields;
}

/** Captures log lines so tests can assert that no content is ever logged. */
export class RecordingLogger implements CoreLogger {
  readonly records: LogRecord[] = [];

  info(event: string, fields: CoreLogFields): void {
    this.records.push({ level: 'info', event, fields });
  }

  warn(event: string, fields: CoreLogFields): void {
    this.records.push({ level: 'warn', event, fields });
  }

  error(event: string, fields: CoreLogFields): void {
    this.records.push({ level: 'error', event, fields });
  }

  /** Every logged value as one string (for "never contains X" assertions). */
  dump(): string {
    return JSON.stringify(this.records);
  }
}
