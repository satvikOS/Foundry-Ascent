import { contentWords } from '../prompts/conversation-state.js';

/**
 * Threads the vEIR raised and whether the founder took them up (the lab's agenda suite, run 39780304879, and the
 * owner's calls of 2026-10-16…20: three openers in a row came back to the advisor session the founder never took
 * up). One reading, deterministic, shared by the opener (packages/core orchestrator/continuity.ts `chooseOpener`)
 * and the distillation's sanitizer, so the two always agree on what was "the same thread":
 *
 * - a thread is the content words of what was raised (an opener, a greeting, a question), without the words every
 *   opener and greeting frames its thread with ("Good to talk again. Shall we pick up …, or is something else on
 *   your mind?") and without the names said in it ({@link threadWords});
 * - the founder took it up when one of their messages holds two of its words, or all of them when it has fewer
 *   (the rule of `raisedIn` in prompts/continuity.ts), or when their first reply to it is a short yes ("Sure",
 *   "Yes, let's") ({@link tookUp});
 * - a text is about a thread when it holds two of the thread's words, or all of the fewer either has
 *   ({@link isAboutThread}).
 */

/**
 * The frame of every opener and greeting the vEIR says around a thread, so a thread is read without it: the
 * greetings, endings and invitations of orchestrator/continuity-prompt.ts (`continuityOpener`, `threadOpener`,
 * `relativeWhen`) and services/calls.ts (`repeatGreetingOf`, `callIntro`), the shapes a stored opener takes
 * (`readOpener`: "last time you planned", "we left off on"), and the frames the model writes its next opener in
 * ("Did you manage to …", "You mentioned …, are you ready …"). A core test keeps it in step with those templates.
 */
const FRAME_TEXT = [
  // Greetings and the call's hello (first meeting included).
  "Hi Hello Hey Good to have you back. Welcome back. Good to talk again. Nice to hear from you again. Good to have you here. I'm the program's AI coach, digital twin, vEIR.",
  // Endings and invitations.
  'Where did you land on it? Want to pick that up, or is something else on your mind? Shall we carry on from there, or start somewhere new? How has it gone since? How is it going? Where are things now?',
  'Want to pick up where we left off, or start on something new? Want to pick up where your last conversation here left off, or start on something new? Your last conversation here was about.',
  'Where would you like to pick up? What would you like to work on?',
  // The shapes around a thread.
  'I wanted to come back to. Last time, we left off on. We talked about. When we last spoke. On a call. We were on.',
  "Last time you planned to, were going to, were planning to, were hoping to, said you'd, said you would, said you were going to, wanted to, hoped to. Your plan to. Your decision to.",
  'Did you get to? How did go? Where are things with? Any more thoughts on? Want to carry on with? Did you manage to? You mentioned. Are you ready? How did that go? Any update on? How are things with? What happened with? Did you get a chance to?',
  // When: relativeWhen's words.
  'a moment ago, about minutes ago, about an hour ago, hours ago, earlier today, yesterday, days ago, last week, on',
  'January February March April May June July August September October November December',
].join(' ');

const FRAME = contentWords(FRAME_TEXT);

/** A short yes to what was raised: the founder took it up even without naming it. */
const AFFIRMS =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|definitely|absolutely|of course|sounds good|good idea|let's|lets|let us|why not|go on|go ahead|please do)\b/i;
const NEGATES = /\b(?:no|not|nope|nah|don't|dont|rather|instead|later|but|actually)\b/i;

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

/**
 * The thread `text` raises: its content words (lower-cased, crudely stemmed: `contentWords`), without the frame of
 * an opener or greeting and without `names` (the founder's, the persona's, the EIR's: "Hi Idris, …" names no
 * thread). Empty for a line that raises nothing (a plain invitation).
 */
export function threadWords(text: string, names: readonly string[] = []): Set<string> {
  const named = contentWords(names.join(' '));
  const out = new Set<string>();
  for (const word of contentWords(text)) if (!FRAME.has(word) && !named.has(word)) out.add(word);
  return out;
}

/** Whether `line` is a short yes ("Sure.", "Yes, let's do that"), not a yes that turns elsewhere ("Sure, but …"). */
export function affirms(line: string): boolean {
  const flat = line.normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  if (!AFFIRMS.test(flat)) return false;
  const words = flat.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length <= 6 && !NEGATES.test(flat.replace(AFFIRMS, ''));
}

/** Whether one of `lines` holds two of the thread's words, or all of them when it has fewer (`raisedIn`'s rule). */
export function mentions(thread: ReadonlySet<string>, lines: readonly string[]): boolean {
  if (thread.size === 0) return false;
  const needed = Math.min(2, thread.size);
  return lines.some((line) => shared(contentWords(line), thread) >= needed);
}

/**
 * Whether the founder took up `thread` in `replies` (what they said after it was raised, oldest first): one message
 * {@link mentions} it, or the first reply is a short yes ({@link affirms}). A thread with no words (a plain
 * invitation) raises nothing to take up: true.
 */
export function tookUp(thread: ReadonlySet<string>, replies: readonly string[]): boolean {
  if (thread.size === 0) return true;
  return (replies[0] !== undefined && affirms(replies[0])) || mentions(thread, replies);
}

/**
 * Whether `text` (a candidate opener, a next topic) is about `thread`: it holds two of the thread's words, or all
 * the words of the shorter of the two when either has fewer ("the three advisor questions you drafted" is about
 * "the advisor session and your three questions"; "the advisor's view on device clearance" is not).
 */
export function isAboutThread(
  text: string,
  thread: ReadonlySet<string>,
  names: readonly string[] = [],
): boolean {
  if (thread.size === 0) return false;
  const words = threadWords(text, names);
  if (words.size === 0) return false;
  return shared(words, thread) >= Math.min(2, thread.size, words.size);
}

/** A thread the vEIR raised and the founder did not take up (its words), or null. */
export function untakenThread(
  raised: string | null | undefined,
  replies: readonly string[],
  names: readonly string[] = [],
): Set<string> | null {
  if (raised === null || raised === undefined) return null;
  const thread = threadWords(raised, names);
  return thread.size === 0 || tookUp(thread, replies) ? null : thread;
}
