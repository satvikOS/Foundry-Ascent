import { percent } from './calc.js';
import { partsIn } from './counts.js';
import { choiceOf, ownSentences } from './kinds.js';
import { bare, lowerFirst, toYou, upperFirst } from './tell.js';
import { contentStems, plain } from './words.js';

/**
 * A choice they ask to have made ("north or south?", "which of the two this week?", "could my flatmate do it?"): the options
 * as they said them, for the reply's first sentence to pick from, and the pick itself when what they told plainly decides
 * it (6 of 20 against 11 of 60). Pure.
 */
export interface Choice {
  readonly kind: 'either' | 'which' | 'yes_no';
  /** [] when they name none ("which of the two?"). */
  readonly options: readonly string[];
  /** The option what they told decides for, with the numbers that do: what the reply opens with. */
  readonly pick: {
    readonly option: string;
    readonly text: string;
    readonly voice: string;
  } | null;
}

const ASKED_OF_US = /^(?:can|could|would|will|do|did|are|have) you\b/;
const LEAD_IN =
  /^(?:(?:so|and|but|ok(?:ay)?|well|then|hi|hey|also|honestly|alright|right|fine|quick question|one question|just|wait|um+|uh+|like)[,:.! ]+)*/;
const YES_NO =
  /^(?:is|are|am|was|were|do|does|did|should|shall|can|could|may|might|must|will|would|has|have|had) (?:i|we|it|that|this|they|he|she|there|my|our|the|a|an|these|those|any|someone|somebody|people|students)\b/;
const WHICH =
  /\bwhich (?:of (?:the|these|those|my|our|them)(?: two| three| four| \d)?|one|two|idea|group|customer|channel|market|price|option|venture|product|city|place|shop|club|team|first|way|side|marketing channel|[a-z]+)\b[^?]*\b(?:should|do|would|is|first|better|best|now|next|go|focus|start|pick|choose|spend|take|try|work)\b/;
const WHAT_WAY = /^(?:what|which|how|why|who|when|where)\b/;

/** A list of things they could do, told before ("I could do flyers, social posts or talk to captains"). */
function optionsTold(earlier: readonly string[]): string[] {
  for (const text of [...earlier].reverse().slice(0, 2))
    for (const sentence of ownSentences(text)) {
      const m =
        /\b(?:could|can|might|either|between|choose|options? (?:are|is)|thinking of|deciding between)\b(?: (?:do|try|use|be|sell to|go to|work on|with))?:? (.+? or .+)$/i.exec(
          bare(sentence),
        );
      const list = m?.[1];
      if (list === undefined) continue;
      const options = list
        .split(/\s*,\s*(?:or\s+)?|\s+or\s+/i)
        .map((o) => o.replace(/^(?:a|an|the|either)\s+/i, '').trim())
        .filter((o) => o !== '' && o.split(/\s+/).length <= 8);
      if (options.length >= 2 && options.length <= 5) return options;
    }
  return [];
}

/** The choice the message asks to have made; null: none. */
export function choiceIn(input: {
  readonly message: string;
  readonly earlier: readonly string[];
  /** What the record and the founder told, oldest first. */
  readonly told: readonly string[];
}): Choice | null {
  const { message, earlier } = input;
  const either = choiceOf(message);
  const told = [...input.told, ...earlier, message];
  if (either.length >= 2) return { kind: 'either', options: either, pick: decided(either, told) };
  const asked = ownSentences(message).map((s) => plain(s).replace(LEAD_IN, ''));
  if (asked.some((s) => WHICH.test(s) && (s.endsWith('?') || WHAT_WAY.test(s)))) {
    const options = optionsTold(earlier);
    return { kind: 'which', options, pick: decided(options, told) ?? concentrated(message, options, told) };
  }
  const yesNo = asked.find(
    (s) => /\byes or no\b/.test(s) || (YES_NO.test(s) && !ASKED_OF_US.test(s) && s.endsWith('?')),
  );
  return yesNo === undefined ? null : { kind: 'yes_no', options: ['yes', 'no'], pick: null };
}

/** Most the rates of two options may be apart and still not decide (in points of a hundred). */
const APART = 8;
/** Fewest that were asked for a rate to decide. */
const LEAST_ASKED = 10;

export interface Rated {
  readonly option: string;
  readonly part: number;
  readonly whole: number;
}

/** Where a sentence names the option: its own words, the ones the other options do not share. */
function stemsOf(option: string, others: readonly string[]): string[] {
  const shared = new Set(others.flatMap(contentStems));
  const own = contentStems(option).filter((w) => !shared.has(w));
  return own.length > 0 ? own : contentStems(option);
}

/** What was told of each option as a part of a whole, the latest first. */
function ratedOf(options: readonly string[], told: readonly string[]): Rated[] {
  return options.flatMap((option): Rated[] => {
    const words = stemsOf(
      option,
      options.filter((o) => o !== option),
    );
    if (words.length === 0) return [];
    for (const text of [...told].reverse())
      for (const clause of text.split(
        /[;.!?]\s*|,\s+(?=(?:and|but|while|in|at|the)\b)|\s+(?:but|while)\s+/i,
      )) {
        const held = new Set(contentStems(clause));
        if (!words.some((w) => held.has(w))) continue;
        // Another option in the same clause: whose number it is cannot be told.
        if (
          options.some(
            (o) => o !== option && stemsOf(o, [option]).some((w) => held.has(w) && !words.includes(w)),
          )
        )
          continue;
        const part = partsIn(clause)[0];
        if (part !== undefined) return [{ option, part: part.part, whole: part.whole }];
      }
    return [];
  });
}

/** Two options by what was counted of each, the plainly higher first; null when they are close, or few were asked. */
function ranked(
  options: readonly string[],
  told: readonly string[],
): { readonly best: Rated; readonly other: Rated } | null {
  if (options.length !== 2) return null;
  const rated = ratedOf(options, told).sort((a, b) => b.part / b.whole - a.part / a.whole);
  const [best, other] = rated;
  if (best === undefined || other === undefined || rated.length !== 2) return null;
  if (Math.min(best.whole, other.whole) < LEAST_ASKED) return null;
  return (best.part / best.whole - other.part / other.whole) * 100 < APART ? null : { best, other };
}

/** The counts that decided a choice they asked to have made; null: none, or it was not decided by counts. */
export function ratesOf(input: {
  readonly message: string;
  readonly earlier: readonly string[];
  readonly told: readonly string[];
}): { readonly best: Rated; readonly other: Rated } | null {
  const either = choiceOf(input.message);
  return either.length < 2 ? null : ranked(either, [...input.told, ...input.earlier, input.message]);
}

/** The option whose rate is plainly the higher; null when they are close, few were asked, or one of them was never told. */
function decided(options: readonly string[], told: readonly string[]): Choice['pick'] {
  const found = ranked(options, told);
  if (found === null) return null;
  const { best, other } = found;
  const said = (r: Rated): string => `${String(r.part)} of ${String(r.whole)} (${percent(r.part, r.whole)})`;
  const name = upperFirst(bare(toYou(best.option)));
  return {
    option: best.option,
    text: `${name}: ${said(best)}, against ${said(other)} for the other. Go by the share, not by the bigger number.`,
    voice: `${name}: ${said(best)}, against ${said(other)} for the other.`,
  };
}

/** The way most of their buyers came, of the ones they could use; null: nothing they told decides it. */
export function settledWay(said: readonly string[], told: readonly string[]): string | null {
  return concentrated('which channel', optionsTold(said), told)?.option ?? null;
}

const CAME_FROM =
  /(?<![\d.$])\b(\S+) (?:of|out of) (?:the |my |our |all )?(\S+) (?:[a-z-]+ ){0,5}?(?:came|come|are|were|was) (?:from|through|by|via) ((?:[a-z'-]+ ){0,3}?[a-z'-]+)(?=[.,;!?]|$| and| but| who)/i;

/** "Which channel first?" when most of their sales came one way. */
function concentrated(message: string, options: readonly string[], told: readonly string[]): Choice['pick'] {
  if (!/\b(?:channel|focus|way|where|marketing|source)\b/.test(plain(message)) && options.length === 0)
    return null;
  for (const text of [...told].reverse()) {
    const m = CAME_FROM.exec(bare(text));
    const part = partsIn(text)[0];
    if (m === null || part === undefined || part.part * 2 < part.whole || part.whole < LEAST_ASKED) continue;
    const way = bare(m[3] ?? '');
    const option =
      options.find((o) => contentStems(o).some((w) => contentStems(way).includes(w))) ??
      (options.length === 0 ? way : null);
    if (option === null) continue;
    const share = `${String(part.part)} of ${String(part.whole)} (${percent(part.part, part.whole)})`;
    return {
      option,
      text: `${upperFirst(lowerFirst(option))} first: ${share} came that way. Copy it until it stops working, and leave the others for later.`,
      voice: `${upperFirst(lowerFirst(option))} first: ${share} came that way.`,
    };
  }
  return null;
}
