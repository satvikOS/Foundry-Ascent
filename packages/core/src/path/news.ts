import { percent, ratiosIn, saidNumbers, type Ratio } from './calc.js';
import { asksFor, ownSentences, statesItHappened } from './kinds.js';
import { bare, lowerFirst, toYou, upperFirst } from './tell.js';
import { plain } from './words.js';

/**
 * What a message tells without asking ("nobody paid, but three caterers said they pay"; "13 of 25 sold"; "a customer
 * left"), and what it means: by rule, in their own words and numbers. Pure.
 */
export type NewsKind = 'split' | 'sold' | 'said' | 'concentration' | 'left' | 'offer' | 'interest';

export interface News {
  readonly kind: NewsKind;
  /** What it means, for a typed reply. */
  readonly means: string;
  /** The same on a call, shorter. */
  readonly spoken: string;
  readonly ratio: Ratio | null;
}

export interface NewsInput {
  readonly message: string;
  /** Their earlier messages here and the record, oldest first: where a pass line may have been set. */
  readonly before: readonly string[];
}

const NUM: Readonly<Record<number, string>> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
};
const said = (n: number): string => NUM[n] ?? String(n);

/** Money changed hands, or was promised in writing. */
const PAID = '(?:paid|pay|pays|bought|buy|ordered|pre-?ordered|signed|sold|said yes|subscribed)';
const NOBODY = `(?:nobody|no one|no-one|none of (?:them|the [a-z]+)|none|not one|not a single [a-z]+|0(?: of (?:them|the [a-z]+))?)`;
const GROUP_WORDS = '((?:[a-z-]+ ){0,2}[a-z-]+)';
const NOT_A_GROUP =
  /^(?:it|this|that|we|i|they|them|he|she|you|who|which|people|everyone|someone|nobody|one|but|and|and they|but they|of them|the|then|us|me)$/;

const group = (text: string | undefined): string | null => {
  const words = (text ?? '')
    .trim()
    .replace(
      /^(?:but|and|while|though|however|the|some|all|only|then|also|so|yet|most|many|a few|few)\s+/g,
      '',
    )
    .replace(/^(?:but|and|the|some|all|only)\s+/g, '');
  return words === '' || NOT_A_GROUP.test(words) ? null : words;
};

/** Who did not pay, and who does. */
function splitOf(
  message: string,
): { readonly not: string | null; readonly pays: string; readonly only: boolean } | null {
  const t = saidNumbers(message).replace(/[.;!?]\s+/g, ' . ');
  const none = new RegExp(
    `\\b${NOBODY}\\b(?: (?:of|in|from|on|at) (?:the |my |our )?${GROUP_WORDS}?)? (?:has |have |had |would |wanted to |actually |really )*${PAID}\\b|\\b${GROUP_WORDS} (?:did not|do not|would not|will not|never|have not) (?:want to |actually |really )?${PAID}\\b`,
  ).exec(t);
  if (none === null) return null;
  const paying = new RegExp(
    `(?:^|[.,;] |\\bbut |\\bwhile |\\band |\\bthough )(?:but |and |while )?((?:\\d+|all|most|some|several|the|our|two|three)? ?(?:[a-z-]+ ){0,2}?[a-z-]+) (?:(?:said|say|says|told me|told us|mentioned|admitted)(?: that)? (?:they |he |she |it )?(?:already |now |would |will |do |currently |each )*|already |now |currently |do |actually |each |have )*(?:pay|pays|paid|paying|spend|spends|bought|would pay|signed|ordered)\\b`,
    'g',
  );
  const rest = `${t.slice(0, none.index)} . ${t.slice(none.index + none[0].length)}`;
  for (const m of rest.matchAll(paying)) {
    const pays = group(m[1]);
    if (pays === null || /\b(?:not|never|nobody|no one|none)\b/.test(m[0])) continue;
    const before =
      group(none[1] ?? none[2]) ??
      group(
        /\b(?:to|with|for) (?:the |my |our )?([a-z-]+)(?: and| but|,| \.|$)/.exec(
          t.slice(0, none.index + 1),
        )?.[1],
      );
    const not = before === pays ? null : before;
    return { not, pays, only: /\b(?:said|says?|told|mentioned|admitted)\b/.test(m[0]) };
  }
  return null;
}

const COUNT_OF = /^\d+ /;

function splitNews(message: string): Pick<News, 'means' | 'spoken'> | null {
  const s = splitOf(message);
  if (s === null) return null;
  const n = /^(\d+) (.+)$/.exec(s.pays);
  const who = n === null ? s.pays : `${said(Number(n[1]))} ${n[2] ?? ''}`;
  const customer = s.pays.replace(COUNT_OF, '');
  const not = s.not === null ? 'The first group did not pay' : `${upperFirst(s.not)} did not pay`;
  const pay = s.only ? 'say they pay' : 'do';
  return {
    means: `${not} and ${who} ${pay}: ${customer} are the customer to test. What people pay for today counts more than what they like.`,
    spoken: `${not} and ${who} ${pay}, so ${customer} are the customer to test.`,
  };
}

/** The line they set before a test ("pass line: 8 of 20", "I need at least 10"); null when none is told. */
export function passLine(
  texts: readonly string[],
): Ratio | { readonly part: number; readonly whole: null } | null {
  for (const text of [...texts].reverse()) {
    const t = saidNumbers(text);
    const found =
      /\b(?:pass line|pass mark|passing line|target|goal|bar)\b[^.;]{0,40}?(\d+)(?: (?:[a-z]+ )?(?:of|out of) (\d+))?/.exec(
        t,
      ) ??
      /\b(?:at least|needs? (?:to be )?|counts? as a (?:pass|yes) (?:if|at)) (\d+) (?:of|out of) (\d+)/.exec(
        t,
      );
    if (found === null) continue;
    const part = Number(found[1]);
    const whole = found[2] === undefined ? null : Number(found[2]);
    if (whole === null) return { part, whole: null };
    if (part <= whole) return { part, whole };
  }
  return null;
}

const SOLD = new RegExp(`\\b(?:${PAID.slice(3, -1)}|sales?|orders?|customers?|converted)\\b`);
/** A part of a whole that paid or promised to, in one sentence or across two ("offered it to 25 gyms, and 13 said yes"). */
function resultIn(text: string): Ratio | null {
  const t = plain(text).replace(/\bsigned up\b/g, 'joined');
  if (!SOLD.test(t) || /\bwould (?:pay|buy)\b/.test(t)) return null;
  const numbers = saidNumbers(text)
    .replace(/\bsigned up\b/g, 'joined')
    .replace(/\$\d[\d.]*/g, '$');
  const direct = ratiosIn(numbers)[0];
  if (direct !== undefined) return direct;
  const m = ACROSS.exec(numbers);
  if (m === null) return null;
  const ratio = { part: Number(m[2]), whole: Number(m[1]) };
  return ratio.part <= ratio.whole && ratio.whole >= 3 ? ratio : null;
}

const ACROSS =
  /\b(?:offered|asked|pitched|showed|emailed|messaged|called|visited|talked to|spoke to)\b[^.]*?\b(\d+) (?!dollars?|percent|minutes|days|weeks|hours|months)[a-z][^]*?(?:\band|\bbut|[.,;]) ?(?:only |just )?(\d+)(?: of (?:them|those|the [a-z]+))? (?:[a-z-]+ )?(?:paid|bought|ordered|pre-?ordered|subscribed|signed|said yes)\b/;

const SAYS_SAME =
  /\b(?:said|told (?:me|us)|mentioned|described|named|complained|asked|want(?:ed)?|have|had|use|used|liked|loved)\b/;

/** The result read against the line that was set first, and what would make it good. */
export function readResult(
  ratio: Ratio,
  before: readonly string[],
  noun = 'people',
): { readonly text: string; readonly spoken: string } {
  const rate = `${String(ratio.part)} of ${String(ratio.whole)} is ${percent(ratio.part, ratio.whole)}`;
  const line = passLine(before);
  if (line !== null) {
    const over =
      line.whole === null ? ratio.part >= line.part : ratio.part / ratio.whole >= line.part / line.whole;
    const set = line.whole === null ? String(line.part) : `${String(line.part)} of ${String(line.whole)}`;
    const text = over
      ? `${rate}. The number to beat was ${set}, so it passed: the next question is whether one sale leaves money over.`
      : `${rate}. The number to beat was ${set}, so it did not pass: change one thing, the customer, the offer or the price, and run it once more.`;
    return { text, spoken: text };
  }
  return {
    text: `${rate}. No pass line (the number that means it worked) was set first, so treat it as a first reading: write that number for the next ${String(ratio.whole)} ${noun} before you ask them. It is good if strangers repeat it and one sale leaves money over.`,
    spoken: `${rate}. You set no number to beat first, so it is a first reading: set it, then ask the next ${String(ratio.whole)}.`,
  };
}

/** What a share of their sales in few hands means. */
function concentrationNews(message: string): Pick<News, 'means' | 'spoken'> | null {
  const t = saidNumbers(message);
  const m =
    /(?<![\d.$])(\d+) (?:of|out of) (?:the |my |our |all )?(\d+) (?:[a-z-]+ ){0,4}?(?:came|come|are|were|was) (?:from|through|by|via) (?:the same |just |only )?((?:\d+|a|an|one) (?:[a-z-]+ ){0,2}?[a-z-]+)(?=[.,;!?]|$| and| but| who)/.exec(
      t,
    );
  if (m === null) return null;
  const part = Number(m[1]);
  const whole = Number(m[2]);
  if (part * 2 < whole || part > whole) return null;
  const from = bare(m[3] ?? '').replace(/^(\d+) /, (_x, d: string) => `${said(Number(d))} `);
  const head = `${String(part)} of ${String(whole)} (${percent(part, whole)}) came through ${from}`;
  return {
    means: `${head}: that is the way people buy from you today, so copy it first. It is also a risk while it hangs on so few.`,
    spoken: `${head}. That is how people buy from you today, so copy it first.`,
  };
}

const LEFT =
  /\b(?:a|one|our|my|the|another|first|biggest|\d+(?: of (?:our|my|the))?) ?(?:[a-z-]+ ){0,2}(?:customers?|clients?|users?|subscribers?|buyers?|members?|labs?|clinics?|schools?|shops?) (?:(?:just|has|have|already|suddenly) )*(?:left|cancel(?:l)?ed|quit|churned|dropped (?:out|us)|stopped (?:paying|buying|using|coming)|did not renew|asked for (?:a|their) refund)\b|\bwe lost (?:a|one|our|\d+) (?:[a-z-]+ ){0,2}(?:customers?|clients?|users?|subscribers?)\b/;
const OFFER =
  /\b(?:offered|wants?|would like|asked|proposed|agreed) (?:to|us|me)(?: to)? (?:partner|sponsor|collaborate|work (?:together|with)|host|promote|stock|carry|distribute|sell (?:it|our|my)|pilot|try|fund|invest|join|help)\b|\b(?:offered|proposed|wants?) (?:us |me )?(?:a|an) (?:partnership|pilot|collaboration|sponsorship|deal|space|table|booth)\b/;
const INTEREST =
  /(?<![\d.$])(\d+(?: (?:of|out of) \d+)?) (?:[a-z-]+ ){0,2}(?:signed up|joined (?:the|our|my) (?:wait ?list|list|group)|liked|followed|clicked|downloaded|registered|filled (?:in|out))\b|\b(?:got|have) (\d+) (?:[a-z-]+ ){0,1}(?:sign-?ups?|likes|followers|downloads|waitlist|views|clicks)\b/;

/** The news of a message; null when it asks, or tells nothing of the kind. */
export function newsOf(input: NewsInput): News | null {
  const { message } = input;
  const told = ownSentences(message).filter((s) => !s.trim().endsWith('?'));
  if (told.length === 0) return null;
  const text = told.join(' ');
  if (
    asksFor(text) ||
    /\b(?:if|should|might|would like to|going to|will|plan to)\b/.test(
      plain(text).replace(/\bwould pay\b/g, ''),
    )
  )
    return null;
  const split = splitNews(text);
  if (split !== null) return { kind: 'split', ratio: null, ...split };
  const concentration = concentrationNews(text);
  if (concentration !== null) return { kind: 'concentration', ratio: null, ...concentration };
  const happened = told.filter((s) => statesItHappened(s));
  const flat = plain(text);
  for (const sentence of [...happened, text]) {
    const result = resultIn(sentence);
    if (result !== null) {
      const read = readResult(result, input.before);
      return { kind: 'sold', means: read.text, spoken: read.spoken, ratio: result };
    }
    const ratio = ratiosIn(saidNumbers(sentence).replace(/\$\d[\d.]*/g, '$'))[0];
    if (ratio === undefined) continue;
    const found = saidFinding(sentence, ratio);
    if (found !== null) return { kind: 'said', ratio, ...found };
  }
  // "I did eight interviews. Six of them said…": the whole is in the sentence before.
  const pattern = saidAcross(told);
  if (pattern !== null) return pattern;
  if (LEFT.test(flat))
    return {
      kind: 'left',
      ratio: null,
      means:
        'One leaving tells you more than ten staying, if you ask while it is fresh: what they used it for, what changed, and what they use now. Until you know, do not add new ones on top.',
      spoken: 'Ask while it is fresh: what they used it for, what changed, and what they use now.',
    };
  if (OFFER.test(flat))
    return {
      kind: 'offer',
      ratio: null,
      means:
        'An offer is a door, not a result yet. It counts when they give something: a date, a table, an email to their people, or money. So answer with one small test and its day, and write down who does what.',
      spoken:
        'It counts when they give something: a date, a table, or an email to their people. Answer with one small test.',
    };
  const interest = INTEREST.exec(saidNumbers(text));
  if (interest !== null) {
    const n = interest[1] ?? interest[2] ?? '';
    return {
      kind: 'interest',
      ratio: null,
      means: `${n} raised a hand, and none of that is money yet. The test is to ask some of them to pay now, at a real price, and count the yeses.`,
      spoken: `${n} raised a hand, and that is not money yet. Ask some of them to pay now and count the yeses.`,
    };
  }
  return null;
}

function finding(sentence: string): string | null {
  const m = /\b(?:said|told (?:me|us)|mentioned|complained)(?: that)? (.+)$/iu.exec(bare(sentence));
  const what = m?.[1]?.trim() ?? '';
  return what.split(/\s+/).length >= 3 ? lowerFirst(toYou(bare(what))) : null;
}

function saidMeans(ratio: Ratio, what: string | null): Pick<News, 'means' | 'spoken'> {
  const share = `${String(ratio.part)} of ${String(ratio.whole)} (${percent(ratio.part, ratio.whole)})`;
  const same = what === null ? `${share} said the same thing` : `${share} said ${what}`;
  const strong = ratio.part * 2 >= ratio.whole;
  return strong
    ? {
        means: `${same}: more than half is a pattern, so it leads now. It shows the problem, not yet that they would pay to have it gone.`,
        spoken: `${same}. More than half is a pattern, and it does not show yet that they would pay.`,
      }
    : {
        means: `${same}: less than half is not a pattern yet. Find what those ${String(ratio.part)} have in common before you build for them.`,
        spoken: `${same}. Less than half is not a pattern yet: find what those ${String(ratio.part)} have in common.`,
      };
}

function saidFinding(sentence: string, ratio: Ratio): Pick<News, 'means' | 'spoken'> | null {
  if (!SAYS_SAME.test(plain(sentence)) || ratio.whole < 3) return null;
  return saidMeans(ratio, finding(sentence));
}

/** "I did eight interviews. Six of them said…", "I talked to six people and four said…". */
function saidAcross(told: readonly string[]): News | null {
  const text = told.join(' ');
  const t = saidNumbers(text);
  const m =
    /(?:^|[.,;] )(\d+) (?:interviews?|talks?|conversations?|calls?|people)\b.*?(?:[.,;]|\band|\bbut) ?(\d+)(?: of (?:them|those))?(?: [a-z-]+)?? (?:said|told (?:me|us)|mentioned)\b/.exec(
      t,
    ) ??
    /\b(?:did|held|had|ran|talked (?:to|with)|spoke (?:to|with)|interviewed|asked|met(?: with)?) (?:all |about )?(\d+)\b.*?(?:(?:\band|\bbut|[.,;]) ?)(\d+)(?: of (?:them|those|the \w+))?(?: [a-z-]+)?? (?:said|told (?:me|us)|mentioned|asked|complained|described|wanted)\b/.exec(
      t,
    );
  if (m === null) return null;
  const ratio = { part: Number(m[2]), whole: Number(m[1]) };
  if (ratio.part > ratio.whole || ratio.whole < 3) return null;
  const at = told.find((s) => /\b(?:said|told (?:me|us)|mentioned|complained)\b/i.test(s));
  if (/\basked (?:when|how|if)\b/.test(t) && at === undefined)
    return {
      kind: 'said',
      ratio,
      means: `${String(ratio.part)} of ${String(ratio.whole)} (${percent(ratio.part, ratio.whole)}) asked for it without being sold to. That is interest you can test today: ask those ${String(ratio.part)} to pay now.`,
      spoken: `${String(ratio.part)} of ${String(ratio.whole)} asked for it. Test that now: ask those ${String(ratio.part)} to pay.`,
    };
  const what = at === undefined ? null : finding(at);
  return { kind: 'said', ratio, ...saidMeans(ratio, what) };
}

const IS_IT_GOOD =
  /\bis (?:that|this|it) (?:any )?(?:good|great|ok|okay|enough|bad|normal|promising|a (?:good|bad|strong|weak) (?:sign|signal|result|number|rate))\b|\bhow good (?:is|was) (?:that|it|this)\b|\bis \d+ (?:of|out of) \d+ (?:good|enough|ok)\b|\bgood or bad\b|\bdid (?:it|that|we) pass\b/;

/** "Is that good?" of the result told last. */
export function asksIfGood(message: string): boolean {
  return IS_IT_GOOD.test(saidNumbers(message));
}

/** The last result they told (a part of a whole that paid), newest first. */
export function lastResult(texts: readonly string[]): Ratio | null {
  for (const text of [...texts].reverse()) {
    for (const sentence of [...ownSentences(text)].reverse().concat([text])) {
      const ratio = resultIn(sentence);
      if (ratio !== null) return ratio;
    }
  }
  return null;
}
