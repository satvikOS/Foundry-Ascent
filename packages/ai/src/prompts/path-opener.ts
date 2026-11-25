import { daysBetween, sayDay, weekdayOf } from './due-day.js';

/**
 * The line a conversation opens with when the founder's path has a step: code writes it from the step itself (a
 * distilled line may be said days later and cannot know what is due), so it is always true, names the last commitment and
 * its due state, and offers the next one. Never a judgement, whatever was missed; answered with a tap (Done, Not yet,
 * Changed plan).
 */

export interface PathOpenerInput {
  /** The step they were on: its title (an instruction, "Email the theatre society") and ISO due date. */
  readonly step: { readonly title: string; readonly dueOn: string | null };
  /** What comes after it, in the path's words; null when nothing is planned yet. */
  readonly next: string | null;
  /** ISO date. */
  readonly today: string;
  readonly founderFirstName?: string | null;
  /** The conversation: the same one always opens the same way, two in a row differently. */
  readonly seed: string;
}

const GREETINGS = ['Welcome back', 'Good to see you', 'Hello again'] as const;
const MAX_TITLE_WORDS = 22;

function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return (hash ^ (hash >>> 13)) >>> 0;
}

function clause(text: string): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!;:,]+$/u, '');
  const words = flat.split(' ');
  const short = words.length > MAX_TITLE_WORDS ? `${words.slice(0, MAX_TITLE_WORDS).join(' ')}…` : flat;
  const first = /^[\p{L}\p{N}'’]+/u.exec(short)?.[0] ?? '';
  return /^I(?:['’]\p{L}+)?$/u.test(first) || /^\p{Lu}[\p{Lu}\d]/u.test(first)
    ? short
    : short.charAt(0).toLowerCase() + short.slice(1);
}

/** The opening line (see the module comment). */
export function pathOpener(input: PathOpenerInput): string {
  const { today } = input;
  const n = seedOf(input.seed);
  const name = input.founderFirstName?.trim() ?? '';
  const greeting = `${GREETINGS[n % GREETINGS.length] ?? GREETINGS[0]}${name === '' ? '' : `, ${name}`}.`;
  const title = clause(input.step.title);
  const due = input.step.dueOn;
  const days = due === null ? null : daysBetween(today, due);
  const next = input.next === null || input.next.trim() === '' ? null : clause(input.next);
  if (due !== null && days !== null && days < 0) {
    const day =
      days === -1 ? 'yesterday' : days >= -6 ? (weekdayOf(due) ?? '') : (sayDay(due)?.split(', ')[1] ?? '');
    const offer =
      next === null
        ? 'If it did, I have the next step; if not, we can make it smaller.'
        : `If it did, next is to ${next}; if not, we can make it smaller.`;
    return `${greeting} You were going to ${title} by ${day}. Did it happen? ${offer}`;
  }
  const when = due === null || days === null ? '' : `, due ${sayDay(due, today) ?? ''}`;
  const help =
    (n >>> 3) % 2 === 0
      ? 'Shall I help you with the first part now?'
      : 'Want to get the first part done together now?';
  return `${greeting} Your step is to ${title}${when}. Is it done, or under way? ${help}`;
}

/** What the founder can answer it with, in one tap. */
export const PATH_OPENER_REPLIES = ['Done', 'Not yet', 'Changed plan'] as const;
