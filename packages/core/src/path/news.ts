import { percent, ratiosIn, saidNumbers, type Ratio } from './calc.js';
import { partsIn, talliesIn, tallyOf, type Tally } from './counts.js';
import { asksFor, ownSentences, statesItHappened } from './kinds.js';
import { bare, lowerFirst, toYou, upperFirst } from './tell.js';
import { numberOf, plain } from './words.js';

/**
 * What a message tells without asking ("nobody paid, but three caterers said they pay"; "13 of 25 sold"; "a customer
 * left"), and what it means: by rule, in their own words and numbers. Pure.
 */
export type NewsKind =
  | 'split'
  | 'sold'
  | 'paid'
  | 'yes'
  | 'said'
  | 'barrier'
  | 'concentration'
  | 'left'
  | 'offer'
  | 'interest'
  | 'cold'
  | 'refusal'
  | 'pull'
  | 'limit'
  | 'change';

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

/** A part of a whole that paid or signed, or said yes (counts.ts), in one sentence or across two. */
function resultIn(text: string): Ratio | null {
  const tallies = talliesIn(text);
  const t = tallyOf(tallies, ['paid', 'signed'], true) ?? tallyOf(tallies, ['yes']);
  return t?.whole == null ? null : { part: t.count, whole: t.whole };
}

/** What they did, in the word they used. */
const didIn = (t: Tally, told: string): string =>
  t.act === 'signed'
    ? 'signed'
    : t.act === 'yes'
      ? 'said yes'
      : (/\b(?:sold|bought|pre-?ordered|ordered)\b/.exec(plain(told))?.[0] ?? 'paid');

const SAYS_SAME =
  /\b(?:said|told (?:me|us)|mentioned|described|named|complained|asked|want(?:ed)?|have|had|use|used|liked|loved)\b/;

/** The result read against the line that was set first, and what would make it good. */
export function readResult(
  ratio: Ratio,
  before: readonly string[],
  noun = 'people',
  /** What they did, in their word ("sold"); absent: not known. */
  did?: string,
): { readonly text: string; readonly spoken: string } {
  const of = `${String(ratio.part)} of ${String(ratio.whole)}`;
  const share = percent(ratio.part, ratio.whole);
  const rate = did === undefined ? `${of} is ${share}` : `${of} ${did}, which is ${share}`;
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
  if (ratio.part === 0)
    return {
      text: `${rate}. Nobody took it, so change one thing, the customer, the offer or the price, and set the number that would count as a yes before you ask again.`,
      spoken: `${rate}. Change one thing, the customer, the offer or the price, and ask again.`,
    };
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
  /\b(?:got|have) (\d+) (?:[a-z-]+ ){0,1}(?:sign-?ups?|likes|followers|downloads|waitlist|views|clicks)\b|(?<![\d.$])(\d+) (?:[a-z-]+ ){0,2}(?:liked|followed|clicked|downloaded|filled (?:in|out))\b/;

const word = (n: number): string => said(n);
const theN = (n: number): string => (n === 1 ? 'that one' : `those ${word(n)}`);

/** Payments with no whole to read them against, or a whole too small for a share. */
function paidNews(t: Tally): Pick<News, 'means' | 'spoken'> | null {
  if (t.count === 0)
    return {
      means:
        'No sale is a result too. Change one thing, the customer, the offer or the price, set the number that would count as a yes, and ask again.',
      spoken:
        'No sale is a result too. Change one thing, set the number that counts as a yes, and ask again.',
    };
  const did = t.act === 'signed' ? 'signed' : 'paid';
  const who =
    t.whole === null
      ? `${upperFirst(word(t.count))} ${did}`
      : `${upperFirst(word(t.count))} of ${word(t.whole)} ${did}`;
  const ask = t.count === 1 ? 'Ask that one' : t.count === 2 ? 'Ask both' : `Ask all ${word(t.count)}`;
  return {
    means:
      `${who}, and that is worth more than any number of sign-ups: somebody wanted it enough to pay for it or to sign. ${ask} what made them do it, and make the next ten people the same offer at the same price.`.replace(
        'to pay for it or to sign',
        did === 'paid' ? 'to pay' : 'to sign',
      ),
    spoken: `${who}, and that is worth more than any sign-up. ${ask} why, then make ten more the same offer.`,
  };
}

/** Things sold, and not how many bought them. */
function thingsNews(t: Tally): Pick<News, 'means' | 'spoken'> {
  const what = `${upperFirst(word(t.count))} ${toYou(t.things ?? '')} sold`;
  return {
    means: `${what} is real money, so count the buyers behind it too: write who bought, how each one found you and who came back. The buyers are the number that grows.`,
    spoken: `${what} is real money. Now count the buyers behind it, and how each one found you.`,
  };
}

/** A spoken yes: a promise, and no sale yet. */
function yesNews(t: Tally): Pick<News, 'means' | 'spoken'> | null {
  if (t.count === 0) return null;
  const of = t.whole === null ? '' : ` of ${String(t.whole)} (${percent(t.count, t.whole)})`;
  const n = t.whole === null ? upperFirst(word(t.count)) : String(t.count);
  return {
    means: `${n}${of} said yes. That shows interest, and a yes is a promise until it is paid or signed, so ask ${theN(t.count)} this week for the money or a signature, with the price and the start day on it.`,
    spoken: `${n}${of} said yes, and that counts once it is paid or signed. Ask ${theN(t.count)} for that this week.`,
  };
}

const LIKES = '(?:love|loved|like|liked|want|wanted|would use|would love|need|enjoy(?:ed)?|prefer(?:red)?)';
const STOPPED =
  '(?:have no|has no|had no|do not have|does not have|did not have|cannot|can not|could not|are not allowed|is not allowed|lack|lacks|said (?:that )?they (?:have no|cannot|do not have))';

/** "Seven love it, but six of those have no space": what stops them is not the idea. */
function barrierNews(message: string): Pick<News, 'means' | 'spoken'> | null {
  const t = saidNumbers(message).replace(/[.!]\s+/g, ' . ');
  const m = new RegExp(
    `(?<![\\d.$])(\\d+) (?:of (?:them|those|the \\d+) )?(?:[a-z]+ ){0,2}?${LIKES}\\b[^.]*?[,.]? ?\\b(?:but|however|though|yet|and)\\b ?(\\d+)(?: of (?:them|those|these|the \\d+))? (?:[a-z]+ ){0,1}?(${STOPPED}\\b[^.;]*)`,
  ).exec(t);
  if (m === null) return null;
  const likes = Number(m[1]);
  const stopped = Number(m[2]);
  if (stopped > likes || stopped === 0) return null;
  const what = bare(toYou(m[3] ?? '')).replace(/\b1\b/g, 'one');
  const free = likes - stopped;
  const head = `${String(stopped)} of the ${String(likes)} who want it ${what}`;
  const next =
    free === 0
      ? 'Solve that on paper with one of them before you make anything more.'
      : `Start with ${free === 1 ? 'the one who does not have that problem' : `the ${word(free)} who do not have that problem`}, and solve it on paper with one of the others before you make anything more.`;
  return {
    means: `${head}. That shows what stops them, and it is not the idea. ${next}`,
    spoken: `${head}. That shows what stops them, and it is not the idea. ${free === 0 ? 'Solve that first.' : `Start with the ${free === 1 ? 'one' : word(free)} who can, and solve it for the others.`}`,
  };
}

/** A result read a moment ago, asked about again: what is enough, and what to ask. */
export function readAgain(ratio: Ratio): string {
  const no = ratio.whole - ratio.part;
  const yes =
    ratio.part === 0
      ? ''
      : `ask ${ratio.part === 1 ? 'the one who said yes' : `the ${word(ratio.part)} who said yes`} why, `;
  return `${String(ratio.part)} of ${String(ratio.whole)} is ${percent(ratio.part, ratio.whole)}, and no number was set to beat, so it is not enough to decide on yet. Before the next round, ${yes}ask ${no <= 5 ? 'the others' : 'five of the others'} what stopped them, and write down the number that would be enough.`;
}

const COLD =
  /(?<![\d.$])(\d+)(?: of (?:them|those|these|the (\d+)))? (?:[a-z]+ ){0,2}?(?:did not|do not|could not|can not|cannot) (?:even |really )?(?:remember|recall|know (?:what|who|why))\b/;

/** Sign-ups that do not remember it. */
function coldNews(message: string): Pick<News, 'means' | 'spoken'> | null {
  const t = saidNumbers(message);
  const m = COLD.exec(t);
  if (m === null) return null;
  const n = Number(m[1]);
  const told =
    /\b(?:phoned|called|rang|emailed|messaged|asked|texted|reached)\b[^.]*?(?:the |all |those )+(\d+)\b/.exec(
      t.slice(0, m.index),
    );
  const whole = m[2] ?? told?.[1];
  const left = whole === undefined ? null : Number(whole) - n;
  const of = whole === undefined ? String(n) : `${String(n)} of the ${whole}`;
  const rest =
    left === null || left <= 0
      ? 'Sell to the ones who remember, today, and leave the rest.'
      : `Offer it to ${left === 1 ? 'the one' : `the other ${word(left)}`} today, at a price, and leave the rest.`;
  return {
    means: `${of} did not remember it, so an email address is weaker than it looks: they forgot it within days. ${rest}`,
    spoken: `${of} did not remember it, so a sign-up is weaker than it looks. ${rest}`,
  };
}

const REFUSED =
  /\bturned (?:us|me|it|this|the [a-z]+|\w+) down\b|\bturned down (?:us|me|it|our|my|the)\b|\b(?:said|says|told (?:me|us)) no\b|\b(?:rejected|refused|declined)\b|\bpassed on (?:it|us|the)\b|\b(?:is|are|was|were) not interested\b/;
const REASON =
  /(?:^|[.;, ])(?:because|since)(?: of)? (.{8,160})$|\b(?:she|he|they|it|the [a-z ]{2,30}?|their [a-z]+) (?:says?|said|told (?:me|us)|explained)(?: that)? (?!no\b|yes\b)(.{8,160})$/i;

/** A no, with the reason when they gave one. */
function refusalNews(told: readonly string[]): Pick<News, 'means' | 'spoken'> | null {
  const at = told.findIndex(
    (x) => REFUSED.test(plain(x)) && !/\bi (?:said|told (?:him|her|them)) no\b/.test(plain(x)),
  );
  if (at < 0) return null;
  const reason = told
    .slice(at, at + 2)
    .map((x) => {
      const m = REASON.exec(bare(x));
      return m === null ? null : bare(m[1] ?? m[2] ?? '');
    })
    .find((x) => x !== null && x !== '');
  if (reason === undefined || reason === null)
    return {
      means:
        'A no without its reason teaches little, so ask for it while it is fresh: the price, the timing, the trust, or that it is not needed. Two noes for the same reason change the plan; one does not.',
      spoken: 'Ask for the reason while it is fresh: price, timing, trust, or not needed.',
    };
  const why = lowerFirst(toYou(reason));
  return {
    means: `The no comes with its reason: ${why}. That shows what you are compared with: find what it does badly and who feels that, before you offer it again.`,
    spoken: `The no has a reason: ${why}. Find what that does badly, and who feels it.`,
  };
}

const ASKED_FOR =
  /^(?:(?:but|and|so|then|also|today|yesterday|afterwards?|this morning)[, ]+)*((?:(?:the|a|an|one|my|our|another|two|three) )?[a-z][a-z' -]{2,50}?) (?:(?:just|also|even|then|later) )*(?:asked|wanted to know)(?: (?:me|us))?(?: [a-z]+)?? (?:if|whether) (?:she|he|they|it) (?:could|can|may|might) (.{4,120})$/i;

/** Somebody who asked for it without being sold to. */
function pullNews(told: readonly string[]): Pick<News, 'means' | 'spoken'> | null {
  for (const sentence of told) {
    const m = ASKED_FOR.exec(bare(sentence));
    const who = (m?.[1] ?? '').trim();
    if (m === null || /^(?:i|we|you|it|that|this|people)$/i.test(who)) continue;
    const want = toYou(m[2] ?? '');
    const head = `${upperFirst(toYou(who))} asked to ${want}`;
    return {
      means: `${head}, and nobody was selling it: that is the door to use first. Offer exactly that, as small as it was asked, with a price and a start day, because interest counts when it costs something.`,
      spoken: `${head}, and nobody was selling it. Offer exactly that, with a price and a start day.`,
    };
  }
  return null;
}

/** A buying rule: what it costs to say yes above an amount. */
function limitNews(message: string): Pick<News, 'means' | 'spoken'> | null {
  const t = saidNumbers(message);
  const m =
    /\b(?:anything|everything|purchases?|orders?|spending|amounts?|contracts?|deals?|invoices?|whatever is) (above|over|more than|under|below|up to|less than) \$(\d+(?:\.\d+)?)([^.;]*)/.exec(
      t,
    );
  if (m === null) return null;
  const line = `$${m[2] ?? ''}`;
  const waits =
    /\b(?:takes?|needs?|requires?|means?) (.{3,60}?)(?: to (?:approve|clear|sign|pass|get).*)?$/.exec(
      (m[3] ?? '').trim(),
    )?.[1];
  const over = /^(?:above|over|more than)$/.test(m[1] ?? '');
  const above =
    over && waits !== undefined
      ? `above it you wait ${waits.replace(/^(?:about |around )/, '')}`
      : 'above it there is more to get through';
  const wait = /\b(?:month|week|day|year)s?\b/.test(above) ? above : 'above it there is more to get through';
  return {
    means: `So ${line} is a price line, not only paperwork: under it one person may be able to say yes, and ${wait}. Make the first offer cost less than ${line}, and ask who can say yes to that.`,
    spoken: `So ${line} is a price line: make the first offer cost less, and ask who can say yes to that.`,
  };
}

const CHANGES =
  /^(?:(?:ok(?:ay)?|so|and|please|quick update|update|correction|change (?:it|that|this))[,:.! ]+)*(?:change (?:it|that|this)[,:.]? ?)?(?:the |my |our )?([a-z][a-z ]{1,30}?) (?:is|are|will be) (?:now )?(\$?\d[\d.]*(?: ?(?:dollars|percent|hours|minutes|weeks|days))?)(?: now)?,? (?:and )?(?:not|instead of|no longer) (\$?\d[\d.]*)/i;

/** "The fee is 450 now, not 300": kept as they say it. */
function changeNews(told: readonly string[]): Pick<News, 'means' | 'spoken'> | null {
  for (const sentence of told) {
    const m = CHANGES.exec(saidNumbers(sentence)) ?? CHANGES.exec(bare(sentence));
    if (m === null) continue;
    const is = bare(m[2] ?? '');
    const what = `Noted: your ${(m[1] ?? '').replace(/^(?:the|my|our) /, '')} is ${is} now, not ${bare(m[3] ?? '')}.`;
    return { means: `${what} Every sum from here on uses ${is}.`, spoken: what };
  }
  return null;
}

/** The news of a message; null when it asks, or tells nothing of the kind. */
export function newsOf(input: NewsInput): News | null {
  const { message } = input;
  // What they ask beside it is asked; what they tell is told.
  const told = ownSentences(message).filter((s) => !s.trim().endsWith('?') && !asksFor(s));
  if (told.length === 0) return null;
  const text = told.join(' ');
  const news = (
    kind: NewsKind,
    found: Pick<News, 'means' | 'spoken'> | null,
    ratio: Ratio | null = null,
  ): News | null => (found === null ? null : { kind, ratio, ...found });
  const change = news('change', changeNews(told));
  if (change !== null) return change;
  const flat = plain(text);
  // What others asked or said they would do is no plan of theirs.
  const planned = /\b(?:if|should|might|would like to|going to|will|plan to)\b/.test(
    flat.replace(/\bwould pay\b/g, '').replace(/\b(?:asked|wondered)\b[^.]*?\b(?:if|whether)\b/g, 'asked'),
  );
  if (!planned) {
    const first =
      news('split', splitNews(text)) ??
      news('concentration', concentrationNews(text)) ??
      news('barrier', barrierNews(text));
    if (first !== null) return first;
  }
  // What was counted is exact, whatever else the message plans.
  const tallies = talliesIn(text);
  const money = tallyOf(tallies, ['paid', 'signed'], true);
  if (money !== null && (!planned || money.whole !== null)) {
    if (money.whole !== null && (money.whole >= LEAST_WHOLE || money.count === 0)) {
      const ratio = { part: money.count, whole: money.whole };
      const read = readResult(ratio, input.before, 'people', didIn(money, text));
      return { kind: 'sold', means: read.text, spoken: read.spoken, ratio };
    }
    const paid = news(
      'paid',
      paidNews(money),
      money.whole === null ? null : { part: money.count, whole: money.whole },
    );
    if (paid !== null) return paid;
  }
  const things = tallies.find((t) => t.things !== null && t.act === 'paid' && t.count > 0);
  if (things !== undefined && !planned) {
    const sold = news('paid', thingsNews(things));
    if (sold !== null) return sold;
  }
  const yes = tallyOf(tallies, ['yes']);
  if (yes !== null && !planned) {
    if (yes.whole !== null && yes.whole >= LEAST_WHOLE && passLine(input.before) !== null) {
      const ratio = { part: yes.count, whole: yes.whole };
      const read = readResult(ratio, input.before, 'people', 'said yes');
      const promise = 'A yes counts once it is paid or signed.';
      return { kind: 'yes', means: `${read.text} ${promise}`, spoken: `${read.spoken} ${promise}`, ratio };
    }
    const said = news('yes', yesNews(yes), yes.whole === null ? null : { part: yes.count, whole: yes.whole });
    if (said !== null) return said;
  }
  if (planned) return null;
  const happened = told.filter((s) => statesItHappened(s));
  for (const sentence of [...happened, text]) {
    const part = partsIn(sentence.replace(/\$ ?\d[\d.,]*/g, '$'))[0];
    const ratio = part ?? ratiosIn(saidNumbers(sentence).replace(/\$\d[\d.]*/g, '$'))[0];
    if (ratio === undefined) continue;
    const found = saidFinding(sentence, { part: ratio.part, whole: ratio.whole });
    if (found !== null) return { kind: 'said', ratio: { part: ratio.part, whole: ratio.whole }, ...found };
  }
  // "I did eight interviews. Six of them said…": the whole is in the sentence before.
  const pattern = saidAcross(told);
  if (pattern !== null) return pattern;
  const rest =
    news('cold', coldNews(text)) ??
    (LEFT.test(flat)
      ? news('left', {
          means:
            'One leaving tells you more than ten staying, if you ask while it is fresh: what they used it for, what changed, and what they use now. Until you know, do not add new ones on top.',
          spoken: 'Ask while it is fresh: what they used it for, what changed, and what they use now.',
        })
      : null) ??
    news('refusal', refusalNews(told)) ??
    news('limit', limitNews(text)) ??
    news('pull', pullNews(told)) ??
    (OFFER.test(flat)
      ? news('offer', {
          means:
            'An offer shows interest, not a result yet. It counts when they give something: a date, a table, an email to their people, or money. So answer with one small test and its day, and write down who does what.',
          spoken:
            'It counts when they give something: a date, a table, or an email to their people. Answer with one small test.',
        })
      : null);
  if (rest !== null) return rest;
  const joined = tallyOf(tallies, ['joined']);
  const interest = INTEREST.exec(saidNumbers(text));
  if (joined === null && interest === null) return null;
  const n = joined === null ? (interest?.[1] ?? interest?.[2] ?? '') : String(joined.count);
  const share =
    joined?.whole == null ? '' : ` of ${String(joined.whole)} (${percent(joined.count, joined.whole)})`;
  return {
    kind: 'interest',
    ratio: joined?.whole == null ? null : { part: joined.count, whole: joined.whole },
    means: `${n}${share} raised a hand, and none of that is money yet. The test is to ask some of them to pay now, at a real price, and count the yeses.`,
    spoken: `${n}${share} raised a hand, and that is not money yet. Ask some of them to pay now and count the yeses.`,
  };
}

/** A share of fewer is no share: the payments themselves are the news. */
const LEAST_WHOLE = 8;

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

// What they found, in their words ------------------------------------------------------------------------------------

/** A clause of their own doing ("I asked the nine teachers"): what was done, never what it showed. */
const OWN_DOING =
  /^(?:(?:so|and|ok(?:ay)?|well|also|yes|yeah|yep|update|done|finished|finally|today|yesterday|this (?:week|morning)|last (?:week|night)|on \w+day)[,.: ]+)*(?:done|finished|(?:i|we|my co-?founder|my team) (?:(?:have|had|just|already|finally|also|then|did) )*(?:did|done|asked|talked|spoke|met|interviewed|emailed|messaged|called|phoned|visited|contacted|sent|wrote|made|put|ran|held|finished|completed|offered|showed|posted|started|got|went|tried|tested)\b)/i;
const FINDING_CHARS = 240;

/**
 * What the message says came of the work, in their own words said back ("seven love it, but six of those have no space"):
 * its statements that are no doing of their own. '' when it tells none.
 */
export function findingIn(message: string, not = ''): string {
  const pieces: string[] = [];
  for (const sentence of ownSentences(message)) {
    if (sentence.trim().endsWith('?') || asksFor(sentence) || (not !== '' && not.includes(sentence)))
      continue;
    if (!OWN_DOING.test(plain(sentence))) {
      pieces.push(bare(sentence));
      continue;
    }
    // "I talked to all ten and four asked when they could start": what follows the doing.
    const cut =
      /^.*?(?:,|;)?\s+(?:and|but|though|while)\s+(?=(?:(?:only|all|the|most|some|none|nobody|not) )*(?:\d+|[a-z]+ (?:of|people|said|asked|want|love|like|were|was|had|have|would|paid|bought|told)|they|he|she|everyone|nobody|none)\b)(.+)$/i.exec(
        bare(sentence),
      );
    const rest = cut?.[1]?.trim() ?? '';
    const opens = plain(rest).split(/\s+/)[0] ?? '';
    if (
      rest !== '' &&
      !/^(?:i|we|then|wrote|made|sent)$/.test(opens) &&
      (numberOf(opens) !== null || rest.split(/\s+/).length >= 4)
    )
      pieces.push(rest);
  }
  let out = '';
  for (const p of pieces) {
    const next = out === '' ? p : `${out}. ${upperFirst(p)}`;
    if (next.length > FINDING_CHARS) break;
    out = next;
  }
  const told = toYou(out.replace(/^(?:and|but|so|then|also|well|honestly|ok(?:ay)?)[, ]+/i, ''));
  return told.split(/\s+/).length < 3 ? '' : told;
}

/** Something that happened to the work, told without asking: what others did, or what befell them. */
const HAPPENED =
  /\b(?:left|quit|launched|released|announced|said|says|told|asked|turned|rejected|refused|offered|approved|cancel(?:l)?ed|broke|failed|closed|opened|lost|won|replied|answered|promised|agreed|signed|raised|dropped|stopped|came|gave|sent|bought|paid|sold|arrived|crashed|complained|liked|loved|hated|copied|beat|doubled|shut)\b/;
const BEFELL =
  /\b(?:i|we) (?:have |just |also |finally )*(?:lost|won|found out|discovered|learned|heard|saw|noticed|got (?:rejected|accepted|into|a (?:no|yes|reply|call|grant|prize))|were (?:rejected|accepted|told)|was (?:rejected|accepted|told))\b/;
const BY_THEM =
  /^(?:(?:and|but|so|then|also|ok(?:ay)?|well|today|yesterday|this (?:morning|week)|last (?:night|week))[, ]+)*(?:i|we)\b/;

/** News of no kind the rules read: a statement that something happened, for the model to say what it means. */
export function tellsNews(message: string): boolean {
  const told = ownSentences(message);
  return (
    told.length > 0 &&
    !told.some((s) => s.trim().endsWith('?')) &&
    !asksFor(message) &&
    told.some((s) => {
      const t = plain(s);
      return statesItHappened(s) && (BEFELL.test(t) || (!BY_THEM.test(t) && HAPPENED.test(t)));
    })
  );
}
