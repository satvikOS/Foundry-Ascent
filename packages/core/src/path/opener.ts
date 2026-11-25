import { daysBetween, sayComing, sayPast } from './dates.js';

const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;

/** A deterministic order of `n` forms for `seed`. */
function startAt(seed: string, n: number): number {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
  return hash % n;
}

/**
 * How a conversation opens on the step the path gave: what they were going to do and when, its due state, and one
 * question, by rule (no model call). The forms in the order to try them; the step's title is the program's own text.
 */
export function checkInOpener(args: {
  readonly title: string;
  /** The day it was given, and the day it is due (ISO dates). */
  readonly givenOn: string;
  readonly dueOn: string | null;
  readonly today: string;
  readonly seed: string;
}): string[] {
  const { today, dueOn, givenOn } = args;
  const title = lowerFirst(args.title.replace(/[.!?\s]+$/u, '').trim());
  const given = sayPast(today, givenOn);
  const since = given === 'today' ? 'Earlier today' : `${given.charAt(0).toUpperCase()}${given.slice(1)}`;
  const late = dueOn === null ? 0 : daysBetween(dueOn, today);
  const state =
    dueOn === null
      ? ''
      : late > 0
        ? late === 1
          ? 'It was due yesterday.'
          : `It was due ${sayPast(today, dueOn)}.`
        : late === 0
          ? 'It is due today.'
          : `It is due ${sayComing(today, dueOn)}.`;
  const forms =
    late > 0
      ? [
          `${since} you were going to ${title}. ${state} Did it happen, and what did you learn?`,
          `Your open step is to ${title}. ${state} How did it go, or should we change the plan?`,
          `Good to see you. ${since} we set one step: ${title}. ${state} Done, not yet, or a change of plan?`,
        ]
      : [
          `${since} you were going to ${title}. ${state} How far did you get?`,
          `Your open step is to ${title}. ${state} What happened so far, and where can I help?`,
          `Good to see you. ${since} we set one step: ${title}. ${state} Done, not yet, or a change of plan?`,
        ];
  const first = startAt(args.seed, forms.length);
  return forms.map((_, i) => (forms[(first + i) % forms.length] ?? '').replace(/\s+/g, ' ').trim());
}
