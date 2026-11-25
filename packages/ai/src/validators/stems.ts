import { spelledNumbersIn } from './figures.js';

/**
 * Content words for checking what a sentence shares with another text (a cited source, the path's step): lower-cased,
 * without the words every sentence has, reduced to a stem so "interviews", "interviewed" and "interviewing" meet.
 * Number words become their digits ("twenty" meets "20").
 */

const STOP = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being below between both but by ' +
    'can cannot could did do does doing done down during each either few for from further get gets getting go goes going got had ' +
    'has have having he her here hers him his how i if in into is it its itself just let lets make makes me might more most much must ' +
    'my need needs no nor not now of off on once one only or other our ours out over own per please put same say says she should ' +
    'so some someone something such than that the their them then there these they thing things this those through to too ' +
    'under until up upon use us very want wants was way we were what when where whether which while who whom whose why will ' +
    'with within without would yes yet you your yours really even still back first next like know think good take start'
  ).split(' '),
);

const IRREGULAR: Readonly<Record<string, string>> = {
  people: 'person',
  men: 'man',
  women: 'woman',
  children: 'child',
  paid: 'pay',
  sold: 'sell',
  bought: 'buy',
  wrote: 'write',
  written: 'write',
  told: 'tell',
  spoke: 'speak',
  spoken: 'speak',
  met: 'meet',
  ran: 'run',
  sent: 'send',
  built: 'build',
  made: 'make',
  found: 'find',
  chose: 'choose',
  chosen: 'choose',
  gave: 'give',
  given: 'give',
  kept: 'keep',
  left: 'leave',
  said: 'say',
  asked: 'ask',
  analyses: 'analysi',
  analysis: 'analysi',
  hypotheses: 'hypothesi',
  hypothesis: 'hypothesi',
  criteria: 'criterion',
};

const NUMBER_WORD =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b/i;

/** A light suffix stemmer: plurals, -ing, -ed, -er, -ly, -ment, -ness, -tion, with a doubled consonant undone. */
export function stemOf(word: string): string {
  const w = word
    .toLowerCase()
    .replace(/['’]s$/, '')
    .replace(/['’]/g, '');
  const irregular = IRREGULAR[w];
  if (irregular !== undefined) return irregular;
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  const undouble = (x: string): string => (/([bdfgmnprt])\1$/.test(x) ? x.slice(0, -1) : x);
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (/(?:ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
  if (s.endsWith('ing') && s.length > 5) s = undouble(s.slice(0, -3));
  else if (s.endsWith('ied') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('ed') && s.length > 4) s = undouble(s.slice(0, -2));
  if (s.endsWith('ly') && s.length > 5) s = s.slice(0, -2);
  if (s.endsWith('ement') && s.length > 7) s = s.slice(0, -4);
  else if (s.endsWith('ment') && s.length > 6) s = s.slice(0, -4);
  if (s.endsWith('ation') && s.length > 7) s = s.slice(0, -5);
  else if (s.endsWith('tion') && s.length > 6) s = s.slice(0, -3);
  if (s.endsWith('er') && s.length > 5) s = undouble(s.slice(0, -2));
  else if (s.endsWith('or') && s.length > 6) s = s.slice(0, -2);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('y') && s.length > 4) s = `${s.slice(0, -1)}i`;
  return s;
}

/** The content stems of `text`; with its spelled-out numbers as digits. Markdown and citation keys are not words. */
export function stemsOf(text: string): Set<string> {
  const out = new Set<string>();
  const plain = text
    .replace(/\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/gi, ' ')
    .replace(/\]\([^)\s]*\)/g, ' ')
    .normalize('NFKC');
  for (const match of plain.matchAll(/\d[\d,.]*\d|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    const token = match[0];
    const parts = token.includes('-') ? [token, ...token.split('-')] : [token];
    for (const part of parts) {
      const word = part.toLowerCase().replace(/^['’-]+|['’-]+$/g, '');
      if (word === '' || STOP.has(word)) continue;
      if (/^\d/.test(word)) {
        out.add(word.replace(/,/g, ''));
        continue;
      }
      if (word.length < 2 || NUMBER_WORD.test(word)) continue;
      out.add(stemOf(word));
    }
  }
  if (NUMBER_WORD.test(plain)) for (const n of spelledNumbersIn(plain)) out.add(String(n));
  return out;
}

/** How many of `a`'s members `b` has. */
export function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

/** The share of `a` that `b` has (1 for an empty `a`). */
export function coverage(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  return a.size === 0 ? 1 : sharedCount(a, b) / a.size;
}
