import { RECORDING_LIMITS } from '@foundry/contracts';

/*
 * The captions of a call recording (ADR-0023): what each voice said and when, timed from the start of the recording,
 * kept beside it as WebVTT so the player shows them in step. Recorded from the call's own captions (the vEIR's
 * validated words as each unit is heard, the founder's finished lines), never from the audio.
 */

export type CaptionSpeaker = 'veir' | 'founder';

export interface CaptionCue {
  readonly speaker: CaptionSpeaker;
  /** Milliseconds from the start of the recording. */
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** What the call shows as captions at one moment (CallSnapshot.captions). */
export interface CaptionLines {
  readonly veir: string | null;
  readonly founder: string | null;
  /** The founder's line is still being heard (it may change). */
  readonly founderLive: boolean;
}

/** The shortest a cue stays on screen: a typed line arrives whole, with no time of its own. */
const MIN_CUE_MS = 1_200;
/** About how long a line takes to read (per word), for a cue that arrived whole. */
const READ_MS_PER_WORD = 320;
const MAX_READ_MS = 6_000;

function tidy(text: string | null): string | null {
  const line = text?.replace(/\s+/g, ' ').trim() ?? '';
  return line === '' ? null : line;
}

function readingMs(text: string): number {
  return Math.min(MAX_READ_MS, Math.max(MIN_CUE_MS, text.split(' ').length * READ_MS_PER_WORD));
}

interface OpenCue {
  readonly startMs: number;
  text: string;
}

/**
 * Turns the call's captions, observed as they change, into timed cues. `observe` is handed every change with the
 * time since the recording started; `finish` closes what is still showing. Pure: the clock is the caller's.
 */
export class CaptionRecorder {
  private readonly done: CaptionCue[] = [];
  private readonly open: Record<CaptionSpeaker, OpenCue | null> = { veir: null, founder: null };
  private last: { veir: string | null; founder: string | null; founderLive: boolean } = {
    veir: null,
    founder: null,
    founderLive: false,
  };

  observe(lines: CaptionLines, atMs: number): void {
    const veir = tidy(lines.veir);
    if (veir !== this.last.veir) {
      this.close('veir', atMs);
      if (veir !== null) this.open.veir = { startMs: atMs, text: veir };
    }
    const founder = tidy(lines.founder);
    if (founder !== this.last.founder || lines.founderLive !== this.last.founderLive) {
      if (founder === null) {
        this.close('founder', atMs);
      } else {
        const current = this.open.founder;
        // A finished line that is not the one being heard starts a cue of its own.
        if (current !== null && founder !== this.last.founder && !this.last.founderLive)
          this.close('founder', atMs);
        const cue = this.open.founder ?? { startMs: atMs, text: founder };
        cue.text = founder;
        this.open.founder = cue;
        if (!lines.founderLive) this.close('founder', atMs);
      }
    }
    this.last = { veir, founder, founderLive: lines.founderLive };
  }

  /** Closes what is still showing and returns every cue, in order of start. */
  finish(atMs: number): CaptionCue[] {
    this.close('veir', atMs);
    this.close('founder', atMs);
    return this.cues();
  }

  cues(): CaptionCue[] {
    return [...this.done].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }

  private close(speaker: CaptionSpeaker, atMs: number): void {
    const cue = this.open[speaker];
    if (cue === null) return;
    this.open[speaker] = null;
    if (this.done.length >= RECORDING_LIMITS.maxCues) return;
    const endMs = atMs - cue.startMs < MIN_CUE_MS ? cue.startMs + readingMs(cue.text) : atMs;
    this.done.push({ speaker, startMs: Math.max(0, cue.startMs), endMs, text: cue.text });
  }
}

/** `hh:mm:ss.mmm`, as WebVTT writes times. */
export function vttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeVtt(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * The cues as a WebVTT file: one voice span per cue, its class saying whose words they are (`veir` or `founder`)
 * and its annotation the name shown with them.
 */
export function toWebVtt(
  cues: readonly CaptionCue[],
  names: Readonly<Record<CaptionSpeaker, string>>,
): string {
  const voice = (speaker: CaptionSpeaker) => names[speaker].replace(/[<>&\n\r]/g, '').trim() || speaker;
  const blocks = cues.map(
    (cue, index) =>
      `${String(index + 1)}\n${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n<v.${cue.speaker} ${voice(cue.speaker)}>${escapeVtt(cue.text)}`,
  );
  return ['WEBVTT', '', ...blocks.map((block) => `${block}\n`)].join('\n');
}

function parseTime(text: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(text.trim());
  if (!match) return null;
  const [, hours = '0', minutes = '0', seconds = '0', millis = '0'] = match;
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(millis);
}

/** A cue as the player shows it: whose words, the name shown with them, and when. */
export interface ShownCue extends CaptionCue {
  readonly name: string;
}

/** Reads a recording's WebVTT captions (this module's own, or any plain WebVTT: its voices are founder's then). */
export function parseWebVtt(text: string): ShownCue[] {
  const cues: ShownCue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing === -1) continue;
    const [from = '', to = ''] = (lines[timing] ?? '').split('-->');
    const startMs = parseTime(from);
    const endMs = parseTime(to.trim().split(/\s+/)[0] ?? '');
    if (startMs === null || endMs === null || endMs < startMs) continue;
    const body = lines.slice(timing + 1).join(' ');
    const voice = /^<v(?:\.([\w.-]+))?(?:\s+([^>]*))?>/.exec(body);
    const classes = voice?.[1]?.split('.') ?? [];
    const speaker: CaptionSpeaker = classes.includes('veir') ? 'veir' : 'founder';
    const words = unescapeVtt(body.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (words === '') continue;
    cues.push({ speaker, startMs, endMs, text: words, name: voice?.[2]?.trim() ?? '' });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** The cues showing at `atMs` (at most one per speaker: the latest that started). */
export function cuesAt<T extends CaptionCue>(cues: readonly T[], atMs: number): T[] {
  const showing = new Map<CaptionSpeaker, T>();
  for (const cue of cues) {
    if (cue.startMs > atMs) break;
    if (cue.endMs >= atMs) showing.set(cue.speaker, cue);
  }
  return [...showing.values()].sort((a, b) => a.startMs - b.startMs);
}
