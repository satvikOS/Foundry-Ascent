import { describe, expect, it } from 'vitest';

import { canRecordCalls, pickFormat } from './call-recorder';

describe('pickFormat', () => {
  it('takes webm where it is recorded (Chromium, Firefox), mp4 on Safari, and sound only without a canvas', () => {
    const chromium = (type: string) => type.startsWith('video/webm') || type.startsWith('audio/webm');
    expect(pickFormat(chromium, true)).toEqual({
      recorderType: 'video/webm;codecs=vp8,opus',
      mimeType: 'video/webm',
    });
    const safari = (type: string) => type === 'video/mp4' || type === 'audio/mp4';
    expect(pickFormat(safari, true)).toEqual({ recorderType: 'video/mp4', mimeType: 'video/mp4' });
    expect(pickFormat(safari, false)).toEqual({ recorderType: 'audio/mp4', mimeType: 'audio/mp4' });
    expect(pickFormat(() => false, true)).toBeNull();
    expect(
      pickFormat(() => {
        throw new Error('unsupported');
      }, true),
    ).toBeNull();
  });

  it('says a browser without MediaRecorder cannot record calls', () => {
    expect(canRecordCalls({ MediaRecorder: undefined })).toBe(false);
  });
});
