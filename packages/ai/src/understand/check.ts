import { methodUnit } from '../validators/method.js';
import { rulesForAPerson } from '../validators/reply-contract.js';
import { claimNumbers, daysIn, figuresIn, sameNumber } from './figures.js';
import type { RawUnderstanding } from './schema.js';
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

type TextDrop = 'empty' | 'long' | 'markup' | 'number' | 'date' | 'name' | 'ruling' | 'method' | 'basis';

const MAX_ASK_WORDS = 34;
const MAX_CLAIM_WORDS = 40;
const MAX_POINTS = 4;
const MAX_RECORD = 4;

const words = (text: string): number => text.split(/\s+/u).filter((w) => w !== '').length;

/** One plain line: no markup, no control characters, no address; else why nothing of it may be used. */
function plainLine(
  text: string | null | undefined,
  maxWords: number,
): { readonly line: string } | { readonly drop: TextDrop } {
  const line = (text ?? '')
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
  "i i’m i'm i’ll i'll i’d i'd i’ve i've ai ip llc loi nda mvp eir pdf qr us usa ur faq irb fda hipaa sms roi gps id ok tv go-to-market q&a ain foundry thomas english".split(
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

  /** Why a text says more than what is known; null: it does not. */
  beyond(text: string): 'number' | 'date' | 'name' | null {
    // "One thing to do" counts nothing.
    if (claimNumbers(text).some((n) => n !== 1 && !this.#numbers.some((k) => sameNumber(k, n))))
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
    return (bare.match(/[\p{L}\p{N}]+/gu) ?? []).every((part) => this.#words.has(part));
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A model's reading as code lets it stand, with what was left out. */
export function readUnderstanding(
  raw: RawUnderstanding,
  context: UnderstandContext,
  options: { readonly strictInputs?: boolean } = {},
): ReadUnderstanding {
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
    const { line } = read;
    const beyond = allowed.beyond(line);
    if (beyond !== null) return drop(beyond);
    if (lint === 'plain') return line;
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
      labelOk: (label) => claim('label', label.replace(/[.:]+$/u, ''), before, 'plain', 16),
      askText: `${context.message} ${askText ?? ''}`,
      strict: options.strictInputs ?? true,
    },
  );
  const report = (): UnderstandReport => ({ sumDrops: checked.drops, inputs: checked.inputs, textDrops });
  // Nothing asked that can be said: the reading says nothing.
  if (askText === null) return { understanding: null, report: report() };

  const after = known(checked.sums.map((s) => s.value));
  const contradictsLine = raw.contradicts === null ? null : lineOf(raw.contradicts.record);
  const contradictsWhy =
    contradictsLine === null ? null : claim('contradicts', raw.contradicts?.why ?? null, after, 'plain');
  const record = [
    ...(contradictsWhy !== null && contradictsLine !== null ? [contradictsLine] : []),
    ...raw.record.flatMap((k) => lineOf(k) ?? []),
  ].filter((line, i, all) => all.indexOf(line) === i);

  const asked = checked.sums.some((s) => s.asked);
  const missing = asked
    ? null
    : (claim('missing', raw.missing, after, 'plain', 18) ??
      (checked.invented === null ? null : claim('missing', checked.invented, after, 'plain', 8)));

  const points = raw.points
    .slice(0, MAX_POINTS + 2)
    .flatMap((p) => {
      const basis = p.basis.trim().toLowerCase();
      const held =
        /^(?:message|history|common)$/u.test(basis) ||
        (/^play\b/u.test(basis) ? chosen !== null || stepPlay !== null : lineOf(basis) !== null);
      if (!held) {
        textDrops.push('points:basis');
        return [];
      }
      return claim('points', p.text, after) ?? [];
    })
    .filter((p, i, all) => all.indexOf(p) === i)
    .slice(0, MAX_POINTS);

  return {
    understanding: {
      ask: askText,
      secondAsk: claim('second_ask', raw.second_ask, after, 'plain', MAX_ASK_WORDS),
      kind: raw.kind,
      also: [...new Set(raw.also)].filter((k) => k !== raw.kind).slice(0, 2),
      record: record.slice(0, MAX_RECORD),
      contradicts:
        contradictsLine === null || contradictsWhy === null
          ? null
          : { line: contradictsLine, why: contradictsWhy },
      sums: checked.sums,
      missing,
      choice: choiceOf(raw.choice, (field, text, lint) => claim(field, text, after, lint), raw.referral),
      result: resultOf(raw.result, (field, text) => claim(field, text, after)),
      referral: raw.referral,
      playId,
      stepPlayId,
      sure: raw.sure === 'high' && playId !== null,
      points,
      firstAction: claim('first_action', raw.first_action, after),
      avoid: claim('avoid', raw.avoid, after, 'plain'),
    },
    report: report(),
  };
}

type Claim = (field: string, text: string | null, lint?: 'claim' | 'plain') => string | null;

const SMALL = new Set('the and for our your with now this that then more one'.split(' '));
const stems = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
      .filter((w) => !SMALL.has(w))
      .map((w) => w.slice(0, 5)),
  );

function choiceOf(
  raw: RawUnderstanding['choice'],
  claim: Claim,
  referral: UnderstoodReferral | null,
): UnderstoodChoice | null {
  if (raw === null) return null;
  const options = raw.options.slice(0, 4).flatMap((o) => claim('choice.option', o, 'plain') ?? []);
  const pick = claim('choice.pick', raw.pick);
  const because = claim('choice.because', raw.because);
  if (options.length < 2 || pick === null || because === null) return null;
  // The pick is one of them, some of them, or none: never a third thing.
  const said = stems(pick);
  const one =
    options.some((o) => [...stems(o)].some((w) => said.has(w))) ||
    /\b(?:both|neither|none|first|second)\b/iu.test(pick);
  // Whether to sign, take or own is a person's to decide: no pick of it.
  if (!one || (referral !== null && referral !== 'wellbeing' && referral !== 'grants' && PERSONAL.test(pick)))
    return null;
  return { options, pick, because, flipsIf: claim('choice.flips_if', raw.flips_if) };
}
const PERSONAL =
  /\b(?:sign|accept|take (?:the|it|his|her|their)|offer|equity|shares|patent|visa|salary|percent|%)/iu;

function resultOf(raw: RawUnderstanding['result'], claim: Claim): UnderstoodResult | null {
  if (raw === null) return null;
  const shows = claim('result.shows', raw.shows);
  if (shows === null) return null;
  return {
    verdict: raw.verdict,
    shows,
    doesNotShow: claim('result.does_not_show', raw.does_not_show),
    settles: claim('result.settles', raw.settles),
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
