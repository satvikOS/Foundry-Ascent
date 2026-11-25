import { saidNumbers } from './calc-read.js';
import { upperFirst } from './tell.js';

/**
 * What the counts of a message show, read by code: for a result nobody read (a part of the reading that came late). The same
 * people again, a funnel that ends in money, talks and what came of each. Never a verdict without its numbers. Pure.
 */
export interface ToldCounts {
  readonly kind: 'again' | 'funnel' | 'talks';
  readonly text: string;
  readonly voice: string;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number): string => WORDS[n] ?? String(n);
const was = (n: number): string => (n === 1 ? 'was' : 'were');

/** "26 lamps, nine of them to regulars": how many of it is new. */
function again(t: string): ToldCounts | null {
  const m =
    /(?<![\d.$~])(\d+) ([a-z]+)\b[^.?!]{0,60}?(?<![\d.$~])(\d+) of (?:those|them|these|the \1)[^.?!]{0,24}?\b(?:the same (?:people|ones|buyers|customers|folks)|same people|repeats?|regulars|came back|had (?:been|come|bought) before|from (?:last|the (?:day|week|time) before))/.exec(
      t,
    );
  const whole = Number(m?.[1]);
  const same = Number(m?.[3]);
  if (m === null || !(same > 0) || same > whole) return null;
  const fresh = whole - same;
  const opens = `${upperFirst(word(same))} of the ${String(whole)} ${was(same)} from before, so ${word(fresh)} ${was(fresh)} new.`;
  const means =
    'That some come back is good to know, and it says nothing yet of how many new ones there are to reach.';
  return { kind: 'again', text: `${opens} ${means}`, voice: `${opens} ${means}` };
}

const PAYS =
  /^(?:paid|bought|ordered|rented|booked|signed|subscribed|prepaid|pre-?ordered|hired|purchased|donated)$/;
const LOOKS =
  /^(?:stopped|looked|saw|visited|walked|came|clicked|opened|took|tried|tasted|asked|signed|scanned|picked|joined|liked|followed)$/;

/** "80 walked by, 30 took a card, 6 bought": the last is what counts, of the first. */
function funnel(t: string): ToldCounts | null {
  const steps = [...t.matchAll(/(?<![\d.$~])(\d+) (?:people |of (?:them|those) |who )?([a-z]+)\b/g)]
    .map((m) => ({ n: Number(m[1]), did: m[2] ?? '' }))
    .filter((s) => PAYS.test(s.did) || LOOKS.test(s.did));
  const first = steps[0];
  const last = steps.at(-1);
  if (first === undefined || last === undefined || steps.length < 2 || !PAYS.test(last.did)) return null;
  if (steps.some((s, i) => i > 0 && s.n > (steps[i - 1]?.n ?? 0)) || last.n === 0) return null;
  const per = Math.round((last.n / first.n) * 100);
  const opens = `${upperFirst(word(last.n))} of the ${String(first.n)} who ${first.did} ${last.did}, about ${String(per)} in 100: that is the number that counts.`;
  const middle = steps.length > 2 ? steps.at(-2) : undefined;
  const means =
    middle === undefined
      ? 'Put a pass line next to it before the next time, and see whether it holds.'
      : `That ${String(middle.n)} ${middle.did} cost them nothing, so count which of them do it too.`;
  return { kind: 'funnel', text: `${opens} ${means}`, voice: `${opens} ${means}` };
}

/** "I did 4: 2 said they'd book, 1 laughed": a word is no booking, and a no is one thing to ask about. */
function talks(t: string): ToldCounts | null {
  const whole = Number(
    /\b(?:i|we)(?:['’]ve| have)? (?:also |just |finally |already )?(?:did|done|had|held|asked|interviewed|met|saw|talked (?:to|with)|spoke (?:to|with)|called|went to) (?:about |like |all )?(?<![\d.$~])(\d+)\b(?! ?(?:%|percent|dollars|hours?|minutes?|days?|weeks?|times))/.exec(
      t,
    )?.[1],
  );
  const said =
    /(?<![\d.$~])(\d+) (?:of (?:them|those) )?(?:said|says|promised|told me|swore)[^.,;]{0,24}?\b(?:(?:they|he|she|it)(?:['’]d| would|['’]ll| will)|would|will|yes)\b(?: (?:definitely|totally|probably|maybe))?(?: (book|buy|pay|use|try|come|order|rent|join|take|sign))?/.exec(
      t,
    );
  const yes = Number(said?.[1]);
  if (!(whole >= 2) || said === null || !(yes >= 1) || yes > whole) return null;
  const doing = said[2];
  const free = /(?<![\d.$~])(\d+) [^.,;]{0,40}\bfor free\b/.test(t);
  const what = doing === undefined ? 'said yes' : `said they would ${doing}`;
  const opens = `${upperFirst(word(yes))} of ${word(whole)} ${what}, and a word is not ${doing === 'book' ? 'a booking' : doing === 'pay' || doing === 'buy' ? 'money' : 'a yes you can count'} yet.`;
  const rest = whole - yes;
  const other =
    rest === 0
      ? ''
      : free
        ? `What the other ${rest === 1 ? 'one' : word(rest)} do now, one of them for free, is what you are up against.`
        : `The other ${rest === 1 ? 'one tells' : `${word(rest)} tell`} you what to ask next: what they do now.`;
  const test = `Ask the ${yes === 1 ? 'one' : word(yes)} for a day${doing === 'pay' || doing === 'buy' || doing === 'book' ? ' and a price' : ''} this week.`;
  return {
    kind: 'talks',
    text: [opens, other, test].filter((x) => x !== '').join(' '),
    voice: [opens, test].join(' '),
  };
}

/** What the counts of a message show; null: none that can be read one way. */
export function toldCounts(message: string): ToldCounts | null {
  const t = saidNumbers(message);
  return again(t) ?? talks(t) ?? funnel(t);
}

/** Whether they tell of talks they held. */
export const tellsTalks = (message: string): boolean =>
  talks(saidNumbers(message)) !== null ||
  /\b(?:i|we)(?:['’]ve| have)? (?:did|done|had|held) (?:\w+ )?\d+ (?:interviews?|talks?|conversations?|calls?)\b|\b(?:interviewed|talked (?:to|with)|spoke (?:to|with)) (?:about )?\d+\b/.test(
    saidNumbers(message),
  );
