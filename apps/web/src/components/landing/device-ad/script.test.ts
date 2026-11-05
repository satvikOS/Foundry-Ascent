import { describe, expect, it } from 'vitest';

import envelopes from './envelopes.json';
import { AD_SESSION } from './fixtures';
import { loopTime } from './player';
import { BEATS, FINAL_FRAME, frameAt, levelsAt, quantize, tokens } from './script';

describe('the device ad sequence', () => {
  it('runs about fourteen seconds, its beats in order', () => {
    const order = [
      BEATS.typeAt,
      BEATS.sentAt,
      BEATS.streamAt,
      BEATS.streamEnd,
      BEATS.doneAt,
      BEATS.phoneAt,
      BEATS.veirAt,
      BEATS.veirEnd,
      BEATS.studentAt,
      BEATS.studentEnd,
      BEATS.savedAt,
      BEATS.end,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(BEATS.end).toBeGreaterThan(12_000);
    expect(BEATS.end).toBeLessThan(16_000);
  });

  it('opens on the vEIR’s opener with an empty composer and the phone dark', () => {
    const frame = frameAt(0);
    expect(frame).toMatchObject({ chat: 'opening', draft: '', streamed: '', phone: 'off', saved: false });
    expect(frame.turns).toEqual([]);
  });

  it('types the question, then streams the answer word by word', () => {
    const typing = frameAt(BEATS.typeAt + 10 * 28);
    expect(typing.chat).toBe('typing');
    expect(AD_SESSION.question.startsWith(typing.draft)).toBe(true);
    expect(typing.draft.length).toBe(10);
    const streaming = frameAt(BEATS.streamAt + 500);
    expect(streaming.chat).toBe('streaming');
    expect(streaming.draft).toBe('');
    expect(AD_SESSION.answer.startsWith(streaming.streamed)).toBe(true);
    expect(streaming.streamed.length).toBeGreaterThan(0);
    expect(streaming.streamed.length).toBeLessThan(AD_SESSION.answer.length);
    expect(frameAt(BEATS.doneAt).chat).toBe('answered');
  });

  it('speaks on the phone only while the recorded voice plays, then listens, then thinks', () => {
    expect(frameAt(BEATS.phoneAt).voice).toBe('connecting');
    expect(frameAt(BEATS.veirAt + 100).voice).toBe('speaking');
    expect(frameAt(BEATS.studentAt + 100).voice).toBe('listening');
    expect(frameAt(BEATS.studentEnd + 100).voice).toBe('thinking');
    // Speaking lasts exactly as long as the recording.
    expect(BEATS.veirEnd - BEATS.veirAt).toBe(envelopes.veir.length * 100);
  });

  it('grows each timeline turn from its recording and closes it when the recording ends', () => {
    const mid = frameAt(BEATS.veirAt + 1_050);
    expect(mid.turns).toHaveLength(1);
    expect(mid.turns[0]).toMatchObject({ speaker: 'veir', endMs: null });
    expect([...(mid.turns[0]?.bins ?? [])]).toEqual(envelopes.veir.slice(0, 11).map(Math.fround));
    const end = FINAL_FRAME;
    expect(end.turns.map((turn) => turn.speaker)).toEqual(['veir', 'student']);
    expect(end.turns.every((turn) => turn.endMs !== null)).toBe(true);
    expect(end.turns[1]?.bins.length).toBe(envelopes.student.length);
  });

  it('ends on the decision saved, both captions and the vEIR thinking', () => {
    expect(FINAL_FRAME).toMatchObject({
      chat: 'answered',
      saved: true,
      phone: 'call',
      voice: 'thinking',
      veirCaption: AD_SESSION.call.veirLine,
      studentCaption: AD_SESSION.call.studentLine,
    });
    expect(FINAL_FRAME.streamed).toBe(AD_SESSION.answer.trimEnd());
  });

  it('gives the presence only recorded levels: silence outside each turn', () => {
    expect(levelsAt(0)).toEqual({ veir: 0, founder: 0 });
    expect(levelsAt(BEATS.veirAt - 1)).toEqual({ veir: 0, founder: 0 });
    expect(levelsAt(BEATS.veirAt).veir).toBeCloseTo(envelopes.veir[0] ?? 0, 4);
    expect(levelsAt(BEATS.veirAt).founder).toBe(0);
    expect(levelsAt(BEATS.studentAt + 150).founder).toBeGreaterThan(0);
    expect(levelsAt(BEATS.end)).toEqual({ veir: 0, founder: 0 });
  });

  it('splits text into words that join back to it, and steps time by 100 ms', () => {
    expect(tokens(AD_SESSION.answer).join('')).toBe(AD_SESSION.answer);
    expect(quantize(1_299)).toBe(1_200);
  });

  it('loops twice from where it starts, then rests on the final frame', () => {
    expect(loopTime(500)).toBe(500);
    expect(loopTime(BEATS.end + 500)).toBe(500);
    expect(loopTime(BEATS.end * 2)).toBe(BEATS.end);
    expect(loopTime(BEATS.end * 5)).toBe(BEATS.end);
    const from = BEATS.phoneAt;
    expect(loopTime(0, from)).toBe(from);
    expect(loopTime(BEATS.end - from + 100, from)).toBe(from + 100);
  });
});
