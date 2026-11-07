import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Client from '../client';
import { api } from '../client';
import { uploadToPresignedUrl } from './documents';
import { saveRecording } from './recording-upload';

vi.mock('./documents', () => ({ uploadToPresignedUrl: vi.fn() }));
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof Client>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

const RECORDING_ID = '55555555-5555-4555-8555-555555555555';
const CALL_ID = '11111111-1111-4111-8111-111111111111';

const put = (name: string) => ({
  url: `https://recordings.test/${name}`,
  method: 'PUT' as const,
  headers: { 'content-type': name === 'captions' ? 'text/vtt' : 'video/webm' },
  expiresAt: '2026-11-06T12:05:00.000Z',
});

describe('saveRecording', () => {
  beforeEach(() => {
    vi.mocked(uploadToPresignedUrl).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it('uploads the captions before the recording, so a long upload never outlives the captions URL', async () => {
    const order: string[] = [];
    let finishMedia: () => void = () => undefined;
    vi.mocked(uploadToPresignedUrl).mockImplementation((upload) => {
      order.push(`start ${upload.url}`);
      if (upload.url.endsWith('/media')) {
        return new Promise<void>((resolve) => {
          finishMedia = () => {
            order.push('media done');
            resolve();
          };
        });
      }
      order.push('captions done');
      return Promise.resolve();
    });
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        recording: { id: RECORDING_ID },
        upload: { media: put('media'), captions: put('captions') },
      })
      .mockResolvedValueOnce({ id: RECORDING_ID, status: 'ready' });

    const saving = saveRecording({
      callId: CALL_ID,
      media: new Blob(['x'.repeat(64)], { type: 'video/webm' }),
      mimeType: 'video/webm',
      durationMs: 9_000,
      captions: { vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n', cues: 1 },
    });
    await vi.waitFor(() => {
      expect(order).toContain('start https://recordings.test/media');
    });
    // The captions PUT started (and finished) before the recording's upload began, not after it ended.
    expect(order).toEqual([
      'start https://recordings.test/captions',
      'captions done',
      'start https://recordings.test/media',
    ]);
    finishMedia();
    await expect(saving).resolves.toMatchObject({ id: RECORDING_ID, status: 'ready' });
    expect(vi.mocked(api.post).mock.calls[1]?.[0]).toBe(`/recordings/${RECORDING_ID}/complete`);
  });

  it('uploads only the recording when nobody spoke', async () => {
    vi.mocked(uploadToPresignedUrl).mockResolvedValue(undefined);
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        recording: { id: RECORDING_ID },
        upload: { media: put('media'), captions: null },
      })
      .mockResolvedValueOnce({ id: RECORDING_ID, status: 'ready' });
    await saveRecording({
      callId: CALL_ID,
      media: new Blob(['x'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 1_000,
      captions: null,
    });
    expect(vi.mocked(uploadToPresignedUrl).mock.calls.map(([upload]) => upload.url)).toEqual([
      'https://recordings.test/media',
    ]);
  });
});
