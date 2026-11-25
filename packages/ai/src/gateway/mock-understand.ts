import { figuresIn } from '../understand/figures.js';
import type { RawUnderstanding } from '../understand/schema.js';
import { stemsOf } from '../validators/stems.js';

/**
 * The mock gateway's reading of a message (understand/): a few deterministic rules standing in for the model, so a turn
 * with the understand call on runs offline (unit and DB tests, the e2e suite, the dev server, the lab's dry run). Plausible,
 * never good: what the real models make of a message is measured by the lab's `understand` suite alone.
 */

const tag = (text: string, name: string): string =>
  new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`, 'u').exec(text)?.[1]?.trim() ?? '';
const unescape = (text: string): string =>
  text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&');

function kindOf(message: string): RawUnderstanding['kind'] {
  const said = message.toLowerCase();
  if (/^(?:hi|hey|hello|thanks|thank you|bye|ok)\b[^?]{0,30}$/u.test(said)) return 'social';
  if (/\b(?:other (?:team|founder|venture|student)|someone else)\b/u.test(said)) return 'privacy';
  if (/\b(?:make (?:it |them )?up|fake|pretend|invent)\b/u.test(said)) return 'integrity';
  if (/\b(?:how much|how many|what do (?:i|we) (?:keep|make|earn)|break ?even|runway)\b/u.test(said))
    return 'sum';
  if (
    /\b(?:what (?:should|do) (?:i|we) do (?:next|now)|what next|where (?:do|should) (?:i|we) (?:start|begin))\b/u.test(
      said,
    )
  )
    return 'next';
  if (/\b(?:what did (?:i|we|you)|remember|remind me|recap)\b/u.test(said)) return 'recall';
  if (/\bwrite (?:me|it|a|an|the)\b/u.test(said)) return 'draft';
  if (/\b(?:scared|anxious|overwhelmed|burn(?:ed|t) out|worn out)\b/u.test(said)) return 'feelings';
  if (/\bshould (?:i|we)\b[^?]*\bor\b|\bwhich (?:one|of)\b/u.test(said)) return 'choice';
  if (/\b(?:i|we) (?:did|sold|talked|asked|got|tried|had|lost|showed|interviewed)\b/u.test(said))
    return said.includes('?') ? 'result' : 'update';
  return 'question';
}

const REFERRALS: readonly (readonly [RegExp, NonNullable<RawUnderstanding['referral']>])[] = [
  [/\bpatent|\bwho owns (?:the|my|our)|\blab\b.*\brights\b/u, 'ip'],
  [/\bvisa\b|\bf-?1\b/u, 'immigration'],
  [/\bsign(?:ing)? (?:the|this|it|a|an)\b.*\b(?:contract|agreement|form)\b|\blawyer\b/u, 'legal'],
  [/\bvaluation\b|\bwhat (?:is|am) (?:my|our) company worth\b|\bterm sheet\b/u, 'valuation'],
  [/\bequity\b|\bsplit the shares\b/u, 'equity'],
  [/\bfda\b|\bhealth claim\b|\bpermit\b/u, 'regulatory'],
];

/** A deterministic reading of the understand call's user message. */
export function mockUnderstanding(prompt: string): RawUnderstanding {
  const message = unescape(tag(prompt, 'message'));
  const said = message.toLowerCase();
  const kind = kindOf(message);
  const lines = [...tag(prompt, 'record').matchAll(/^(R\d+) \(([a-z_]+)[^)]*\): (.*)$/gmu)].map((m) => ({
    key: m[1] ?? '',
    text: unescape(m[3] ?? ''),
  }));
  const asked = stemsOf(message);
  const bearing = lines
    .map((l) => ({ ...l, shared: [...stemsOf(l.text)].filter((w) => asked.has(w)).length }))
    .filter((l) => l.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3);
  const figures = figuresIn(message).filter((f) => f.value > 0 && f.mark !== 'foreign');
  const price = figures.find((f) => f.mark === '$');
  const count = figures.find((f) => f.mark === null);
  const summed = kind === 'sum' && price !== undefined && count !== undefined;
  const options =
    kind === 'choice' ? /(?:should (?:i|we) )([^?,]{3,60}?) or ([^?,]{3,60})/iu.exec(message) : null;
  const [first, second] = [options?.[1]?.trim(), options?.[2]?.trim()];
  const words = message.split(/\s+/u).filter((w) => w !== '');
  return {
    ask:
      words
        .slice(0, 20)
        .join(' ')
        .replace(/[<>{}[\]|\\*_`#]/gu, ' ')
        .trim() || 'nothing that can be read',
    second_ask: null,
    kind,
    also: kind === 'result' ? ['question'] : [],
    record: bearing.map((l) => l.key),
    contradicts: null,
    inputs: summed
      ? [
          { name: 'price', value: price.value, unit: '$', from: 'message' },
          { name: 'count', value: count.value, unit: 'count', from: 'message' },
        ]
      : [],
    sums: summed
      ? [{ label: 'what comes in', unit: '$', noun: null, expr: 'count * price', round: 'none', asked: true }]
      : [],
    missing: kind === 'sum' && !summed ? 'the numbers it needs' : null,
    choice:
      first !== undefined && second !== undefined
        ? {
            options: [first, second],
            pick: first,
            because: 'It is the smaller thing to try first.',
            flips_if: null,
          }
        : null,
    result:
      kind === 'result' || kind === 'update'
        ? {
            verdict: 'too_early',
            shows: 'You went out and something happened.',
            does_not_show: 'Whether the same people would pay for it.',
            settles: 'Asking them for something that costs them.',
          }
        : null,
    referral: REFERRALS.find(([pattern]) => pattern.test(said))?.[1] ?? null,
    play: null,
    step_play: null,
    sure: 'low',
    points: bearing.slice(0, 2).map((l) => ({ text: l.text, basis: l.key })),
    first_action: null,
    avoid: null,
  };
}
