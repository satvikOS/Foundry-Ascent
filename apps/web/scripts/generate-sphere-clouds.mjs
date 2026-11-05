#!/usr/bin/env node
/**
 * Generates the voice sphere's cloud texture (src/lib/realtime/sphere-clouds.webp): an original, deterministic
 * fractal-noise field, white with a soft alpha, stretched sideways so the clouds band like the owner's reference.
 * Nothing is sampled from any image. Re-run after changing the parameters below:
 *
 *   node apps/web/scripts/generate-sphere-clouds.mjs
 *
 * Needs `cwebp` (libwebp) on PATH to encode the WebP; the intermediate PNG is written to the OS temp directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SEED = 0x5f3759df;
const OCTAVES = 5;
/** Base lattice cells across the tile, horizontally and vertically: wider than tall gives banded clouds. */
const CELLS_X = 2;
const CELLS_Y = 3;
/** Where noise turns into cloud (alpha 0 below LOW, opaque above HIGH). */
const LOW = 0.48;
const HIGH = 0.66;

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/realtime/sphere-clouds.webp');

/** Mulberry32: a small deterministic PRNG, so the texture is identical on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = prng(SEED);
const LATTICE = 256;
const values = Float32Array.from({ length: LATTICE * LATTICE }, () => random());

const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Periodic value noise: wraps at `periodX` x `periodY` lattice cells, so the tile has no seams. */
function noise(x, y, periodX, periodY) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const at = (ix, iy) => {
    const wx = ((ix % periodX) + periodX) % periodX;
    const wy = ((iy % periodY) + periodY) % periodY;
    return values[(wy % LATTICE) * LATTICE + (wx % LATTICE)];
  };
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

function fbm(u, v) {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  for (let octave = 0; octave < OCTAVES; octave++) {
    const scale = 2 ** octave;
    const px = CELLS_X * scale;
    const py = CELLS_Y * scale;
    sum += amplitude * noise(u * px, v * py, px, py);
    norm += amplitude;
    amplitude *= 0.5;
  }
  return sum / norm;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// RGBA rows, each prefixed by PNG filter byte 0.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    // Domain warp: a second field bends the first, so edges read as billows rather than blobs.
    const u = x / SIZE;
    const v = y / SIZE;
    const warp = fbm(u + 0.37, v + 0.71) - 0.5;
    const n = fbm(u + warp * 0.18, v + warp * 0.1);
    const alpha = smoothstep(LOW, HIGH, n);
    // Dense cores lean cream, thin edges pure white (the reference's #FDFEF1 highlights).
    const core = smoothstep(0.7, 0.95, n);
    const i = row + 1 + x * 4;
    raw[i] = 255;
    raw[i + 1] = Math.round(255 - core * 1);
    raw[i + 2] = Math.round(255 - core * 14);
    raw[i + 3] = Math.round(alpha * 255);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dir = mkdtempSync(join(tmpdir(), 'sphere-clouds-'));
try {
  const source = join(dir, 'clouds.png');
  writeFileSync(source, png);
  execFileSync('cwebp', ['-quiet', '-q', '72', '-alpha_q', '70', '-m', '6', source, '-o', OUT]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.warn(`wrote ${OUT} (${String(statSync(OUT).size)} bytes)`);
