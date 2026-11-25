import { methodUnit } from '../validators/method.js';
import { rulesForAPerson } from '../validators/reply-contract.js';
import { stemsOf } from '../validators/stems.js';
import { conflictDrop, type ConflictDrop } from './conflicts.js';
import { claimNumbers, daysIn, figuresIn, pricesIn, sameNumber } from './figures.js';
import { toThem } from './labels.js';
import { mergeReadings } from './merge.js';
import type { RawUnderstanding, UnderstandReadings } from './schema.js';
import { checkSums, type CheckedSums, type SumDrop } from './sums.js';
import {
  type RecordLine,
  type Understanding,
  type UnderstoodChoice,
  type UnderstoodReferral,
  type UnderstoodResult,
} from './types.js';

/** One exchange of the conversation as the call was shown it. */
export interface UnderstandExchange {
  readonly founder: string;
  readonly reply: string;
}

/** A play of the catalogue, with what its numbers and names may be said from. */
export interface UnderstandPlay {
  readonly id: string;
  readonly stage: string;
  /** When a founder asks this, and what its step is, in a few words. */
  readonly ask: string;
  readonly title: string;
  /** What the play itself says (its answer, steps and done-when): a claim may repeat its numbers. */
  readonly text: string;
}

/** Everything a reading may rest on: what the call was shown. */
export interface UnderstandContext {
  readonly today: string;
  readonly message: string;
  /** Oldest first. */
  readonly history: readonly UnderstandExchange[];
  readonly record: readonly RecordLine[];
  /** The venture's line, its open step, the founder's name: shown beside the record. */
  readonly shown: string;
  readonly plays: readonly UnderstandPlay[];
  /** Plays whose step may be given now. */
  readonly stepCandidates: ReadonlySet<string>;
}

/** What the checks left out, as codes and counts (logs and the bench; never words). */
export interface UnderstandReport {
  readonly sumDrops: readonly SumDrop[];
  readonly inputs: CheckedSums['inputs'];
  /** Fields whose text was left out (`points`, `first_action`, …), with why. */
  readonly textDrops: readonly string[];
}

export interface ReadUnderstanding {
  readonly understanding: Understanding | null;
  readonly report: UnderstandReport;
}

type TextDrop =
  | 'empty'
  | 'long'
  | 'markup'
  | 'number'
  | 'date'
  | 'name'
  | 'ruling'
  | 'method'
  /** Said of the founder or the mentor, not to the founder. */
  | 'voice'
  /** Nothing they could count or see. */
  | 'vague'
  /** A price of an amount nobody charges. */
  | 'price'
  /** Nobody does it. */
  | 'subject'
  /** Nothing of theirs in it. */
  | 'generic'
  /** It tells another message's news. */
  | 'elsewhere';

const MAX_ASK_WORDS = 34;
const MAX_CLAIM_WORDS = 40;
const MAX_POINTS = 4;
const MAX_OPTIONS = 8;
const MAX_RECORD = 4;

const words = (text: string): number => text.split(/\s+/u).filter((w) => w !== '').length;

/** A model says the data back as it was shown it, escaped: "the buyer&#39;s". */
const unescaped = (text: string): string =>
  text
    .replace(/&(?:#0?39|apos);/giu, "'")
    .replace(/&quot;/giu, '"')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&');

/** One plain line: no markup, no control characters, no address; else why nothing of it may be used. */
function plainLine(
  text: string | null | undefined,
  maxWords: number,
): { readonly line: string } | { readonly drop: TextDrop } {
  const line = unescaped(text ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[*_`#]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^["'“”‘’]+(.*)["'“”‘’]+$/u, '$1')
    .trim();
  if (line === '' || /^(?:null|none|n\/a|-|nothing)\.?$/iu.test(line)) return { drop: 'empty' };
  if (/[<>{}[\]|\\]|https?:|www\.|\S@\S/iu.test(line)) return { drop: 'markup' };
  return words(line) > maxWords ? { drop: 'long' } : { line };
}

/** Capitalised words anyone may say: they name nobody's facts. */
const COMMON_NAMES = new Set(
  "i i’m i'm i’ll i'll i’d i'd i’ve i've ai ip llc loi nda mvp eir pdf qr us usa ur faq irb fda hipaa sms roi gps id ok tv go-to-market q&a ain foundry thomas english vc vcs b2b b2c saas mvps ceo cto csv kpi kpis okrs llcs url app ads".split(
    ' ',
  ),
);
const NAME = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*(?:['’&-][\p{L}\p{N}]+)*/gu;
/** Someone the sentence opens with, who does something ("Maria said …"). */
const OPENS_WITH_NAME =
  /^(\p{Lu}\p{Ll}+) (?:said|says|told|asked|asks|paid|pays|wants|wanted|thinks|promised|offered|owns|decides|agreed|will|would)\b/u;

/** Ruling on what a person decides: a law, a status, terms, what a round or a share is worth. */
const RULES_ALWAYS: readonly RegExp[] = [
  /\b(?:it|that|this)(?:['’]s| is) (?:not |perfectly |completely )?(?:legal|illegal|lawful|unlawful|allowed|permitted|compliant|exempt)\b/iu,
  /\byou (?:do not|don['’]t|will not|won['’]t) need (?:a|an|any)? ?(?:permit|licen[cs]e|patent|approval|visa|lawyer|irb|fda)\b/iu,
  /\b(?:fair|good|great|bad|low|high|reasonable|cheap|generous|standard)\b[^.]{0,24}\b(?:valuation|equity|stake|shares|term sheet|vesting)\b/iu,
  /\b(?:valuation|equity|stake|shares|term sheet|split|vesting)\b[^.]{0,30}\b(?:is|are|looks?|seems?|sounds?)\b[^.]{0,16}\b(?:fair|good|bad|low|high|reasonable|cheap|generous|standard|fine)\b/iu,
  /\b(?:visa|f-1|j-1|opt|cpt)\b[^.]{0,40}\b(?:lets|allows|permits|covers|forbids|is fine|is ok)\b/iu,
];
const RULES_WITH_REFERRAL: readonly RegExp[] = [
  /\b(?:fair|good|great|bad|low|high|reasonable|cheap|generous|standard)\b[^.]{0,20}\b(?:price|offer|deal|terms?|amount)\b/iu,
  /\b(?:price|offer|deal|terms?)\b[^.]{0,24}\b(?:is|are|looks?|seems?|sounds?)\b[^.]{0,16}\b(?:fair|good|bad|low|high|reasonable|fine|ok)\b/iu,
  /\b(?:take|accept|sign|reject|refuse|turn down|agree to)\b[^.]{0,24}\b(?:offer|deal|money|check|cheque|investment|contract|agreement|letter|form|it)\b/iu,
  /\byou (?:can|may|could|are allowed to|are free to|cannot|can['’]t|must not)\b[^.]{0,50}\b(?:paid|salary|work|own|hire|sell|claim|say|use|publish)\b/iu,
];
/** Said of what to wait for or to ask, never ruled. */
const HOLDS_OFF =
  /\b(?:before|until|unless|not yet|nothing|whether|ask|who decides|decides?|a person|lawyer|office|official|advis[eo]r)\b/iu;

/** Said of them, or of who answers: a reply speaks to the founder. */
const OF_THEM = /\bthe (?:mentor|founder|opening|user|coach|assistant)\b/iu;

/** Giving it away until enough people have it, where asking to pay would show more. */
const FREE = /\b(?:(?:for )?free|for nothing|no charge|without (?:charging|paying)|at no cost)\b/iu;
const FREE_UNTIL =
  /\b(?:for )?free (?:for now|at first|to (?:start|begin) with|(?:un)?til+ |(?:for )?(?:the |your )?first \d)/iu;
const CHARGES = /\b(?:charg\w+|pays?|paid|paying|price\w*|sell\w*|fee|deposit)\b/iu;

/** Said to them where that only takes the words for it; else as it is, and left out. */
function spokenTo(text: string, message: string): string {
  if (/\bthe founder\b/iu.test(message) || /\b(?:they|them|their|he|him|his|she|her)\b/iu.test(text))
    return text;
  const said = toThem(text);
  return /\b(?:and|but|or) (?:has|is|does|was|[a-z]{3,}s) /iu.test(said) ? text : said;
}

function rulesOnIt(text: string, referral: UnderstoodReferral | null): boolean {
  if (rulesForAPerson(text)) return true;
  if (RULES_ALWAYS.some((re) => re.test(text)) && !HOLDS_OFF.test(text)) return true;
  return (
    referral !== null &&
    referral !== 'wellbeing' &&
    RULES_WITH_REFERRAL.some((re) => re.test(text)) &&
    !HOLDS_OFF.test(text)
  );
}

/** A number of people or days a test may name: small, or round. */
const testSize = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 100 && (n <= 12 || n % 5 === 0);
/** Something to do ("Ask 10 of them …"), or what would have to happen ("8 of 12 pay"): never what did. */
const TO_DO =
  /^(?:ask|call|ring|phone|talk|speak|meet|message|email|text|write|send|offer|sell|show|give|get|find|book|invite|visit|run|try|test|charge|collect|count|put|take|bring|post|list|watch|pick|set|make|build|hold|stand|keep|let|have)\b/iu;
const WOULD =
  /^(?:if |when |whether |once )?(?:at least |more than |fewer than |less than |most of |about )?(?:\d{1,3}|[a-z]+) (?:of|out of|in) (?:the (?:next )?|every )?(?:\d{1,3}|[a-z]+)\b/iu;
const DID =
  /\b(?:paid|said|came|bought|asked|sold|told|were|was|had|did|signed|used|kept|stayed|left|opened|booked|agreed|returned)\b/iu;
/** An amount somebody is to pay, marked or not ("pay the 600"). */
const TO_PAY =
  /\b(?:pay|pays|paying|charge|charges|prepay|deposit|buy\w* [^.]{0,20}for|sell\w* [^.]{0,20}(?:for|at)|price of|fee of) (?:a |an |the |you |them )?\$?(\d[\d,]*(?:\.\d+)?)(?![\d.]|,\d| ?%| percent| (?:days?|weeks?|months?|of|people|strangers|customers))/giu;

/** A test without the clauses that make a price of an amount nobody charges; '' when nothing of it is left. */
function withRealPrices(text: string, prices: readonly number[]): string {
  const bad = (clause: string): boolean => {
    const amounts = [
      ...figuresIn(clause).flatMap((f) => (f.mark === '$' ? [f.value] : [])),
      ...[...clause.matchAll(TO_PAY)].map((m) => Number((m[1] ?? '').replace(/,/gu, ''))),
    ];
    return amounts.some((n) => !prices.some((p) => sameNumber(p, n)));
  };
  if (!bad(text)) return text;
  const parts = text.split(/(,? (?:and|or|then|but) )/u);
  const clauses = parts.flatMap((part, i) => (i % 2 === 0 ? [{ part, joins: parts[i - 1] ?? '' }] : []));
  // "Use it for a week and pay the 600": what is left of the sentence stands.
  const kept = clauses.filter((c) => !bad(c.part));
  if (kept.length === 0 || kept[0] !== clauses[0]) return '';
  const said = kept
    .map((c, i) => `${i === 0 ? '' : c.joins}${c.part}`)
    .join('')
    .replace(/[\s,;]+$/u, '');
  return words(said) < 5 ? '' : /[.!?]$/u.test(said) ? said : `${said}.`;
}

/** What somebody else would have to do, as it is told of them ("agrees", "answers"): with nobody named it is nobody's. */
const OTHERS_DO =
  /^(?:answers?|agrees?|accepts?|repl(?:y|ies)|confirms?|signs?|buys?|pays?|comes?|returns?|refuses?|declines?|says?|wants?|renews?|orders?|books?|keeps?|stays?|uses?|likes?|joins?|leaves?)\b/iu;
/** "Ask five and two pay" is "you ask five and two pay"; a clause with nobody in it is null. */
function withSubject(text: string): string | null {
  const said = text.replace(/^(?:if|when|once|unless) /iu, '');
  if (OTHERS_DO.test(said)) return null;
  return TO_DO.test(said) ? `You ${said.charAt(0).toLowerCase()}${said.slice(1)}` : text;
}
const setsSizes = (text: string): boolean => TO_DO.test(text) || (WOULD.test(text) && !DID.test(text));

/** What a claim may repeat: the numbers, days and names of everything the call was shown, and of what code worked out. */
class Known {
  readonly #numbers: readonly number[];
  readonly #days: ReadonlySet<string>;
  readonly #words: ReadonlySet<string>;

  constructor(texts: readonly string[], days: readonly string[], computed: readonly number[]) {
    const all = texts.join('\n');
    this.#numbers = [...claimNumbers(all), ...figuresIn(all).map((f) => f.value), ...computed];
    this.#days = new Set([...days, ...daysIn(all)]);
    this.#words = new Set(all.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  }

  /** Why a text says more than what is known; null: it does not. `tests`: it sets sizes of something to do. */
  beyond(text: string, tests = false): 'number' | 'date' | 'name' | null {
    const marked = tests ? figuresIn(text).filter((f) => f.mark !== null) : [];
    const size = (n: number): boolean => tests && testSize(n) && !marked.some((f) => sameNumber(f.value, n));
    // "One thing to do" counts nothing.
    if (claimNumbers(text).some((n) => n !== 1 && !size(n) && !this.#numbers.some((k) => sameNumber(k, n))))
      return 'number';
    if (daysIn(text).some((d) => !this.#days.has(d))) return 'date';
    const opens = OPENS_WITH_NAME.exec(text)?.[1];
    if (
      opens !== undefined &&
      !this.#names(opens) &&
      !/^(?:You|They|People|Nobody|Everyone|Someone|Students?|Customers?|Buyers?|It|He|She|We|Who|What|This|That)$/u.test(
        opens,
      )
    )
      return 'name';
    for (const m of text.matchAll(NAME)) {
      const before = text.slice(0, m.index).trimEnd();
      if (before === '' || /[.!?:;]$/u.test(before) || /["'“‘(]$/u.test(before)) continue;
      if (!this.#names(m[0])) return 'name';
    }
    return null;
  }

  #names(word: string): boolean {
    const low = word.toLowerCase().replace(/’/g, "'");
    const bare = low.replace(/'s$/u, '');
    if (COMMON_NAMES.has(low) || COMMON_NAMES.has(bare)) return true;
    // "Saturday" of "Saturdays".
    return (bare.match(/[\p{L}\p{N}]+/gu) ?? []).every(
      (part) =>
        this.#words.has(part) || this.#words.has(`${part}s`) || this.#words.has(part.replace(/s$/u, '')),
    );
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A model's reading as code lets it stand, with what was left out. */
export function readUnderstanding(raw: RawUnderstanding, context: UnderstandContext): ReadUnderstanding {
  const textDrops: string[] = [];
  const lineByKey = new Map(context.record.map((r) => [r.key.toUpperCase(), r]));
  const lineOf = (key: string): RecordLine | null =>
    lineByKey.get((/R\d+/iu.exec(key)?.[0] ?? '').toUpperCase()) ?? null;
  const play = (id: string | null): UnderstandPlay | null => {
    const said = (id ?? '').trim().toLowerCase();
    return context.plays.find((p) => p.id === said) ?? null;
  };
  const chosen = play(raw.play);
  const stepPlay = play(raw.step_play);
  const playId = chosen?.id ?? null;
  const stepPlayId =
    stepPlay !== null && (context.stepCandidates.has(stepPlay.id) || stepPlay.id === playId)
      ? stepPlay.id
      : null;

  const conversation = context.history.map((h) => `${h.founder}\n${h.reply}`).join('\n');
  const known = (computed: readonly number[]): Known =>
    new Known(
      [
        context.message,
        conversation,
        ...context.record.map((r) => r.text),
        context.shown,
        chosen === null ? '' : `${chosen.title}. ${chosen.text}`,
        stepPlay === null ? '' : `${stepPlay.title}. ${stepPlay.text}`,
        WEEKDAYS[new Date(`${context.today}T00:00:00Z`).getUTCDay()] ?? '',
      ],
      [context.today, ...context.record.flatMap((r) => (r.on === null ? [] : [r.on]))].map((d) =>
        d.slice(5, 10),
      ),
      computed,
    );
  const before = known([]);

  /** A claim as it may be used; null (and a code) when it may not. */
  const claim = (
    field: string,
    text: string | null,
    allowed: Known,
    lint: 'claim' | 'plain' = 'claim',
    maxWords = MAX_CLAIM_WORDS,
  ): string | null => {
    const drop = (why: TextDrop): null => {
      if (why !== 'empty') textDrops.push(`${field}:${why}`);
      return null;
    };
    const read = plainLine(text, maxWords);
    if ('drop' in read) return drop(read.drop);
    const tests =
      (field === 'result.settles' || field === 'choice.flips_if' || field === 'first_action') &&
      setsSizes(read.line);
    const line = OF_THEM.test(read.line) ? spokenTo(read.line, context.message) : read.line;
    const beyond = allowed.beyond(line, tests);
    if (beyond !== null) return drop(beyond);
    if (field !== 'second_ask' && OF_THEM.test(line)) return drop('voice');
    if (lint === 'plain') return line;
    if (FREE_UNTIL.test(line)) return drop('method');
    if (rulesOnIt(line, raw.referral)) return drop('ruling');
    const method = methodUnit(line, { founderText: context.message }).text.trim();
    return method === '' ? drop('method') : method;
  };

  const ask = plainLine(raw.ask, MAX_ASK_WORDS);
  const askText = 'drop' in ask ? null : ask.line;
  const checked = checkSums(
    raw,
    { message: context.message, history: conversation, record: context.record },
    {
      labelOk: (label) => claim('label', toThem(label.replace(/[.:]+$/u, '')), before, 'plain', 16),
      askText: `${context.message} ${askText ?? ''}`,
    },
  );
  const report = (): UnderstandReport => ({ sumDrops: checked.drops, inputs: checked.inputs, textDrops });
  // Nothing asked that can be said: the reading says nothing.
  if (askText === null) return { understanding: null, report: report() };

  const after = known(checked.sums.map((s) => s.value));
  const contradictsLine = raw.contradicts === null ? null : lineOf(raw.contradicts.record);
  const contradictsWhy =
    contradictsLine === null || raw.contradicts === null
      ? null
      : claim('contradicts', raw.contradicts.why, after, 'plain');
  const against: ConflictDrop | null =
    contradictsLine === null || raw.contradicts === null || contradictsWhy === null
      ? null
      : conflictDrop({
          claim: raw.contradicts.claim,
          why: contradictsWhy,
          line: contradictsLine,
          message: context.message,
          kind: raw.kind,
          also: raw.also,
        });
  if (against !== null) textDrops.push(`contradicts:${against}`);
  const contradicts =
    contradictsLine === null || contradictsWhy === null || against !== null
      ? null
      : { line: contradictsLine, why: contradictsWhy };
  const record = [
    ...(contradicts === null ? [] : [contradicts.line]),
    ...raw.record.flatMap((k) => lineOf(k) ?? []),
  ].filter((line, i, all) => all.indexOf(line) === i);

  const asked = checked.sums.some((s) => s.asked);
  const missing = asked
    ? null
    : (claim('missing', raw.missing, after, 'plain', 18) ??
      (checked.invented === null ? null : claim('missing', checked.invented, after, 'plain', 8)));

  const points = raw.points
    .slice(0, MAX_POINTS + 2)
    .flatMap((p) => claim('points', p, after) ?? [])
    .filter((p, i, all) => all.indexOf(p) === i)
    .slice(0, MAX_POINTS);

  const theirs = stemsOf(
    [context.message, conversation, context.shown, ...context.record.map((r) => r.text)].join('\n'),
  );
  // What happened is in what they say now or just said; a push back is answered with what stands.
  const latest = [context.message, ...context.history.slice(-2).map((h) => h.founder)].join('\n');
  const news = stemsOf(latest);
  const pushed = raw.kind === 'pushback' || raw.also.includes('pushback');
  const prices = [
    context.message,
    ...context.history.map((h) => h.founder),
    ...context.record.map((r) => r.text),
  ].flatMap(pricesIn);
  const counts = (field: string, text: string | null): string | null => {
    const told = claim(field, text, after);
    if (told === null) return null;
    const priced = withRealPrices(told, prices);
    if (priced === '') {
      textDrops.push(`${field}:price`);
      return null;
    }
    const line = field === 'choice.flips_if' ? withSubject(priced) : priced;
    if (line === null) {
      textDrops.push(`${field}:subject`);
      return null;
    }
    if (observable(line)) return line;
    textDrops.push(`${field}:vague`);
    return null;
  };
  const shows = (text: string): string | null => {
    const line = claim('result.shows', text, after);
    if (line === null) return null;
    const shared = [...stemsOf(line)].filter((w) => theirs.has(w)).length;
    if (shared === 0 || (shared === 1 && claimNumbers(line).length === 0)) {
      textDrops.push('result.shows:generic');
      return null;
    }
    const told = claimNumbers(latest);
    if (
      pushed ||
      [...stemsOf(line)].some((w) => news.has(w)) ||
      claimNumbers(line).some((n) => told.some((t) => sameNumber(t, n)))
    )
      return line;
    textDrops.push('result.shows:elsewhere');
    return null;
  };

  return {
    understanding: {
      ask: askText,
      secondAsk: claim('second_ask', raw.second_ask, after, 'plain', MAX_ASK_WORDS),
      kind: raw.kind,
      also: [...new Set(raw.also)].filter((k) => k !== raw.kind).slice(0, 2),
      record: record.slice(0, MAX_RECORD),
      contradicts,
      sums: checked.sums,
      missing,
      choice: choiceOf(raw.choice, {
        claim: (field, text, lint) => claim(field, text, after, lint),
        counts,
        theirs,
        referral: raw.referral,
      }),
      result: resultOf(raw.result, { claim: (field, text) => claim(field, text, after), counts, shows }),
      referral: raw.referral,
      playId,
      stepPlayId,
      sure: raw.sure === 'high' && playId !== null,
      points,
      firstAction: withRealPrices(claim('first_action', raw.first_action, after) ?? '', prices) || null,
      avoid: claim('avoid', raw.avoid, after, 'plain'),
    },
    report: report(),
  };
}

type Claim = (field: string, text: string | null, lint?: 'claim' | 'plain') => string | null;

/** Something done that one can see or count, by someone. */
const ACT =
  /\b(?:pay\w*|paid|buy\w*|bought|book\w*|sign\w*|order\w*|re-?order\w*|return\w*|com(?:e|es|ing) back|came back|us(?:e|es|ed|ing)\b.{0,24}\b(?:again|week|day|month)|repl(?:y|ies|ied)|answer\w*|send\w*|sent|show(?:s|ed)? up|turn(?:s|ed)? up|refer\w*|renew\w*|cancel\w*|call(?:s|ed)?|write\w*|wrote|ask(?:s|ed|ing)?|sell\w*|sold|deposit\w*|prepa\w*|count\w*|open(?:s|ed)?|switch\w*|bring\w*|brought|sign(?:s|ed)? up|introduc\w*|name[sd]?|tell\w*|told|say\w*|said|quit\w*|leav\w*|left|meet\w*|met|stay(?:s|ed)?|finish\w*|wins?|won|clos(?:e|es|ed)|agree\w*|accept\w*|refus\w*|commit\w*)\b/iu;
const SOMEONE =
  /\b(?:customers?|buyers?|clients?|strangers?|people|person|someone|somebody|anyone|nobody|no one|families|parents?|students?|managers?|owners?|members?|visitors?|guests?|shops?|schools?|stores?|users)\b/iu;
/** "Whether they will keep going": the question said again. */
const RESTATES = /^(?:whether|if|that|how|when|until)?\s*(?:they|it|he|she|this|that|you|we|the \w+)\b/iu;

/** What settles or turns it: a number, a person or an act they could see, never the question again. */
export function observable(text: string): boolean {
  if (claimNumbers(text).length > 0) return true;
  if (ACT.test(text)) return true;
  return SOMEONE.test(text) && !RESTATES.test(text);
}

/** An option that only says no to the other one. */
const HOLDS =
  /^(?:no\b|not\b|yes\b|both\b|neither\b|wait|hold|stay|stop|skip|keep|go (?:on|ahead)|carry on|continue|quit|don['’]?t|do not|leave it|stick)/iu;
/** Splitting it, owning it, a status, what it is worth: never picked, whatever the reading says of who decides. */
const PERSONAL_OPTION =
  /\b(?:equity|vesting|cap table|valuation|term sheet|patents?|visas?|salary|ownership|co-?owner\w*)\b|\b(?:shares|stake|percent|%) (?:of|in) (?:the|my|our|your) (?:company|business|startup)\b/iu;
/** "60/40", "50-50": two parts of one whole; "5-10 people" is none. */
const splits = (option: string): boolean =>
  [...option.matchAll(/\b(\d{1,3}) ?[/–-] ?(\d{1,3})\b/gu)].some((m) => Number(m[1]) + Number(m[2]) === 100);
const NEVER_PICKED: ReadonlySet<UnderstoodReferral> = new Set([
  'equity',
  'ip',
  'immigration',
  'valuation',
  'regulatory',
]);
/** To bind themselves: a lawyer reads it first. */
const BINDS =
  /\b(?:sign\w*|agree\w*|accept\w*|shar(?:e|es|ing)|tick\w*|take (?:the|it|his|her|their)|say yes|offer|hand over|licen[cs]e|percent|%|llc|501\w*|c-?corp\w*|non-?profit|incorporat\w*)(?![\p{L}])/iu;

function choiceOf(
  raw: RawUnderstanding['choice'],
  c: {
    readonly claim: Claim;
    readonly counts: (field: string, text: string | null) => string | null;
    /** Stems of their own words and record: an option is one of theirs. */
    readonly theirs: ReadonlySet<string>;
    readonly referral: UnderstoodReferral | null;
  },
): UnderstoodChoice | null {
  if (raw === null) return null;
  const { referral } = c;
  const said = [...raw.options, raw.pick];
  // Whether to sign, take, own or split is a person's to decide: no pick of it.
  if (referral !== null && NEVER_PICKED.has(referral)) return null;
  if (said.some((o) => PERSONAL_OPTION.test(o) || splits(o))) return null;
  if ((referral === 'legal' || referral === 'irb') && said.some((o) => BINDS.test(o))) return null;
  // Asking for money shows more than giving it away.
  if (FREE.test(raw.pick) && raw.options.some((o) => CHARGES.test(o) && !FREE.test(o))) return null;
  const options = raw.options
    .slice(0, MAX_OPTIONS)
    .flatMap((o) => c.claim('choice.option', o, 'plain') ?? []);
  const named = (o: string): boolean => [...stemsOf(o)].some((w) => c.theirs.has(w));
  if (options.length < 2 || !options.some(named) || !options.every((o) => named(o) || HOLDS.test(o)))
    return null;
  const pick = c.claim('choice.pick', raw.pick);
  const because = c.claim('choice.because', raw.because);
  if (pick === null || because === null) return null;
  // The pick is one of them, some of them, or none: never a third thing.
  const stems = stemsOf(pick);
  const one =
    options.some(
      (o) => o.toLowerCase() === pick.toLowerCase() || [...stemsOf(o)].some((w) => stems.has(w)),
    ) || /\b(?:both|neither|none|first|second)\b/iu.test(pick);
  if (!one) return null;
  return { options, pick, because, flipsIf: c.counts('choice.flips_if', raw.flips_if) };
}

function resultOf(
  raw: RawUnderstanding['result'],
  c: {
    readonly claim: Claim;
    readonly counts: (field: string, text: string | null) => string | null;
    readonly shows: (text: string) => string | null;
  },
): UnderstoodResult | null {
  if (raw === null) return null;
  const shows = c.shows(raw.shows);
  if (shows === null) return null;
  return {
    verdict: raw.verdict,
    shows,
    doesNotShow: c.claim('result.does_not_show', raw.does_not_show),
    settles: c.counts('result.settles', raw.settles),
  };
}

/**
 * What a message asks as code lets it stand: every id exists, every number, day and name is of the message, the
 * conversation, the record, the play or a sum worked out here; nothing rules on what a person decides. Null when the
 * reading says nothing that can be used.
 */
export function checkUnderstanding(raw: RawUnderstanding, context: UnderstandContext): Understanding | null {
  return readUnderstanding(raw, context).understanding;
}

/** The parts of a reading that came in time, as one, checked. */
export function readParts(readings: UnderstandReadings, context: UnderstandContext): ReadUnderstanding {
  const raw = mergeReadings(readings, {
    message: context.message,
    keys: new Set(context.record.map((r) => r.key.toUpperCase())),
  });
  return raw === null
    ? {
        understanding: null,
        report: { sumDrops: [], inputs: { named: 0, found: 0, anywhere: 0 }, textDrops: [] },
      }
    : readUnderstanding(raw, context);
}
