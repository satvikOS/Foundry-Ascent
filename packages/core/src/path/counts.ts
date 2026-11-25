import { saidNumbers } from './calc.js';
import { ownSentences } from './kinds.js';
import { plain } from './words.js';

/**
 * How many of whom did what, as a founder says it ("two of the other four paid me", "only 3 of the 40", "none", "half of
 * them"): the number that did it, and never another one of the sentence. Exact, or not counted at all: an approximation, a
 * rate, a plan, a denial and what somebody else was paid count for nothing. Pure.
 */

/** What was done: money changed hands, something was signed, a spoken yes, a raised hand, a talk was held. */
export type Act = 'paid' | 'signed' | 'yes' | 'joined' | 'talked';

export interface Tally {
  readonly act: Act;
  /** How many did it: 0 when nobody did. */
  readonly count: number;
  /** Of how many, when they say it ("2 of the 30"); null: not said. */
  readonly whole: number | null;
  /** "Two more", "another two": added to what was told before. */
  readonly more: boolean;
  /** "In all", "so far", "by now": the total, whatever was told before. */
  readonly total: boolean;
  /** Friends or family: never strangers. */
  readonly friends: boolean;
  /** A number of things ("sold 16 boxes"), which may be fewer buyers: what they are; null: people, or not said. */
  readonly things: string | null;
  /** The sentence it stands in, by its place among the message's own ({@link ownSentences}). */
  readonly at: number;
}

/** A number taken back: what it is, and what it was said to be. */
export interface Correction {
  readonly is: number;
  readonly was: number | null;
  /** What it is a number of, when the sentence says so. */
  readonly act: Act | null;
  readonly at: number;
}

const APPROXIMATE =
  /\b(?:about|around|roughly|maybe|perhaps|probably|like|almost|nearly|approximately|up to|some|close to|under|less than|fewer than)\s+$/;
const AT_LEAST = /\b(?:at least|more than|over)\s+$/;
/** What follows a number that is no number of people or things. */
const OF_ANOTHER_KIND =
  /^(?:\s*%|\s*-\s*\d|\s*(?:percent|pct|dollars?|bucks?|cents?|usd|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|am|pm|o'clock|st|nd|rd|th|k|times|x)\b|\s*(?:or so|ish\b|or \d|to \d)|\s+(?:[a-z]+ )?(?:a|per|every|each) (?:day|week|month|year|hour)\b)/;

const COUNT = String.raw`(?:(?:the|all|only|just|exactly|another|other|these|those|my|our|first|last|a further|an additional|at least|more than|over) )*(?<![\d.$~])(\d+)(?![\d.]*[\d%~])`;
const WHOLE = String.raw`(?: (?:of|out of) (?:the |my |our |these |those |all |other |last |first |same |remaining |total )*(\d+))`;
/** Words between a number and what it did: who they are, never another thing that happened. */
const NOT_WHO =
  /\b(?:i|we|he|she|they|you|it|who i|that i|asked|offered|emailed|messaged|called|showed|said|says?|told|want(?:ed|s)?|think|thought|know|knew|and|but|or|if|because|while|so|then|to|than|not|never|except|besides|if)\b/;
const DID = String.raw`(?:have|has|had|already|actually|also|even|then|now|just|did|finally|each|both|all|immediately|happily|really|since|ever|in the end|today|yesterday|who|that|of them|of those|of these|of us)`;

const PAID_VERB = String.raw`(?:paid|bought|purchased|pre-?ordered|ordered|sold|put down (?:a |the |their )?deposits?|left (?:a |the |their )?deposits?)`;
const SIGNED_VERB = String.raw`signed(?! (?:up|in|off|on|out)\b)`;
const YES_VERB = String.raw`(?:said yes|agreed|committed|accepted)`;
const JOINED_VERB = String.raw`(?:signed up|joined|registered|subscribed|(?:left|gave|entered)(?: (?:me|us))? (?:an?|their|the) (?:emails?|e-mails?|email address(?:es)?|numbers?|contacts?))`;
const TALK_TO_ME = String.raw`(?:talked|spoke|chatted) (?:to|with) (?:me|us)`;

const SUBJECT_ACTS: readonly (readonly [Act, RegExp])[] = [
  ['joined', new RegExp(String.raw`\b${JOINED_VERB}\b`, 'g')],
  ['paid', new RegExp(String.raw`\b(?:${PAID_VERB}|pay (?:me|us))\b`, 'g')],
  ['signed', new RegExp(String.raw`\b${SIGNED_VERB}\b`, 'g')],
  ['yes', new RegExp(String.raw`\b${YES_VERB}\b`, 'g')],
  ['talked', new RegExp(String.raw`\b${TALK_TO_ME}\b`, 'g')],
];

const ME = String.raw`(?:i|we|my co-?founder|my team|our team)`;
const THING = String.raw`((?: (?!(?:and|but|or|who|that|which|to|from|for|at|in|on|with|said|told|asked|last|this|today|yesterday|each|every)\b)[a-z][a-z'&-]*){0,4})`;
/** What they did themselves, and how many of it stands after it. */
const OWN_ACTS: readonly (readonly [Act, RegExp])[] = [
  [
    'paid',
    new RegExp(
      String.raw`\b(?:${ME} (?:have |has |had |just |already |also |finally )*|^(?:and |so |also )?)(?:sold|got|have|had|won|closed|landed|took|received|collected)(?: it| them)?(?: to)? ${COUNT}${WHOLE}?${THING}`,
      'g',
    ),
  ],
  [
    'signed',
    new RegExp(
      String.raw`\b(?:${ME} (?:have |has |had |just |already |also |finally )*|^(?:and |so |also )?)(?:signed|got|have|closed|landed)(?! up\b| in\b)(?: up)? ${COUNT}${WHOLE}?${THING}`,
      'g',
    ),
  ],
  [
    'talked',
    new RegExp(
      String.raw`\b(?:interviewed|(?:talked|spoke|spoken|chatted|met|sat down|conversations?|talks?|calls?|interviews?) (?:to|with)|met) (?:with )?(?:my |our |the )?${COUNT}${WHOLE}?${THING}`,
      'g',
    ),
  ],
  [
    'talked',
    new RegExp(
      String.raw`\b(?:did|done|had|have had|held|ran|run|finished|completed|have) ${COUNT}${WHOLE}? (?:more |full |real |customer |problem |user |discovery |good |short |long )*(?:interviews?|talks?|conversations?|chats?|calls?(?= (?:with|to)\b))\b()`,
      'g',
    ),
  ],
  [
    'talked',
    new RegExp(
      String.raw`(?:^|[,;:] ?)${COUNT}${WHOLE}? (?:more |customer |problem |user )*(?:interviews?|talks?|conversations?)(?: (?:are |were )?(?:done|finished|completed|down|in|so far))\b()`,
      'g',
    ),
  ],
];
/** What `sold`, `got` or `have` is a number of, to be money: an order or a buyer, never any other thing. */
const MONEY_THING =
  /\b(?:paid|paying|pre-?orders?|orders?|sales?|deposits?|buyers?|customers?|clients?|subscribers?)\b/;
const SIGNED_THING =
  /\b(?:signed|contracts?|agreements?|letters? of intent|lois?|pilots?|deals?|clinics?|labs?|schools?|shops?|customers?|clients?|companies|compan(?:y|ies)|teams?|clubs?)\b/;
const NOT_SIGNED_THING = /\b(?:nda|ndas|waivers?|forms?|petitions?|leases?)\b/;

/** Who pays, whatever is bought. */
const PEOPLE =
  /\b(?:people|persons?|buyers?|customers?|clients?|subscribers?|users?|students?|strangers?|members?|companies|shops?|clinics?|labs?|schools?|clubs?|teams?|parents|families|pre-?orders?|orders?|deposits?|pilots?|sales?)\b/;

const FRIENDS =
  /\b(?:friends?|roommates?|housemates?|flatmates?|family|relatives?|cousins?|aunts?|uncles?|parents?|mom|mum|mother|dad|father|brothers?|sisters?|siblings?|girlfriend|boyfriend|grandparents?|classmates of mine)\b/;

const NOT_SAID =
  /\b(?:will|would|could|might|may|should|going to|plan(?:s|ned|ning)? to|wants? to|hopes? to|promised|promises|if|until|unless|almost|nearly)\b/;
const DENIED = /\b(?:not|never|without|nobody|no one|refused to|declined to)\b/;
const ELSEWHERE =
  /^ (?:for |to )?(?:someone|somebody|another|other|others|a competitor|a rival|the competition|elsewhere)\b/;

const normal = (sentence: string): string =>
  saidNumbers(
    plain(sentence)
      .replace(
        /\b(?:not (?:even )?(?:a )?single (?:one|person|[a-z]+)|not one|no-one|no one|nobody|none)\b/g,
        '0',
      )
      .replace(/\bneither(?: of them)?\b/g, '0')
      .replace(/\bzero\b/g, '0')
      .replace(/\bboth\b/g, 'all 2')
      .replace(/\ball but\b/g, 'all-but')
      .replace(/\b(\w+) (?:in|out of) every (\w+)\b/g, 'some'),
  ).replace(/(\d),(?=\d{3}\b)/g, '$1');

/** Clauses of a sentence: what one of them denies or plans says nothing of the next. */
const clausesOf = (text: string): string[] =>
  text
    .split(
      /\s*[;:!?]\s*|\.\s+|\s*,\s+(?=(?:and|but|while|though|so|then|yet|however|only|just|the rest|which|\d)\b)|\s*,\s+|\s+(?:but|while|though|although|whereas|yet|because|when|after|before|until|unless)\s+|\s+and\s+(?=(?:(?:then|only|just|also|another|the|all|at least|of them|of those|in the end) )*(?:\d+|i|we|they|he|she|nobody|the rest|the other|everyone)\b)|\s+-+\s+/,
    )
    .map((c) => c.replace(/[.!?\s]+$/, '').trim())
    .filter((c) => c !== '');

/** "Two of the other four" → [2, 4]; null: not a number they may be counted by. */
function readCount(
  text: string,
  index: number,
  whole: string,
  count: string,
  of: string | undefined,
): { readonly count: number; readonly whole: number | null } | null {
  const digits = index + whole.search(/\d/);
  const before = text.slice(0, digits);
  const lead = whole.slice(0, whole.search(/\d/));
  if (APPROXIMATE.test(before) || APPROXIMATE.test(lead)) return null;
  if (AT_LEAST.test(before) || AT_LEAST.test(lead)) return null;
  if (
    /\b(?:most|some|many|several|few|part|handful|couple|majority|any|half|third|quarter) of (?:the |my |our |these |those |all )*$/.test(
      before,
    )
  )
    return null;
  // "5 or 6 paid" and "1 in 5 paid" are no counts.
  if (/\d (?:or|to|and|in|in every|-) $/.test(before)) return null;
  const n = Number(count);
  const m = of === undefined ? null : Number(of);
  if (n >= 1900 && n <= 2100) return null;
  if (m !== null && (n > m || m === 0)) return null;
  if (n > 100_000) return null;
  return { count: n, whole: m };
}

interface Found {
  readonly count: number;
  readonly whole: number | null;
  readonly who: string;
}

const PARTS: readonly (readonly [RegExp, (n: number) => number])[] = [
  [/\bhalf (?:of )?(?:the |my |our |these |those )?(\d+)\b/, (n) => n / 2],
  [/\b(?:a|1) third of (?:the |my |our )?(\d+)\b/, (n) => n / 3],
  [/\b(?:a|1) quarter of (?:the |my |our )?(\d+)\b/, (n) => n / 4],
];

/** The number of who did it, read from the end of what stands before the verb. */
function subjectOf(before: string, known: number | null): Found | null {
  const left = before.replace(new RegExp(String.raw`(?:\s+${DID})+\s*$`), '').trimEnd();
  const butOf = /\ball-but (\d+)(?: of (?:the |my |our )?(\d+))?(?: [a-z]+){0,2}$/.exec(left);
  if (butOf !== null) {
    const whole = butOf[2] === undefined ? known : Number(butOf[2]);
    const n = whole === null ? null : whole - Number(butOf[1]);
    return n === null || n < 0 ? null : { count: n, whole, who: '' };
  }
  for (const [pattern, part] of PARTS) {
    const m = pattern.exec(left);
    if (m === null) continue;
    const n = part(Number(m[1]));
    return Number.isInteger(n) ? { count: n, whole: Number(m[1]), who: '' } : null;
  }
  const ofThem =
    /\b(half|(?:a|1) third|(?:a|1) quarter|all|everyone|everybody|each)(?: (?:of )?(?:them|those|these|us))?$/.exec(
      left,
    );
  if (ofThem !== null && !/\d+$/.test(left)) {
    if (known === null) return null;
    const share = (ofThem[1] ?? '').includes('half')
      ? 2
      : (ofThem[1] ?? '').includes('third')
        ? 3
        : (ofThem[1] ?? '').includes('quarter')
          ? 4
          : 1;
    const n = known / share;
    return Number.isInteger(n) ? { count: n, whole: known, who: '' } : null;
  }
  // The last number whose words reach the verb: "40 people and only 3" is 3, "2 of the other 4" is 2.
  const all = [...left.matchAll(new RegExp(String.raw`${COUNT}(?:(?: [a-z][a-z'&-]*){0,2}?${WHOLE})?`, 'g'))];
  const last = all.at(-1);
  if (last === undefined) return null;
  const who = left.slice(last.index + last[0].length);
  if (NOT_WHO.test(who) || /\d/.test(who) || who.split(/\s+/).length > 8) return null;
  if (OF_ANOTHER_KIND.test(who)) return null;
  const read = readCount(left, last.index, last[0], last[1] ?? '', last[2]);
  if (read === null) return null;
  return { ...read, who: `${last[0]} ${who}` };
}

const OFFERED =
  /\b(?:asked|offered|pitched|showed|shown|emailed|messaged|called|phoned|rang|visited|contacted|invited|approached|texted|interviewed|talked (?:to|with)|spoke (?:to|with)|met(?: with)?|demoed|demo(?:ed)? it to|tested (?:it )?(?:with|on))\b(?: (?:it|them|this|the [a-z]+|my [a-z]+|our [a-z]+|to|with|all))*? (?:the |all |my |our |another )*(?<![\d.$])(\d+)(?! ?(?:%|percent|dollars?|minutes?|hours?|days?|weeks?|months?|am|pm))\b/g;
const OFFERED_AFTER =
  /(?<![\d.$])(\d+) (?:[a-z'-]+ ){0,2}(?:(?:were |got )?(?:offered|asked|shown|emailed|invited|contacted)|saw|visited|viewed|opened)\b/g;

/** How many were asked, offered or shown it, when the text says one number of it. */
export function askedIn(text: string): number | null {
  const t = normal(text);
  const found = new Set<number>();
  for (const pattern of [OFFERED, OFFERED_AFTER])
    for (const m of t.matchAll(pattern)) found.add(Number(m[1]));
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

const MORE = /\b(?:more|another|additional|extra|others?|a further)\b/;
const TOTAL = /\b(?:in all|in total|altogether|all together|so far|by now|to date|overall|total)\b/;

/** Every number of the message that did something, exact. */
export function talliesIn(message: string): Tally[] {
  const own = ownSentences(message);
  const out: Tally[] = [];
  const add = (t: Tally): void => {
    if (!out.some((o) => o.act === t.act && o.at === t.at && o.count === t.count)) out.push(t);
  };
  let known: number | null = null;
  own.forEach((sentence, at) => {
    if (sentence.trim().endsWith('?')) return;
    const text = normal(sentence);
    const asked = askedIn(sentence);
    if (asked !== null) known = asked;
    const total = TOTAL.test(text);
    const outOf = /^(?:and |so )?(?:out of|of) (?:the |all |my |our )*(\d+)\b/.exec(text);
    for (const clause of clausesOf(text)) {
      if (/\b(?:except|besides|apart from|other than)\b/.test(clause)) continue;
      const taken: [number, number][] = [];
      for (const [act, pattern] of SUBJECT_ACTS)
        for (const m of clause.matchAll(pattern)) {
          const end = m.index + m[0].length;
          if (taken.some(([a, b]) => m.index < b && end > a)) continue;
          const before = clause.slice(0, m.index);
          const after = clause.slice(end);
          const denied = DENIED.test(before);
          if (NOT_SAID.test(before) || (act === 'paid' && ELSEWHERE.test(after))) continue;
          const found = subjectOf(before, known);
          if (found === null || (denied && found.count !== 0)) continue;
          taken.push([m.index, end]);
          const whole =
            found.whole ??
            (outOf === null ? null : Number(outOf[1])) ??
            (act !== 'talked' && known !== null && known >= found.count ? known : null);
          add({
            act,
            count: found.count,
            whole,
            more: MORE.test(found.who) && found.whole === null,
            total,
            friends: FRIENDS.test(found.who),
            things: null,
            at,
          });
        }
      for (const [act, pattern] of OWN_ACTS)
        for (const m of clause.matchAll(pattern)) {
          const end = m.index + m[0].length;
          if (taken.some(([a, b]) => m.index < b && end > a)) continue;
          const before = clause.slice(0, m.index);
          if (NOT_SAID.test(m[0]) || NOT_SAID.test(before) || DENIED.test(before) || DENIED.test(m[0]))
            continue;
          const things = m[3] ?? '';
          const after = `${things}${clause.slice(end)}`;
          if (OF_ANOTHER_KIND.test(after) && act !== 'talked') continue;
          if (act === 'talked' && OF_ANOTHER_KIND.test(after)) continue;
          if (act === 'paid') {
            const sold = /\bsold\b/.test(m[0]);
            if (!sold && !MONEY_THING.test(things)) continue;
            if (sold && things.trim() !== '') {
              // "Sold 40 cookies to 3 students": the buyers are the 3.
              const buyers = /^ to (?:the )?(\d+)\b/.exec(clause.slice(end));
              if (buyers !== null) {
                add({
                  act,
                  count: Number(buyers[1]),
                  whole: null,
                  more: false,
                  total,
                  friends: FRIENDS.test(after),
                  things: null,
                  at,
                });
                taken.push([m.index, end]);
                continue;
              }
            }
            if (/\b(?:signed|letters? of intent|lois?)\b/.test(things)) continue;
          }
          if (act === 'signed') {
            const verb = /\bsigned\b/.test(m[0].slice(0, m[0].search(/\d/)));
            if (NOT_SIGNED_THING.test(things)) continue;
            if (
              !verb &&
              !/\b(?:signed|letters? of intent|lois?)\b/.test(`${things}${clause.slice(end, end + 20)}`)
            )
              continue;
            if (verb && things.trim() !== '' && !SIGNED_THING.test(things) && !/^ [a-z]+s?$/.test(things))
              continue;
          }
          const read = readCount(clause, m.index, m[0], m[1] ?? '', m[2]);
          if (read === null) continue;
          taken.push([m.index, end]);
          add({
            act,
            count: read.count,
            whole: read.whole,
            more: MORE.test(m[0]),
            total,
            friends: act !== 'talked' && FRIENDS.test(things),
            things: act === 'paid' && things.trim() !== '' && !PEOPLE.test(things) ? things.trim() : null,
            at,
          });
        }
    }
  });
  return out;
}

/** The number of people who did `act` a message gives (never a number of things sold): of several, the largest (never their sum: they may be the same people). */
export function tallyOf(
  tallies: readonly Tally[],
  acts: readonly Act[],
  /** A share of things ("13 of 25 boxes") counts too: it is a rate, whoever bought them. */
  shares = false,
): Tally | null {
  return (
    tallies
      .filter(
        (t) => acts.includes(t.act) && !t.friends && (t.things === null || (shares && t.whole !== null)),
      )
      .sort((a, b) => b.count - a.count || a.at - b.at)[0] ?? null
  );
}

const CORRECTS =
  /\b(?:actually|correction|i meant|i mean|scratch that|i was wrong|i misspoke|my mistake|let me correct|i counted wrong|i miscounted|to correct (?:that|myself)|sorry,? (?:it|that) (?:was|is))\b/;

/** A number of theirs taken back ("actually it was three, not four"; "I said eight, it was six"); null: none. */
export function correctionOf(message: string): Correction | null {
  for (const [at, sentence] of ownSentences(message).entries()) {
    if (sentence.trim().endsWith('?')) continue;
    const t = normal(sentence);
    const num = String.raw`(?<![\d.$])(\d+)(?![\d%]|\.\d| ?(?:dollars?|percent|minutes?|hours?|days?|weeks?|months?))`;
    const not = new RegExp(
      String.raw`${num}\b[^.;]{0,60}?,? (?:and )?(?:not|instead of|rather than) (?:the )?${num}`,
    ).exec(t);
    const said = new RegExp(
      String.raw`\b(?:i|we) (?:said|told you|wrote|reported|counted)(?: it was| there were)? ${num}\b[^.;]{0,50}?\b(?:but|,|and|;)?\s*(?:it|that|there|the real number|the right number)(?: really| actually)? (?:was|is|were|are)(?: only| really| actually| just)? ${num}`,
    ).exec(t);
    const bare = CORRECTS.test(t) ? new RegExp(num).exec(t.slice(t.search(CORRECTS))) : null;
    const is = not?.[1] ?? said?.[2] ?? bare?.[1];
    if (is === undefined) continue;
    const was = not?.[2] ?? said?.[1] ?? null;
    const tally = talliesIn(sentence.replace(/,? (?:not|instead of|rather than) .*$/i, '.'))[0] ?? null;
    const act: Act | null =
      tally?.act ??
      (/\b(?:interviews?|talks?|conversations?)\b/.test(t)
        ? 'talked'
        : /\b(?:paid|paying|buyers?|bought|orders?|sales?|sold)\b/.test(t)
          ? 'paid'
          : null);
    if (was === null && act === null) continue;
    return { is: Number(is), was: was === null ? null : Number(was), act, at };
  }
  return null;
}

/** "6 of 20", "eleven out of 60": the parts of a whole a text says, each once. */
export function partsIn(
  text: string,
): { readonly part: number; readonly whole: number; readonly index: number }[] {
  const t = normal(text);
  return [
    ...t.matchAll(
      new RegExp(
        String.raw`(?<![\d.$])(\d+)(?: [a-z'-]+){0,2}?${WHOLE}(?! ?(?:minutes?|hours?|days?|weeks?|months?|am|pm|%|percent))`,
        'g',
      ),
    ),
  ].flatMap((m) => {
    const part = Number(m[1]);
    const whole = Number(m[2]);
    return part <= whole && whole > 1 ? [{ part, whole, index: m.index }] : [];
  });
}
