import { type UnderstoodSum } from '@foundry/ai';

import { bare, lowerFirst, upperFirst } from './tell.js';

/**
 * A sum of a reading as a mentor says it: one natural sentence with the figure, its working, and one line on what is and is
 * not in it. The figure and the working are code's (`@foundry/ai` understand/sums.ts); the label is the reading's, so it is
 * only ever turned around, never believed. Pure.
 */
export interface SumSaid {
  readonly text: string;
  readonly voice: string;
  /** What the figure counts or leaves out; '' when nothing plain can be said of it. */
  readonly aside: string;
}

export interface SumContext {
  /** The message and the record lines: what a bare count is of ("51 minutes"). */
  readonly texts?: readonly string[];
  /** The figure is what an offer would make the venture worth: no one's to state. */
  readonly worth?: boolean;
  /** They ask whether they still earn or lose: the figure answers with the word. */
  readonly earns?: boolean;
  /** They only suppose it ("say everybody pays"). */
  readonly supposed?: boolean;
  /** Earlier replies, oldest first: the figure said of the same thing before. */
  readonly replies?: readonly string[];
}

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Words a subject may put before its verb. */
const AUX =
  '(?:would|will|could|can|may|might|must|should|still|now|really|actually|each|have to|has to|had to|need to|needs to|get to|already|only|also|all|just)';
const COPULA = '(?:is|are|was|were|get|gets|got|be)';
const VERBS = new Set(
  (
    'left leaves leave brings brought bring costs cost makes made make earns earned earn pays paid pay comes came come keeps kept ' +
    'keep takes took take gives gave give is was are were saves saved loses lost spends spent sold sells needs need lasts last ' +
    'remains remain stays stay hits hit lands goes went reaches reach gets got adds add uses used returns yields works runs ran ' +
    'charges charged owes owed covers covered wants holds held'
  ).split(' '),
);
/** Verbs that may open a question whose subject is the figure itself ("what comes in"). */
const OPENS = new Set(
  'comes came come is was are remains remained stays stayed hits hit lands landed goes went reaches reached gets got'.split(
    ' ',
  ),
);
const PARTICIPLE =
  /^(?:paid|left|owed|made|earned|spent|kept|lost|saved|charged|going|getting|making|losing|paying|worth)$/u;

const spaced = (...parts: readonly (string | undefined)[]): string =>
  flat(parts.filter((p) => p !== undefined && p !== '').join(' '));

/** A clause without its question word, with the figure where the question left its hole; null: not one that is read. */
function filled(clause: string, said: string): string | null {
  const pronoun = new RegExp(
    `^((?:you|we|they|it|he|she|each of you)(?:['’](?:d|ll|re|ve))?(?: ${AUX})* (?:(?:${COPULA}) (?=[a-z]+))?)([a-z]+)\\b ?(.*)$`,
    'iu',
  ).exec(clause);
  if (pronoun !== null) {
    const [, before = '', verb = '', rest = ''] = pronoun;
    if (/^c[ao]mes?$/iu.test(verb)) return spaced(before, verb, 'to', said, rest.replace(/^to\b ?/iu, ''));
    // "what you need to break even": so many, to do it.
    const need = /^(.*\b(?:need|needs|have|has)) to$/iu.exec(before.trim());
    if (need !== null && /^(?:break|cover|earn|pay|reach|recover|match)$/iu.test(verb))
      return spaced(need[1], said, 'to', verb, rest);
    const copula = new RegExp(`\\b${COPULA}\\s*$`, 'iu').test(before.trim());
    // "what you are selling": no hole the figure fits into.
    if (copula && !PARTICIPLE.test(verb)) return null;
    return rest === '' || !/^(?:to|for|on|of|with|from|by)$/iu.test(rest)
      ? spaced(before, verb, said, rest)
      : null;
  }
  const words = clause.split(' ');
  const [first = ''] = words;
  if (OPENS.has(first.toLowerCase())) return spaced(said, clause);
  const at = words.findIndex((w, i) => i > 0 && VERBS.has(w.toLowerCase()));
  // Every word before it is its subject: a long one is a sentence of its own, and nothing is turned.
  if (at < 1 || at > 7) return null;
  const subject = words.slice(0, at).join(' ');
  const verb = (words[at] ?? '').toLowerCase();
  const rest = words.slice(at + 1);
  if (verb === 'come' || verb === 'comes' || verb === 'came') {
    const left = rest[0]?.toLowerCase() === 'to' ? rest.slice(1) : rest;
    return spaced(subject, verb, 'to', said, left.join(' '));
  }
  if (new RegExp(`^${COPULA}$`, 'u').test(verb)) return spaced(subject, verb, rest.join(' '), said);
  const [to = ''] = rest;
  if (/^(?:you|us|me|them|him|her)$/iu.test(to))
    return spaced(subject, verb, to, said, rest.slice(1).join(' '));
  return spaced(subject, verb, said, rest.join(' '));
}

const COMPARED = /^how much (\p{L}+er|better|worse|more|less)\s+(.+?)\s+(is|are|was|were|got|gets|get)$/iu;
const SUPERLATIVE =
  /^(?:the )?(fewest|least|lowest|smallest|minimum|most|highest|largest|biggest)(?: number of| amount of)?\b ?(.*)$/iu;
const NEEDED = /^(?:the )?(?:number of )?(.*?)\s*\b(?:needed|required|you need|you must sell)\b\s*(.*)$/iu;
const TO_REACH =
  /^(?:the )?(?:number of )?(\p{L}[\p{L} -]{1,24}?) to ((?:cover|break|earn|pay|reach|make|get|match|recover)\b.*)$/iu;

const isBare = (said: string): boolean => /^(?:about )?[\d,.]+$/u.test(said);

/** A count with what it is of, where the figure alone does not say it. */
const counted = (said: string, noun: string): string => {
  const what = bare(noun).toLowerCase();
  return isBare(said) && /^[a-z][a-z-]{2,20}(?: [a-z-]{2,20})?$/u.test(what) ? `${said} ${what}` : said;
};

/** A label that names a thing and asks nothing ("profit per bowl"). */
function named(label: string, said: string): string {
  // A question nothing could be put into.
  if (/^(?:what|how|whether|which|who|when|where|if)\b/iu.test(label)) return `That comes to ${said}`;
  const what = lowerFirst(label).replace(/^the (?=(?:runway|break.?even))/u, '');
  if (/^(?:your |the )?runway\b/u.test(what)) return `Your money lasts ${said}`;
  if (/^(?:your |the )?break.?even\b/u.test(what)) return `You break even at ${said}`;
  if (
    /^(?:the )?(?:(?:number of )?(?:months?|weeks?|days?|years?)|time) (?:until|till|before|left)\b.*\b(?:cash|money|runs? out|zero)\b/u.test(
      what,
    )
  )
    return `Your cash lasts ${said}`;
  const period =
    /^(?:your |the )?(monthly|weekly|daily|yearly) (?:profit or loss|profit|gain or loss|net)\b/u.exec(
      what,
    )?.[1];
  if (period !== undefined)
    return `${said} is left ${({ monthly: 'a month', weekly: 'a week', daily: 'a day', yearly: 'a year' } as Record<string, string>)[period] ?? ''}`;
  const head = /^(.*?)(?= (?:in|of|per|for|at|on|after|before|with|each|an?|from|by|that|when|if)\b|$)/u
    .exec(what)?.[1]
    ?.split(' ')
    .at(-1);
  const many = /[^s]s$/u.test(head ?? '') && !/^(?:gross|net|less|loss|basis)$/u.test(head ?? '');
  const verb = /%$|x$/u.test(said) ? (many ? 'are' : 'is') : many ? 'come to' : 'comes to';
  return `${upperFirst(label)} ${verb} ${said}`;
}

/** The figure as a sentence, without its full stop. */
function sentenceOf(raw: string, said: string, c: SumContext): string {
  const label = flat(bare(raw));
  if (label === '') return `That comes to ${said}`;
  const compared = COMPARED.exec(label);
  if (compared !== null) {
    const [, how = '', subject = '', verb = ''] = compared;
    return upperFirst(`${subject} ${verb} ${said} ${how.toLowerCase()}`);
  }
  if (c.worth === true && /\b(?:worth|valu\w+)\b/iu.test(label)) {
    const subject =
      /^(?:what|how much) (.+?) (?:is|are|would be|comes? out) (?:being )?(?:worth|valued)/iu.exec(
        label,
      )?.[1] ?? 'the whole venture';
    return `On paper that makes ${lowerFirst(subject)} worth ${said}`;
  }
  const asks = /^(?:what|how (?:much|long|far|often))\s+(.+)$/iu.exec(label)?.[1];
  if (asks !== undefined) {
    // "how much money you keep": what it is of is in the figure.
    const told = asks.replace(/^(?:money|cash|profit|time)\s+(?=(?:you|we|they|it|is|comes)\b)/iu, '');
    const made = filled(told, said);
    if (made !== null) return upperFirst(made);
  }
  const many = /^how many\s+(.+)$/iu.exec(label)?.[1];
  if (many !== undefined) {
    const m =
      /^(.*?)\s*\b((?:you|we|they|it|he|she)\b.*|(?:have|has|will|would|is|are|came|come|left|stay\w*|paid|pay)\b.*)$/iu.exec(
        many,
      );
    const made = m === null ? null : filled(m[2] ?? '', counted(said, m[1] ?? ''));
    if (made !== null) return upperFirst(made);
    if (m !== null) return upperFirst(spaced(counted(said, m[1] ?? ''), m[2]));
  }
  const superlative = SUPERLATIVE.exec(label);
  if (superlative !== null) {
    const [, most = '', rest = ''] = superlative;
    const noun = /^(\p{L}+s)\b/u.exec(rest)?.[1] ?? '';
    const of = isBare(said) && noun !== '' ? `${said} ${noun}` : said;
    const held = noun !== '' && of.toLowerCase().includes(noun.toLowerCase());
    const what = held ? rest.slice(noun.length).trim() : rest;
    return `The ${most.toLowerCase()}${what === '' ? '' : ` ${what}`} is ${of}`;
  }
  const needed = NEEDED.exec(label);
  if (needed?.[2] !== undefined && /^to \w/u.test(needed[2]))
    return `You need ${counted(said, needed[1] ?? '')} ${needed[2]}`;
  const reach = TO_REACH.exec(label);
  if (reach !== null && !said.includes('$'))
    return `You need ${counted(said, reach[1] ?? '')} to ${reach[2] ?? ''}`;
  const made = /^(?:the )?(?:amount|money|share|part) (?:that |which )?(.+)$/iu.exec(label)?.[1];
  if (made !== undefined && OPENS.has(made.split(' ')[0] ?? '')) return upperFirst(`${said} ${made}`);
  return named(label, said);
}

/** A working as it is shown: a percentage over a hundred is the share it is. */
export function tidyWorking(working: string): string {
  return flat(working).replace(/\((\d+(?:\.\d+)?)% ÷ 100\)/gu, (_m, n: string) =>
    String(Number((Number(n) / 100).toFixed(4))),
  );
}

/** A working as it is heard; '' when nobody could follow it. */
export function heardWorking(working: string): string {
  const steps = [...working.matchAll(/[×÷−+*/]/gu)].length;
  if (steps === 0 || steps > 3 || /[()]/.test(working)) return '';
  return working
    .replace(/\s*[×*]\s*/gu, ' times ')
    .replace(/\s*[÷/]\s*/gu, ' divided by ')
    .replace(/\s+[−-]\s+/gu, ' minus ')
    .replace(/\s*\+\s*/gu, ' plus ');
}

/** What a result of plain counts is of, when what it was worked out from says so ("74 − 51": "51 minutes"). */
function unitOf(s: UnderstoodSum, texts: readonly string[]): string {
  const noun = /^(?:about )?[\d,.]+(?: (.+))?$/u.exec(s.said)?.[1] ?? '';
  if ((s.unit !== 'units' && s.unit !== 'people') || /[×÷*/$%]/u.test(s.working)) return '';
  // A plural says what it is of already.
  if (/s$|^people$/iu.test(noun)) return '';
  for (const n of s.working.match(/\d[\d,.]*/gu) ?? [])
    for (const text of texts) {
      const m = new RegExp(`(?<![\\d.,])${n.replace(/[.]/gu, '\\.')} (\\p{Ll}{3,}s)\\b`, 'u').exec(text);
      if (m?.[1] !== undefined && !/(?:ss|us|is)$/u.test(m[1])) return m[1];
    }
  return '';
}

const KEEPS = /\b(?:keep|kept|left|leaves?|profit|pocket|stays?|remains?|take home|earn(?:s|ed)?)\b/iu;
const COMES_IN =
  /\b(?:comes? in|came in|bring\w*|brought|revenue|sales|takes? in|hits?|income|earn(?:s|ed)?|makes?)\b/iu;
const TO_COVER =
  /\b(?:earn\w* (?:\S+ ){0,3}back|cover\w*|pay\w* (?:off|back|for)|break.?even|recover\w*)\b/iu;

/** What a figure counts, or leaves out: only what its working shows. */
function asideOf(s: UnderstoodSum, working: string, c: SumContext): string {
  const label = s.label;
  if (c.worth === true && s.unit === '$')
    return 'That is what one offer implies, not a price anyone else has agreed to.';
  const operators = new Set(working.match(/[×÷−+]/gu) ?? []);
  if (s.unit === '$') {
    if (/\bhour\b/iu.test(label) && !operators.has('−')) return 'That is before any cost comes off.';
    if (operators.has('−') && KEEPS.test(label))
      return 'It takes off only the costs you named, and counts your own time as free.';
    if (operators.size === 1 && operators.has('×') && COMES_IN.test(label)) return 'That is before any cost.';
    return '';
  }
  if ((s.unit === 'units' || s.unit === 'people') && TO_COVER.test(label)) {
    return /÷ \$[\d,.]+$/u.test(working)
      ? 'That leaves out what each one costs you to make, so the real number is higher.'
      : '';
  }
  if (s.unit === 'months' && /^\$[\d,.]+ ÷ \$[\d,.]+$/u.test(working))
    return 'That holds only while nothing new comes in and you spend the same.';
  if (s.unit === '%') {
    const m = /^([\d,]+) ÷ ([\d,]+)$/u.exec(working);
    const whole = Number((m?.[2] ?? '').replace(/,/gu, ''));
    if (m !== null && whole > 0 && whole < 30)
      return `Out of only ${String(whole)}, one more or less moves it by ${String(Math.round(100 / whole))} points.`;
  }
  return '';
}

/** A loss is said as one, never as keeping less than nothing. */
function lossOf(label: string, said: string): string | null {
  const m =
    /^(?:what|how much)(?: money| cash)? (you|we|they|it) (?:still |now |would )*(\p{L}+) ?(.*)$/iu.exec(
      label,
    );
  if (m === null || !/^(?:keep|kept|earn|earned|make|made|have|had|get|got|pocket)$/iu.test(m[2] ?? ''))
    return null;
  const past = /^(?:kept|earned|made|had|got)$/iu.test(m[2] ?? '');
  return upperFirst(spaced(m[1], past ? 'lost' : 'lose', said, m[3]));
}

const TIMES: ReadonlySet<string> = new Set(['minutes', 'hours', 'days', 'weeks', 'months', 'years']);

/** The figure an earlier reply said of the same thing: "$88 is left each month: …"; null: none, or the same one. */
function figureBefore(
  now: string,
  figure: string,
  unit: string,
  replies: readonly string[],
): { readonly said: string; readonly value: number } | null {
  if (unit !== '$') return null;
  const words = (text: string): Set<string> =>
    new Set((text.toLowerCase().match(/[a-z]{4,}/gu) ?? []).map((w) => w.replace(/(?:ly|s)$/u, '')));
  const own = words(now);
  for (const reply of [...replies].reverse()) {
    // A server's sum: the sentence, a colon, its working.
    const m = /(?:^|\n|[.!?]\s)([^.:\n]*?(\$[\d,]+(?:\.\d\d)?)[^.:\n]*):\s(?=[(\d$])/u.exec(reply);
    if (m === null) continue;
    const said = m[2] ?? '';
    const shared = [...words(m[1] ?? '')].filter((w) => own.has(w)).length;
    if (shared === 0) continue;
    const value = Number(said.replace(/[$,]/gu, ''));
    return said === figure || !(value > 0) ? null : { said, value };
  }
  return null;
}

/** One sum as it is said. */
export function sumSaid(s: UnderstoodSum, c: SumContext = {}): SumSaid {
  const working = tidyWorking(s.working);
  const unit = unitOf(s, c.texts ?? []);
  const told = unit === '' ? s.said : `${/^(?:about )?[\d,.]+/u.exec(s.said)?.[0] ?? s.said} ${unit}`;
  // A time that did not come out whole is about that long.
  const figure =
    TIMES.has(s.unit) && /\.\d/u.test(told) && !told.startsWith('about ') ? `about ${told}` : told;
  const loss = s.unit === '$' && s.value < 0;
  const positive = figure.replace(/^[-−]/u, '');
  const label = flat(bare(s.label));
  const made = loss
    ? (lossOf(label, positive) ?? `${sentenceOf(s.label, positive, c)}, as a loss`)
    : sentenceOf(s.label, figure, c);
  const once = made.replace(/\b(is|are|was|were|comes|come) \1\b/giu, '$1');
  // A sum of money written bare in the label is the one its working shows with its sign.
  const main = once.replace(/(?<![$\d.,])(\d[\d,.]*)\b(?!%)/gu, (n: string, _g: string, at: number) => {
    const money = `$${Number(n.replace(/,/gu, '')).toLocaleString('en-US')}`;
    return once.slice(at - 4, at) === 'the ' && working.includes(money) ? money : n;
  });
  const heard = heardWorking(working);
  const aside = asideOf(s, working, c);
  const before = c.replies === undefined ? null : figureBefore(main, positive, s.unit, c.replies);
  const compared =
    before === null
      ? main
      : `${main}, ${before.value > Math.abs(s.value) ? 'down' : 'up'} from ${before.said}`;
  const earned = c.earns === true && s.unit === '$' ? (loss ? 'You lose: ' : 'You still earn: ') : '';
  const said =
    earned !== ''
      ? `${earned}${lowerFirst(compared)}`
      : c.supposed === true
        ? `If all of that came true, ${/^[$\d]/u.test(compared) ? compared : lowerFirst(compared)}`
        : compared;
  return {
    text: working === '' || working === s.said ? `${said}.` : `${said}: ${working}.`,
    voice: heard === '' ? `${said}.` : `${said}, ${heard}.`,
    aside,
  };
}
