import type { PromptGuidance } from '../prompts/guidance.js';
import { knownNumbersIn, numbersIn, spelledNumbersIn } from './figures.js';
import { rulesForAPerson } from './reply-contract.js';
import { coverage, sharedCount, stemOf, stemsOf } from './stems.js';
import { wordsIn } from './units.js';

/**
 * The one step of a reply whose message was read, as the writer fits it to them: the reply's last line,
 * `NEXT: <what to do> | DONE: <what will be true>`, or `NEXT: same`. Code reads it (it is never shown as it was written),
 * keeps it only when it is one thing one can start on and nothing of it is made up, and says it as it says any step. Pure.
 */
export interface FittedStep {
  readonly title: string;
  readonly doneWhen: string;
}
export type Fitted = FittedStep | 'same';

/** Why a line is no step. */
export type UnfitReason =
  | 'missing'
  | 'form'
  | 'verb'
  | 'long'
  | 'two'
  | 'date'
  | 'figure'
  | 'name'
  | 'hours'
  | 'person'
  | 'refused'
  | 'closed';

const MOST_WORDS = 25;
const MOST_CHARS = { title: 200, done: 400 } as const;
/** Most of a thing to do where the method counts none. */
const MOST_COUNT = 10;
/** Of a thing to do, in an hour. */
const PER_HOUR = 6;

/** Where the step line begins: on a line of its own, or in capitals after a sentence. */
const NEXT_AT =
  /(?:^|\n)[ \t]*[*_>#\-•]*[ \t]*[*_]*(?:NEXT|Next(?: step)?|Your next step)[*_]*[ \t]*:|(?<=[\s.!?…"'”’)\]])[*_]*NEXT[*_]*[ \t]*:/u;

/** The reply without its step line, and that line ('' when there is none yet). */
export function splitNext(text: string): { readonly body: string; readonly next: string } {
  const m = NEXT_AT.exec(text);
  return m === null ? { body: text, next: '' } : { body: text.slice(0, m.index), next: text.slice(m.index) };
}

const bare = (text: string): string =>
  text
    .replace(/\[\s*E\d+[^\]]*\]/giu, '')
    .replace(/[*_`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
const ended = (text: string): string => text.replace(/[\s.!;,|:]+$/u, '').trim();
const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The line as its two parts; null: not in the form. */
export function readNext(raw: string): Fitted | null {
  const line = bare(
    raw
      .replace(/^[\s*_>#\-•]*(?:NEXT|Next(?: step)?|Your next step)[*_]*[ \t]*:/u, '')
      .trim()
      .split('\n')[0] ?? '',
  );
  if (/^same\b/iu.test(line)) return 'same';
  const m =
    /^(.*?)\s*(?:\|\s*DONE(?:\s+when)?\s*:?|[.;,]?\s+DONE(?:\s+when)?\s*:|\.\s+Done when)\s*(.+)$/u.exec(
      line,
    );
  if (m === null) return null;
  const title = ended(m[1] ?? '');
  const doneWhen = ended(m[2] ?? '').replace(/^(?:when|once)\s+/iu, '');
  return title === '' || doneWhen === '' ? null : { title: capital(title), doneWhen: capital(doneWhen) };
}

const QUOTED = /["“][^"”]*["”]/gu;
const DAY = String.raw`(?:(?:this|next|coming) )?(?:mon|tues|wednes|thurs|fri|satur|sun)days?|today|tonight|tomorrow|(?:this|next) (?:week|weekend|month)|the end of (?:the|this|next) (?:week|month)|(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2}`;
const ENDS_ON_DAY = new RegExp(
  String.raw`,?\s+(?:(?:by|before|on|until|no later than)\s+)?(?:${DAY})$`,
  'iu',
);
const A_DAY = new RegExp(String.raw`\b(?:${DAY})\b`, 'giu');

/** What opens a sentence that is no order to do something. */
const NO_ACT =
  /^(?:you|your|i|we|they|he|she|it|this|that|these|those|the|an?|if|when|once|before|after|to|there|consider|think|reflect|focus|explore|understand|evaluate|assess|remember|aim|continue|stay|ensure|make sure|be|feel|try|decide|keep|wait|same|step)\b|^\p{L}+(?:ing|ed)\b/iu;
const TWO =
  /[;]|[.!?]\s+\p{L}|\b(?:and then|then|also|after that|as well as|finally)\b|,\s*(?:and\s+)?(?:ask|call|email|message|write|send|offer|sell|book|meet|visit|list|make|set|post|read|run|test)\b[^,]*,/iu;

/** What they say they will not do, or is over. */
const REFUSES =
  /\b(?:not|never|won['’]?t|don['’]?t|no longer|stop(?:ped|ping)?|forget|done with|can['’]?t|cannot|refuse|give up on|rather not|hate)\b/iu;
const DONE_SAID =
  /\b(?:already|handled|finished|done|i(?:['’]ve| have)? (?:emailed|called|asked|sent|made|wrote|did|printed|sold|met|booked|posted|talked)|we(?:['’]ve| have)? (?:emailed|called|asked|sent|made|wrote|did|printed|sold|met|booked|posted|talked|reprinted))\b/iu;
/** Words a refusal and a step share whatever either is about. */
const WIDE = new Set(
  'ask talk know want say do get make go need think time pay people person thing way see tell give find work week day month hour one work buy sell'
    .split(' ')
    .map(stemOf),
);
const told = (text: string): string[] => text.split(/(?<=[.!?;])\s+|\n+|,\s+(?:but|so|and)\s+/u);
const own = (text: string): Set<string> =>
  new Set([...stemsOf(text)].filter((w) => !WIDE.has(w) && !/^\d/.test(w)));

/** Whether a step is about what they just refused, or said is done. */
function closed(title: string, founderText: string): UnfitReason | null {
  const does = own(title);
  if (does.size === 0) return null;
  for (const s of told(founderText)) {
    const said = own(s);
    if (said.size === 0) continue;
    if (REFUSES.test(s) && said.size >= 2 && sharedCount(said, does) >= Math.max(2, Math.ceil(said.size / 2)))
      return 'refused';
    if (DONE_SAID.test(s) && does.size >= 2 && coverage(does, said) >= 0.75) return 'closed';
  }
  return null;
}

const NAME = /(?<=[\p{L}\p{N},;:)'’-]\s)\p{Lu}[\p{L}'’-]{2,}/gu;
const COMMON_CAPS = new Set([
  'Ain',
  'Center',
  'University',
  'Rochester',
  'Ventures',
  'Instagram',
  'Google',
  'Zoom',
  'LinkedIn',
]);
const words = (text: string): number[] => [...numbersIn(text), ...spelledNumbersIn(text)];

/** Whether the writer's step line may be the turn's step; else why not. */
export function checkStep(
  raw: string,
  guidance: PromptGuidance,
  context: { readonly founderText: string; readonly known: string },
): { readonly fitted: Fitted | null; readonly reason: UnfitReason | null } {
  const no = (reason: UnfitReason): { fitted: null; reason: UnfitReason } => ({ fitted: null, reason });
  const { fit } = guidance;
  if (fit === undefined || raw.trim() === '') return no('missing');
  const read = readNext(raw);
  if (read === null) return no('form');
  if (read === 'same') return fit.open === null ? no('form') : { fitted: 'same', reason: null };
  const founder = context.founderText.toLowerCase();
  const title = ended(read.title.replace(ENDS_ON_DAY, ''));
  const doneWhen = ended(read.doneWhen.replace(ENDS_ON_DAY, ''));
  const plainTitle = title.replace(QUOTED, ' ');
  if (wordsIn(title) < 3 || NO_ACT.test(title)) return no('verb');
  if (wordsIn(title) > MOST_WORDS || wordsIn(doneWhen) > MOST_WORDS) return no('long');
  if (title.length > MOST_CHARS.title || doneWhen.length > MOST_CHARS.done) return no('long');
  if (TWO.test(plainTitle)) return no('two');
  // A day they named themselves stays; any other is code's to give.
  for (const m of `${plainTitle} ${doneWhen}`.matchAll(A_DAY))
    if (!founder.includes(m[0].toLowerCase().replace(/^(?:this|next|coming) /, ''))) return no('date');
  const known = knownNumbersIn(`${context.known}\n${context.founderText}`);
  const isKnown = (n: number): boolean => known.some((k) => Math.abs(k - n) < 0.005);
  const method = words([fit.title, fit.doneWhen, ...fit.parts].join(' ')).filter((n) => n <= 200);
  const byHours = fit.hours === null ? Number.POSITIVE_INFINITY : Math.max(1, fit.hours * PER_HOUR);
  const most = Math.min(Math.max(MOST_COUNT, ...method), byHours);
  const money = /(?:[$€£]\s?\d|\d\s?(?:%|percent|dollars?|bucks|cents?))/giu;
  for (const part of [title, doneWhen])
    for (const m of part.matchAll(money)) if (!words(m[0]).every(isKnown)) return no('figure');
  const counts = words(title).filter((n) => !isKnown(n));
  if (counts.some((n) => n > Math.max(MOST_COUNT, ...method))) return no('figure');
  if (counts.some((n) => n > most)) return no('hours');
  const least = Math.max(most, ...words(title));
  if (words(doneWhen).some((n) => !isKnown(n) && n > least)) return no('figure');
  const said = `${context.known}\n${context.founderText}\n${fit.title} ${fit.parts.join(' ')}`.toLowerCase();
  for (const part of [plainTitle, doneWhen.replace(QUOTED, ' ')])
    for (const m of part.matchAll(NAME))
      if (!COMMON_CAPS.has(m[0]) && !said.includes(m[0].toLowerCase().replace(/['’]s$/, '')))
        return no('name');
  if (
    rulesForAPerson(title) ||
    (guidance.referral !== null &&
      /^(?:sign|accept|agree to|file|incorporate|register|issue|grant|take (?:the|his|her|their))\b/iu.test(
        title,
      ))
  )
    return no('person');
  const shut = closed(plainTitle, context.founderText);
  if (shut !== null) return no(shut);
  const avoid = guidance.reading?.avoid ?? null;
  if (avoid !== null && own(avoid).size >= 2 && coverage(own(title), own(avoid)) >= 0.75)
    return no('refused');
  return { fitted: { title, doneWhen }, reason: null };
}

/** The guidance with its step as it was fitted: what is said, checked and kept from here on. */
export function withFitted(guidance: PromptGuidance, fitted: Fitted | null): PromptGuidance {
  const { fit, step } = guidance;
  if (fit === undefined) return guidance;
  const done = { ...guidance, fit: { ...fit, done: true } };
  if (fitted === null || step === null) return done;
  const { stepRole: _role, ...rest } = done;
  const { said: _said, wasDue: _was, ...own } = step;
  return fitted === 'same'
    ? fit.open === null
      ? done
      : {
          ...rest,
          step: { ...own, title: fit.open.title, doneWhen: fit.open.doneWhen, dueOn: fit.open.dueOn },
        }
    : { ...rest, step: { ...own, title: fitted.title, doneWhen: fitted.doneWhen, dueOn: fit.dueOn } };
}
