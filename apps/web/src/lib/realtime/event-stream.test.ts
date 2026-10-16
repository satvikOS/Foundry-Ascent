import { describe, expect, it } from 'vitest';

import {
  crc32,
  decodeMessage,
  encodeAudioEvent,
  encodeMessage,
  EventStreamDecoder,
  EventStreamError,
  payloadJson,
} from './event-stream';

const text = new TextEncoder();

/** A message with every header type, built by hand (the decoder must read what other encoders write). */
function messageWithAllHeaderTypes(): Uint8Array {
  const header = (name: string, type: number, value: number[]) => [
    name.length,
    ...text.encode(name),
    type,
    ...value,
  ];
  const headers = [
    ...header('t', 0, []),
    ...header('f', 1, []),
    ...header('b', 2, [0xff]),
    ...header('s', 3, [0x01, 0x00]),
    ...header('i', 4, [0x00, 0x00, 0x01, 0x00]),
    ...header('l', 5, [0, 0, 0, 0, 0, 0, 0x01, 0x00]),
    ...header('y', 6, [0x00, 0x02, 0xca, 0xfe]),
    ...header('w', 7, [0x00, 0x02, 0x68, 0x69]),
    ...header('d', 8, [0, 0, 0x01, 0x8f, 0, 0, 0, 0]),
    ...header(
      'u',
      9,
      Array.from({ length: 16 }, (_, i) => i),
    ),
  ];
  const payload = text.encode('{}');
  const total = 12 + headers.length + payload.length + 4;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  view.setUint32(8, crc32(bytes.subarray(0, 8)));
  bytes.set(headers, 12);
  bytes.set(payload, 12 + headers.length);
  view.setUint32(total - 4, crc32(bytes.subarray(0, total - 4)));
  return bytes;
}

describe('crc32', () => {
  it('matches the IEEE check value', () => {
    expect(crc32(text.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('encodeAudioEvent', () => {
  it('frames PCM as an AudioEvent with the three string headers Transcribe requires', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const bytes = encodeAudioEvent(pcm);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0)).toBe(bytes.length);
    const message = decodeMessage(bytes);
    expect(message.headers).toEqual({
      ':content-type': 'application/octet-stream',
      ':event-type': 'AudioEvent',
      ':message-type': 'event',
    });
    expect(Array.from(message.payload)).toEqual([1, 2, 3, 4]);
  });

  it('encodes the end of the stream as an empty AudioEvent', () => {
    const message = decodeMessage(encodeAudioEvent(new Uint8Array(0)));
    expect(message.payload.length).toBe(0);
    expect(message.headers[':event-type']).toBe('AudioEvent');
  });
});

describe('decodeMessage', () => {
  it('reads every header type', () => {
    const message = decodeMessage(messageWithAllHeaderTypes());
    expect(message.headers.t).toBe(true);
    expect(message.headers.f).toBe(false);
    expect(message.headers.b).toBe(-1);
    expect(message.headers.s).toBe(256);
    expect(message.headers.i).toBe(256);
    expect(message.headers.l).toBe(256n);
    expect(Array.from(message.headers.y as Uint8Array)).toEqual([0xca, 0xfe]);
    expect(message.headers.w).toBe('hi');
    expect(message.headers.d).toBeInstanceOf(Date);
    expect((message.headers.u as Uint8Array).length).toBe(16);
    expect(payloadJson(message)).toEqual({});
  });

  it('refuses corrupted checksums and truncated input', () => {
    const good = encodeMessage({ ':message-type': 'event' }, text.encode('{"a":1}'));
    const badPrelude = good.slice();
    badPrelude[9] = (badPrelude[9] ?? 0) ^ 0xff;
    expect(() => decodeMessage(badPrelude)).toThrow(EventStreamError);
    const badBody = good.slice();
    badBody[good.length - 6] = (badBody[good.length - 6] ?? 0) ^ 0xff;
    expect(() => decodeMessage(badBody)).toThrow(/checksum/);
    expect(() => decodeMessage(good.subarray(0, 10))).toThrow(/too short/);
  });
});

describe('EventStreamDecoder', () => {
  it('reassembles messages split across chunks and splits concatenated ones', () => {
    const first = encodeMessage({ ':event-type': 'TranscriptEvent' }, text.encode('{"n":1}'));
    const second = encodeMessage({ ':event-type': 'TranscriptEvent' }, text.encode('{"n":2}'));
    const stream = new Uint8Array([...first, ...second]);
    const decoderUnderTest = new EventStreamDecoder();
    const out = [
      ...decoderUnderTest.feed(stream.subarray(0, 5)),
      ...decoderUnderTest.feed(stream.subarray(5, first.length + 3)),
      ...decoderUnderTest.feed(stream.subarray(first.length + 3)),
    ];
    expect(out.map((m) => payloadJson(m))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('rejects an impossible declared length', () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 3);
    expect(() => new EventStreamDecoder().feed(bytes)).toThrow(/out of range/);
  });
});
