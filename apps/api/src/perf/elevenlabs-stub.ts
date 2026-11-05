import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

/**
 * A local stand-in for ElevenLabs' streaming text-to-speech (`POST /v1/text-to-speech/{voice}/stream`), for the latency
 * harness only: the real adapter (`ElevenLabsVoice`) talks HTTP to it over loopback, so the harness measures what the
 * adapter, core and the route add, and what the browser waits for, with the vendor's time simulated:
 *
 * - **Time to first byte**: uniform in [`ttfbMs[0]`, `ttfbMs[1]`] (default 100–250 ms: ElevenLabs publishes ~100–150 ms
 *   server-side for Flash in North America, plus the network), from a seeded generator so runs repeat.
 * - **Audio**: about 15 characters a second of speech (`CALL_LIMITS.speechCharactersPerSecond`), sent in 100 ms pieces,
 *   `speed` times faster than real time (default 4; ElevenLabs publishes no figure for this, so it is a parameter).
 *   `pcm_24000` is 48,000 bytes a second, `mp3_44100_64` 8,000; the bytes are silence (never speech).
 *
 * It checks only that a key header came and the body names text and a model; it never logs or keeps the text.
 */
export interface ElevenLabsStubOptions {
  readonly ttfbMs?: readonly [number, number];
  readonly speed?: number;
  readonly seed?: number;
}

export interface ElevenLabsStub {
  /** `http://127.0.0.1:<port>` (the adapter's `apiOrigin`). */
  readonly origin: string;
  /** Requests answered, and the time to first byte each was given. */
  readonly requests: { readonly format: string; readonly ttfbMs: number; readonly bytes: number }[];
  close(): Promise<void>;
}

const CHARS_PER_SECOND = 15;
const PIECE_MS = 100;

/** mulberry32: a small seeded generator, so the simulated times repeat run to run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

export async function startElevenLabsStub(options: ElevenLabsStubOptions = {}): Promise<ElevenLabsStub> {
  const [low, high] = options.ttfbMs ?? [100, 250];
  const speed = options.speed ?? 4;
  const random = seeded(options.seed ?? 7);
  const requests: ElevenLabsStub['requests'][number][] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.headers['xi-api-key'] === undefined) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      return;
    }
    if (req.method !== 'POST' || !/^\/v1\/text-to-speech\/[^/]+\/stream$/.test(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as { text?: unknown; model_id?: unknown };
    if (typeof body.text !== 'string' || typeof body.model_id !== 'string') {
      res.writeHead(422).end();
      return;
    }
    const format = url.searchParams.get('output_format') ?? 'mp3_44100_128';
    const bytesPerSecond = format === 'pcm_24000' ? 48_000 : 8_000;
    const total = Math.max(
      PIECE_MS,
      Math.round(((body.text.length / CHARS_PER_SECOND) * 1000) / PIECE_MS) * PIECE_MS,
    );
    const ttfbMs = Math.round(low + random() * (high - low));
    // The adapter gave up (its first-audio deadline, a barge-in): nothing more is sent.
    const open = (): boolean => !res.destroyed;
    await sleep(ttfbMs);
    if (!open()) return;
    res.writeHead(200, { 'content-type': format === 'pcm_24000' ? 'audio/pcm' : 'audio/mpeg' });
    const piece = new Uint8Array((bytesPerSecond * PIECE_MS) / 1000);
    let sent = 0;
    for (let at = 0; at < total && open(); at += PIECE_MS) {
      if (at > 0) await sleep(PIECE_MS / speed);
      res.write(piece);
      sent += piece.byteLength;
    }
    res.end();
    requests.push({ format, ttfbMs, bytes: sent });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
