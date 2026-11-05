import { inflateSync } from 'node:zlib';

/** A decoded screenshot: 8-bit RGBA, row-major. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Decodes the PNGs Chromium writes for `page.screenshot()` (8-bit RGB or RGBA, not interlaced) into RGBA. Enough
 * to read a screenshot's pixels back without an image library.
 */
export function decodePng(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const chunks: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body.readUInt8(8);
      colourType = body.readUInt8(9);
      if (depth !== 8 || (colourType !== 2 && colourType !== 6) || body.readUInt8(12) !== 0) {
        throw new Error(`Unsupported PNG (depth ${String(depth)}, colour type ${String(colourType)})`);
      }
    } else if (type === 'IDAT') {
      chunks.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  const out = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (current[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      const value = line[x] ?? 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[x] = (value + predicted) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = current[x * channels] ?? 0;
      out[o + 1] = current[x * channels + 1] ?? 0;
      out[o + 2] = current[x * channels + 2] ?? 0;
      out[o + 3] = channels === 4 ? (current[x * channels + 3] ?? 255) : 255;
    }
    previous.set(current);
  }
  return { width, height, data: out };
}
