/**
 * The AWS event-stream binary framing that Amazon Transcribe streaming speaks over its WebSocket
 * (https://docs.aws.amazon.com/transcribe/latest/dg/streaming-setting-up.html, "Event stream encoding").
 *
 *   ┌ total length u32 ┬ headers length u32 ┬ prelude CRC32 u32 ┬ headers … ┬ payload … ┬ message CRC32 u32 ┐
 *
 * Headers are `name length u8 · name · value type u8 · value`. Audio goes up as `AudioEvent` messages whose
 * payload is raw 16-bit little-endian PCM; an empty `AudioEvent` ends the stream. Transcripts come back as
 * `TranscriptEvent` messages with a JSON payload, and failures as `exception` messages.
 *
 * Written here (about a hundred lines) rather than pulled in from the AWS SDK, which would add a codec
 * dependency for one message type.
 */

export type HeaderValue = string | number | boolean | Uint8Array | bigint | Date;

export interface EventStreamMessage {
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly payload: Uint8Array;
}

const PRELUDE_BYTES = 8;
const PRELUDE_TOTAL_BYTES = PRELUDE_BYTES + 4;
const MESSAGE_CRC_BYTES = 4;
const MIN_MESSAGE_BYTES = PRELUDE_TOTAL_BYTES + MESSAGE_CRC_BYTES;
/** Transcribe never sends anything near this; a larger declared length means the stream is corrupt. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const STRING_TYPE = 7;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as the event-stream prelude and message checksums use. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeStringHeaders(headers: Readonly<Record<string, string>>): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const view = new DataView(part.buffer);
    part[0] = nameBytes.length;
    part.set(nameBytes, 1);
    part[1 + nameBytes.length] = STRING_TYPE;
    view.setUint16(2 + nameBytes.length, valueBytes.length);
    part.set(valueBytes, 4 + nameBytes.length);
    parts.push(part);
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One event-stream message with string headers. */
export function encodeMessage(headers: Readonly<Record<string, string>>, payload: Uint8Array): Uint8Array {
  const headerBytes = encodeStringHeaders(headers);
  const total = PRELUDE_TOTAL_BYTES + headerBytes.length + payload.length + MESSAGE_CRC_BYTES;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.subarray(0, PRELUDE_BYTES)));
  out.set(headerBytes, PRELUDE_TOTAL_BYTES);
  out.set(payload, PRELUDE_TOTAL_BYTES + headerBytes.length);
  view.setUint32(total - MESSAGE_CRC_BYTES, crc32(out.subarray(0, total - MESSAGE_CRC_BYTES)));
  return out;
}

const AUDIO_EVENT_HEADERS = {
  ':content-type': 'application/octet-stream',
  ':event-type': 'AudioEvent',
  ':message-type': 'event',
} as const;

/** An `AudioEvent` carrying 16-bit little-endian PCM. An empty chunk tells Transcribe the audio has ended. */
export function encodeAudioEvent(pcm: Uint8Array): Uint8Array {
  return encodeMessage(AUDIO_EVENT_HEADERS, pcm);
}

export class EventStreamError extends Error {
  override readonly name = 'EventStreamError';
}

function decodeHeaders(bytes: Uint8Array): Record<string, HeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Record<string, HeaderValue> = {};
  let offset = 0;
  const need = (count: number) => {
    if (offset + count > bytes.length) throw new EventStreamError('Truncated event-stream header');
  };
  while (offset < bytes.length) {
    need(1);
    const nameLength = view.getUint8(offset);
    offset += 1;
    need(nameLength + 1);
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = view.getUint8(offset);
    offset += 1;
    switch (type) {
      case 0:
        headers[name] = true;
        break;
      case 1:
        headers[name] = false;
        break;
      case 2:
        need(1);
        headers[name] = view.getInt8(offset);
        offset += 1;
        break;
      case 3:
        need(2);
        headers[name] = view.getInt16(offset);
        offset += 2;
        break;
      case 4:
        need(4);
        headers[name] = view.getInt32(offset);
        offset += 4;
        break;
      case 5:
        need(8);
        headers[name] = view.getBigInt64(offset);
        offset += 8;
        break;
      case 6:
      case STRING_TYPE: {
        need(2);
        const length = view.getUint16(offset);
        offset += 2;
        need(length);
        const value = bytes.slice(offset, offset + length);
        headers[name] = type === STRING_TYPE ? decoder.decode(value) : value;
        offset += length;
        break;
      }
      case 8:
        need(8);
        headers[name] = new Date(Number(view.getBigInt64(offset)));
        offset += 8;
        break;
      case 9:
        need(16);
        headers[name] = bytes.slice(offset, offset + 16);
        offset += 16;
        break;
      default:
        throw new EventStreamError(`Unknown event-stream header type ${String(type)}`);
    }
  }
  return headers;
}

/** Decodes one complete message (exactly `bytes.length` long), verifying both checksums. */
export function decodeMessage(bytes: Uint8Array): EventStreamMessage {
  if (bytes.length < MIN_MESSAGE_BYTES) throw new EventStreamError('Event-stream message too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0);
  const headersLength = view.getUint32(4);
  if (total !== bytes.length) throw new EventStreamError('Event-stream length mismatch');
  if (view.getUint32(8) !== crc32(bytes.subarray(0, PRELUDE_BYTES))) {
    throw new EventStreamError('Event-stream prelude checksum mismatch');
  }
  if (view.getUint32(total - MESSAGE_CRC_BYTES) !== crc32(bytes.subarray(0, total - MESSAGE_CRC_BYTES))) {
    throw new EventStreamError('Event-stream message checksum mismatch');
  }
  const headersEnd = PRELUDE_TOTAL_BYTES + headersLength;
  if (headersEnd > total - MESSAGE_CRC_BYTES) throw new EventStreamError('Event-stream headers overflow');
  return {
    headers: decodeHeaders(bytes.subarray(PRELUDE_TOTAL_BYTES, headersEnd)),
    payload: bytes.slice(headersEnd, total - MESSAGE_CRC_BYTES),
  };
}

/**
 * Splits a byte stream into messages. WebSocket frames normally carry one message each, but nothing in
 * the protocol promises it, so partial and concatenated messages are both handled.
 */
export class EventStreamDecoder {
  private buffer = new Uint8Array(0);

  feed(chunk: Uint8Array): EventStreamMessage[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    const messages: EventStreamMessage[] = [];
    let offset = 0;
    while (merged.length - offset >= 4) {
      const total = new DataView(merged.buffer, offset, 4).getUint32(0);
      if (total < MIN_MESSAGE_BYTES || total > MAX_MESSAGE_BYTES) {
        throw new EventStreamError('Event-stream message length out of range');
      }
      if (merged.length - offset < total) break;
      messages.push(decodeMessage(merged.subarray(offset, offset + total)));
      offset += total;
    }
    this.buffer = merged.slice(offset);
    return messages;
  }
}

/** The payload of a message as JSON (Transcribe's transcript and exception bodies). */
export function payloadJson(message: EventStreamMessage): unknown {
  return JSON.parse(decoder.decode(message.payload)) as unknown;
}
