#!/usr/bin/env node
/*
 * The landing page's one grain texture: a 256×256 tile of 1-bit noise (public/textures/grain-256.png, ~8 kB),
 * laid over the page's art fields at low opacity. Deterministic (a fixed seed), so a rerun writes the same bytes:
 *
 *   node apps/web/scripts/grain-tile.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures', 'grain-256.png');

/** mulberry32: a small seeded generator (the tile must not change between runs). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const next = random(0x5eed_f00d);
const stride = SIZE / 8;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (stride + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    if (next() < 0.5) raw[y * (stride + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 1; // bit depth
header[9] = 0; // greyscale
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(out, png);
process.stdout.write(`wrote ${String(png.length)} bytes\n`);
