import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeMessage } from './event-stream';
import { exceptionEvent, FakeWebSocket, transcriptEvent } from './testing';
import { TranscribeStream, transcriptResults } from './transcribe';

const URL =
  'wss://transcribestreaming.us-east-1.amazonaws.com:8443/stream-transcription-websocket?X-Amz-Signature=x';

function open() {
  const handlers = { onOpen: vi.fn(), onResult: vi.fn(), onClose: vi.fn() };
  const stream = new TranscribeStream(URL, handlers, (url) => new FakeWebSocket(url));
  return { stream, handlers, socket: FakeWebSocket.last() };
}

beforeEach(() => {
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('transcriptResults', () => {
  it('reads partial, stable and final results and skips malformed ones', () => {
    expect(
      transcriptResults({
        Transcript: {
          Results: [
            {
              ResultId: 'r1',
              IsPartial: true,
              Alternatives: [
                {
                  Transcript: 'hello there.',
                  Items: [
                    { Content: 'hello', Type: 'pronunciation', Stable: true },
                    { Content: 'there', Type: 'pronunciation', Stable: true },
                    { Content: '.', Type: 'punctuation', Stable: false },
                  ],
                },
              ],
            },
            { ResultId: 'r2', IsPartial: false, Alternatives: [{ Transcript: ' Done ' }] },
            { IsPartial: false, Alternatives: [{ Transcript: 'no id' }] },
          ],
        },
      }),
    ).toEqual([
      { resultId: 'r1', text: 'hello there.', partial: true, stable: true, stableText: 'hello there' },
      { resultId: 'r2', text: 'Done', partial: false, stable: true, stableText: 'Done' },
    ]);
    expect(transcriptResults(null)).toEqual([]);
    expect(transcriptResults({ Transcript: { Results: 'x' } })).toEqual([]);
  });
});

describe('TranscribeStream', () => {
  it('opens a binary socket to the presigned URL and queues audio until it is open', () => {
    const { stream, handlers, socket } = open();
    expect(socket.url).toBe(URL);
    expect(socket.binaryType).toBe('arraybuffer');

    stream.sendPcm(new Int16Array([1, -1]));
    expect(socket.sent).toHaveLength(0);
    socket.serverOpen();
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(1);
    const frame = decodeMessage(socket.sent[0] ?? new Uint8Array());
    expect(frame.headers[':event-type']).toBe('AudioEvent');
    // Little-endian 16-bit samples.
    expect(Array.from(frame.payload)).toEqual([1, 0, 0xff, 0xff]);
  });

  it('delivers transcripts from TranscriptEvents', () => {
    const { handlers, socket } = open();
    socket.serverOpen();
    socket.serverSend(transcriptEvent('r1', 'we interviewed', { partial: true }));
    socket.serverSend(transcriptEvent('r1', 'we interviewed twelve clinics', { partial: false }));
    expect(handlers.onResult.mock.calls.map(([r]) => r as unknown)).toEqual([
      { resultId: 'r1', text: 'we interviewed', partial: true, stable: false, stableText: '' },
      {
        resultId: 'r1',
        text: 'we interviewed twelve clinics',
        partial: false,
        stable: true,
        stableText: 'we interviewed twelve clinics',
      },
    ]);
  });

  it('reports the stable lead of a partial: the words Transcribe will not revise (LAB-V4)', () => {
    const { handlers, socket } = open();
    socket.serverOpen();
    socket.serverSend(transcriptEvent('r1', 'sorry to cut', { partial: true, stableWords: 1 }));
    expect(handlers.onResult.mock.calls.at(-1)?.[0]).toMatchObject({ stable: false, stableText: 'sorry' });
  });

  it('ends with an empty AudioEvent and reports an expected close', () => {
    vi.useFakeTimers();
    const { stream, handlers, socket } = open();
    socket.serverOpen();
    stream.end();
    const last = decodeMessage(socket.sent.at(-1) ?? new Uint8Array());
    expect(last.payload.length).toBe(0);
    stream.sendPcm(new Int16Array([5]));
    expect(socket.sent).toHaveLength(1);
    // Transcribe closes after its final results.
    socket.close(1000);
    expect(handlers.onClose).toHaveBeenCalledWith({ expected: true, code: null });
  });

  it('closes by itself when Transcribe does not after the end of audio', () => {
    vi.useFakeTimers();
    const { stream, handlers, socket } = open();
    socket.serverOpen();
    stream.end();
    vi.advanceTimersByTime(1500);
    expect(socket.closedWith).toBe(1000);
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('reports an exception or a dropped socket as unexpected', () => {
    const first = open();
    first.socket.serverOpen();
    first.socket.serverSend(exceptionEvent('BadRequestException', 'Your request timed out'));
    first.socket.serverDrop();
    expect(first.handlers.onClose).toHaveBeenCalledWith({ expected: false, code: 'BadRequestException' });

    const second = open();
    second.socket.serverOpen();
    second.socket.serverDrop();
    expect(second.handlers.onClose).toHaveBeenCalledWith({ expected: false, code: null });
  });

  it('treats garbage on the socket as a failed stream', () => {
    const { handlers, socket } = open();
    socket.serverOpen();
    socket.serverSend(new Uint8Array([0, 0, 0, 3, 1, 2, 3, 4]));
    expect(handlers.onClose).toHaveBeenCalledWith({ expected: false, code: 'InvalidStream' });
  });
});
