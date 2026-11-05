/**
 * The device ad's sequence: one pure function from the time into the loop to what both screens show. The
 * player advances the time; React renders `frameAt(t)` at most ten times a second, and the presence reads
 * `levelsAt(t)` every animation frame outside React. Every voice level comes from recorded audio
 * (envelopes.json, 10 Hz RMS of the spoken lines), so nothing on screen moves without sound behind it.
 */
import type { AvatarState } from '@/lib/realtime/avatar';

import envelopes from './envelopes.json';
import { AD_SESSION } from './fixtures';

export type Speaker = 'veir' | 'student';

/** One turn on the call's timeline: the same shape the call's own timeline keeps (100 ms RMS bins). */
export interface TimelineTurn {
  id: string;
  speaker: Speaker;
  startMs: number;
  /** Null while the turn is still being spoken. */
  endMs: number | null;
  bins: Float32Array;
}

const BIN_MS = 1000 / envelopes.hz;
const VEIR_BINS = Float32Array.from(envelopes.veir);
const STUDENT_BINS = Float32Array.from(envelopes.student);

/** Milliseconds per typed character and streamed word (30 tokens a second). */
const TYPE_MS = 28;
const TOKEN_MS = 1000 / 30;

/** The beats of one loop, in milliseconds from its start. */
export const BEATS = (() => {
  const typeAt = 800;
  const sentAt = typeAt + AD_SESSION.question.length * TYPE_MS + 300;
  const streamAt = sentAt + 500;
  const streamEnd = streamAt + tokens(AD_SESSION.answer).length * TOKEN_MS;
  const doneAt = streamEnd + 300;
  const phoneAt = Math.max(doneAt + 1200, 6200);
  const veirAt = phoneAt + 300;
  const veirEnd = veirAt + VEIR_BINS.length * BIN_MS;
  const studentAt = veirEnd + 300;
  const studentEnd = studentAt + STUDENT_BINS.length * BIN_MS;
  const savedAt = studentEnd + 300;
  const end = savedAt + 1200;
  return {
    typeAt,
    sentAt,
    streamAt,
    streamEnd,
    doneAt,
    phoneAt,
    veirAt,
    veirEnd,
    studentAt,
    studentEnd,
    savedAt,
    end,
  };
})();

/** The loop plays this many times, then rests on its final frame. */
export const PLAYS = 2;

/** Words with the spacing after them, the units the answer streams in. */
export function tokens(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

export type ChatStatus = 'opening' | 'typing' | 'streaming' | 'answered';
export type PhoneScreen = 'off' | 'call';

export interface Frame {
  /** The time this frame shows (ms into the loop). */
  t: number;
  chat: ChatStatus;
  /** What the composer holds. */
  draft: string;
  /** The answer as streamed so far. */
  streamed: string;
  /** The decision the call settled shows as saved under the answer. */
  saved: boolean;
  phone: PhoneScreen;
  voice: AvatarState;
  /** The vEIR's caption and the student's, as the call shows them. */
  veirCaption: string | null;
  studentCaption: string | null;
  turns: TimelineTurn[];
  /** Call time shown on the phone, in whole seconds. */
  callSeconds: number;
}

function turn(
  id: string,
  speaker: Speaker,
  startMs: number,
  all: Float32Array,
  t: number,
): TimelineTurn | null {
  if (t < startMs) return null;
  const heard = Math.min(all.length, Math.floor((t - startMs) / BIN_MS) + 1);
  const done = heard >= all.length;
  return {
    id,
    speaker,
    startMs: startMs - BEATS.phoneAt,
    endMs: done ? startMs - BEATS.phoneAt + all.length * BIN_MS : null,
    bins: all.subarray(0, heard),
  };
}

/** What both screens show `t` ms into the loop (clamped to the loop). */
export function frameAt(time: number): Frame {
  const t = Math.max(0, Math.min(BEATS.end, time));
  const typed = Math.max(0, Math.min(AD_SESSION.question.length, Math.floor((t - BEATS.typeAt) / TYPE_MS)));
  const words = tokens(AD_SESSION.answer);
  const shownWords = Math.max(0, Math.min(words.length, Math.floor((t - BEATS.streamAt) / TOKEN_MS)));
  const chat: ChatStatus =
    t < BEATS.typeAt ? 'opening' : t < BEATS.sentAt ? 'typing' : t < BEATS.doneAt ? 'streaming' : 'answered';
  const voice: AvatarState =
    t < BEATS.veirAt
      ? 'connecting'
      : t < BEATS.veirEnd
        ? 'speaking'
        : t < BEATS.studentEnd
          ? 'listening'
          : 'thinking';
  const turns = [
    turn('veir-1', 'veir', BEATS.veirAt, VEIR_BINS, t),
    turn('student-1', 'student', BEATS.studentAt, STUDENT_BINS, t),
  ].filter((value): value is TimelineTurn => value !== null);
  return {
    t,
    chat,
    draft: chat === 'typing' ? AD_SESSION.question.slice(0, typed) : '',
    streamed: words.slice(0, shownWords).join('').trimEnd(),
    saved: t >= BEATS.savedAt,
    phone: t < BEATS.phoneAt ? 'off' : 'call',
    voice,
    veirCaption: t >= BEATS.veirAt ? AD_SESSION.call.veirLine : null,
    studentCaption: t >= BEATS.studentAt ? AD_SESSION.call.studentLine : null,
    turns,
    callSeconds: t < BEATS.phoneAt ? 0 : Math.floor((t - BEATS.phoneAt) / 1000),
  };
}

/** The final frame: what reduced motion, a slow device and the end of the loop show. */
export const FINAL_FRAME = frameAt(BEATS.end);

function sample(bins: Float32Array, offsetMs: number): number {
  if (offsetMs < 0) return 0;
  const position = offsetMs / BIN_MS;
  const index = Math.floor(position);
  if (index >= bins.length) return 0;
  const next = bins[index + 1] ?? 0;
  const here = bins[index] ?? 0;
  return here + (next - here) * (position - index);
}

/** Both voices' RMS at `t` (the presence's inputs), interpolated between the recorded 100 ms bins. */
export function levelsAt(t: number): { veir: number; founder: number } {
  return { veir: sample(VEIR_BINS, t - BEATS.veirAt), founder: sample(STUDENT_BINS, t - BEATS.studentAt) };
}

/** Frames are rendered on 100 ms steps (React updates at most ten times a second). */
export const FRAME_STEP_MS = 100;

export function quantize(t: number): number {
  return Math.floor(t / FRAME_STEP_MS) * FRAME_STEP_MS;
}
