import { describe, expect, it } from 'vitest';

import { recordingFilename } from './recordings.js';

describe('a downloaded recording’s name', () => {
  const base = {
    name: 'Thomas',
    createdAt: '2026-11-07T19:22:41.000Z',
    timeZone: 'America/New_York',
    mimeType: 'video/webm',
    file: 'recording',
  } as const;

  it('says whose call it was and when, in the person’s time zone', () => {
    expect(recordingFilename(base)).toBe('Thomas call 2026-11-07 14-22.webm');
    expect(recordingFilename({ ...base, mimeType: 'video/mp4' })).toBe('Thomas call 2026-11-07 14-22.mp4');
    expect(recordingFilename({ ...base, mimeType: 'audio/mp4' })).toBe('Thomas call 2026-11-07 14-22.m4a');
    expect(recordingFilename({ ...base, file: 'transcript' })).toBe(
      'Thomas call 2026-11-07 14-22 transcript.vtt',
    );
    expect(recordingFilename({ ...base, timeZone: 'Asia/Kolkata' })).toBe(
      'Thomas call 2026-11-08 00-52.webm',
    );
  });

  it('falls back to UTC and to "Call" without a usable time zone or name', () => {
    expect(recordingFilename({ ...base, timeZone: undefined })).toBe('Thomas call 2026-11-07 19-22.webm');
    expect(recordingFilename({ ...base, timeZone: 'Mars/Olympus' })).toBe(
      'Thomas call 2026-11-07 19-22.webm',
    );
    expect(recordingFilename({ ...base, name: '  ' })).toBe('Call 2026-11-07 14-22.webm');
    expect(recordingFilename({ ...base, name: undefined, timeZone: undefined })).toBe(
      'Call 2026-11-07 19-22.webm',
    );
  });

  it('never carries a character a file system refuses, a path or a line break', () => {
    expect(recordingFilename({ ...base, name: '../Maya’s vEIR\r\n"x"' })).toBe(
      '.. Maya’s vEIR x call 2026-11-07 14-22.webm',
    );
    expect(recordingFilename({ ...base, name: 'a'.repeat(200) })).toBe(
      `${'a'.repeat(60)} call 2026-11-07 14-22.webm`,
    );
  });
});
