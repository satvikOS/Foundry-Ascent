import { figuresIn } from '../understand/figures.js';
import type { JudgeReading, JudgeVoiceReading, RouteReading, SumsReading } from '../understand/schema.js';
import type { UnderstoodKind, UnderstoodReferral } from '../understand/types.js';
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

function kindOf(message: string): UnderstoodKind {
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

const REFERRALS: readonly (readonly [RegExp, UnderstoodReferral])[] = [
  [/\bpatent|\bwho owns (?:the|my|our)|\blab\b.*\brights\b/u, 'ip'],
  [/\bvisa\b|\bf-?1\b/u, 'immigration'],
  [/\bsign(?:ing)? (?:the|this|it|a|an)\b.*\b(?:contract|agreement|form)\b|\blawyer\b/u, 'legal'],
  [/\bvaluation\b|\bwhat (?:is|am) (?:my|our) company worth\b|\bterm sheet\b/u, 'valuation'],
  [/\bequity\b|\bsplit the shares\b/u, 'equity'],
  [/\bfda\b|\bhealth claim\b|\bpermit\b/u, 'regulatory'],
];

/** The lines of the record that share most with the message. */
function bearingOn(prompt: string, message: string): { readonly key: string; readonly text: string }[] {
  const asked = stemsOf(message);
  return [...tag(prompt, 'record').matchAll(/^(R\d+) \(([a-z_]+)[^)]*\): (.*)$/gmu)]
    .map((m) => ({ key: m[1] ?? '', text: unescape(m[3] ?? '') }))
    .map((l) => ({ ...l, shared: [...stemsOf(l.text)].filter((w) => asked.has(w)).length }))
    .filter((l) => l.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3);
}

/** The mock's ROUTE. */
export function mockRoute(prompt: string): RouteReading {
  const message = unescape(tag(prompt, 'message'));
  const said = message.toLowerCase();
  const kind = kindOf(message);
  return {
    a:
      message
        .split(/\s+/u)
        .filter((w) => w !== '')
        .slice(0, 16)
        .join(' ')
        .replace(/[<>{}[\]|\\*_`#]/gu, ' ')
        .trim() || 'nothing that can be read',
    b: null,
    k: kind === 'result' ? ['result', 'question'] : [kind],
    r: bearingOn(prompt, message).map((l) => l.key),
    c: null,
    f: REFERRALS.find(([pattern]) => pattern.test(said))?.[1] ?? null,
    p: null,
    s: null,
    h: false,
  };
}

/** The mock's SUMS. */
export function mockSums(prompt: string): SumsReading {
  const message = unescape(tag(prompt, 'message'));
  const figures = figuresIn(message).filter((f) => f.value > 0 && f.mark !== 'foreign');
  const price = figures.find((f) => f.mark === '$');
  const count = figures.find((f) => f.mark === null);
  if (kindOf(message) !== 'sum') return { q: null, w: null, n: [], s: [], m: null };
  if (price === undefined || count === undefined)
    return { q: 'the figure', w: null, n: [], s: [], m: 'the numbers it needs' };
  return {
    q: 'what comes in',
    w: 'the count times the price',
    n: [`price=$${String(price.value)}@message`, `count=${String(count.value)}@message`],
    s: [{ l: 'what comes in', u: '$', e: 'count * price' }],
    m: null,
  };
}

/** The mock's JUDGE. */
export function mockJudge(prompt: string): JudgeReading {
  const message = unescape(tag(prompt, 'message'));
  const kind = kindOf(message);
  const options =
    kind === 'choice' ? /(?:should (?:i|we) )([^?,]{3,60}?) or ([^?,]{3,60})/iu.exec(message) : null;
  const [first, second] = [options?.[1]?.trim(), options?.[2]?.trim()];
  return {
    x: null,
    o:
      first !== undefined && second !== undefined
        ? { o: [first, second], p: first, b: 'It is the smaller thing to try first.', f: null }
        : null,
    t:
      kind === 'result' || kind === 'update'
        ? {
            v: 'too_early',
            s: `You told what happened: ${message.slice(0, 60).replace(/[<>{}[\]|\\*_`#]/gu, ' ')}`,
            n: 'Whether the same people would pay for it.',
            e: 'Asking them for something that costs them.',
          }
        : null,
    g: bearingOn(prompt, message)
      .slice(0, 2)
      .map((l) => l.text),
    d: null,
  };
}

/** The mock's JUDGE on a call. */
export function mockJudgeVoice(prompt: string): JudgeVoiceReading {
  const { o, t } = mockJudge(prompt);
  return {
    o: o === null ? null : { o: o.o, p: o.p, b: o.b },
    t: t === null ? null : { v: t.v, s: t.s, e: t.e },
  };
}
