import type { TurnChannel } from '@foundry/contracts';

import { contentWords } from '../prompts/conversation-state.js';
import { PATH_TAG } from '../prompts/guidance.js';
import { shortAnswer, withKey } from '../validators/reply-contract.js';
import { coverage, sharedCount, stemsOf } from '../validators/stems.js';
import { unitsOf, wordsIn } from '../validators/units.js';

/**
 * For the mock gateway (gateway/mock*.ts): a reply shaped as the path asks, read from the `<path>` block of the turn's
 * system prompt as a model reads it (never from the turn's own objects): the play's answer with its key, one thing the
 * venture's record holds, who decides and what to bring. Never the step, nor what the reply already opens with: the server
 * writes those. Deterministic.
 */

function unescapeData(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** What a `<path>` block says, as far as a reply needs it. */
export interface PathBlock {
  readonly kind: 'coaching' | 'report' | 'news' | 'recall' | 'social' | 'rehearsal' | 'new_idea';
  /** The `<who>` brief, line by line. */
  readonly brief: readonly string[];
  readonly firstTime: boolean;
  readonly answer: string | null;
  readonly why: string | null;
  readonly evidenceKeys: readonly string[];
  readonly stepTitle: string | null;
  /** What the reply already opens with. */
  readonly opens: string | null;
  /** The one prior fact to build on, and the sums given. */
  readonly prior: string | null;
  readonly sums: string | null;
  readonly referral: { readonly who: string; readonly bring: string } | null;
  readonly newIdea: { readonly venture: string; readonly fact: string | null } | null;
  readonly social: boolean;
  readonly rehearsal: boolean;
}

/** Reads the `<path>` block of a system prompt; null when the turn has none. */
export function pathBlockIn(system: string): PathBlock | null {
  const start = system.lastIndexOf(`\n<${PATH_TAG}>\n`);
  const end = system.indexOf(`\n</${PATH_TAG}>`, start + 1);
  if (start < 0 || end < 0) return null;
  const block = system.slice(start, end);
  const of = (pattern: RegExp): string | null => {
    const value = pattern.exec(block)?.[1];
    return value === undefined ? null : unescapeData(value.trim());
  };
  const who = /<who>\n([\s\S]*?)\n<\/who>/.exec(block)?.[1] ?? '';
  const referral = /^<referral>.*?Say who, and what to bring, once: (.+?)\. Bring: (.*?)\. Then help/m.exec(
    block,
  );
  const venture = of(/^<new_idea venture="([^"]*)"/m);
  const social = block.includes('This turn is social');
  const rehearsal = block.includes('This turn is practice');
  return {
    kind: social
      ? 'social'
      : rehearsal
        ? 'rehearsal'
        : venture !== null
          ? 'new_idea'
          : block.includes('They report on their work')
            ? 'report'
            : block.includes('They bring news and ask nothing')
              ? 'news'
              : block.includes('They ask what you remember')
                ? 'recall'
                : 'coaching',
    brief: who
      .split('\n')
      .map((l) => unescapeData(l.trim()))
      .filter((l) => l !== ''),
    firstTime: block.includes('First-time founder:'),
    answer: of(/^(?:If this is what they asked, s|S)ay this pick first, in your own words: (.+)$/m),
    why: of(/^Why: (.+)$/m),
    evidenceKeys: (of(/^Cite: \[([^\]]*)\]$/m) ?? '').split(/,\s*/).filter((k) => k !== ''),
    stepTitle: of(/^<step title="([^"]*)"/m),
    opens: of(/^<opens>(.*)<\/opens>$/m),
    prior: of(/^<prior>(.*)<\/prior>$/m),
    sums: of(/^<sums>(.*)<\/sums>$/m),
    referral:
      referral === null
        ? null
        : { who: unescapeData(referral[1] ?? ''), bring: unescapeData(referral[2] ?? '') },
    newIdea: venture === null ? null : { venture, fact: of(/^<new_idea venture="[^"]*" fact="([^"]*)"/m) },
    social,
    rehearsal,
  };
}

/** The lines of a brief that tell what they did, found and decided, the most telling first, as a reply says them. */
const FACTS: readonly (readonly [RegExp, string])[] = [
  [/^Decided ([\d-]+): (.+)$/u, 'you decided: $2'],
  [/^Known \([\d-]+\): (.+)$/u, '$1'],
  [/^Result: (.+)$/u, '$1'],
  [/^Did \([\d-]+\): (.+)$/u, 'you did this: $1'],
  [/^They reported(?: \([^)]*\))?: "(.+)"$/u, 'you reported: $1'],
  [/^Changed direction [\d-]+, from: (.+)$/u, 'you changed direction from $1'],
  [/^Milestone [\d-]+: (.+)$/u, '$1'],
  [/^Running: (.+)$/u, '$1'],
  [/^Said they would: (.+)$/u, 'you said you would: $1'],
  [/^Done so far, they say: (.+)$/u, '$1'],
  [/^Idea, in their words: (.+)$/u, '$1'],
  [/^Told: (.+)$/u, 'you told me $1'],
  [/^Venture: [^.]*\. (.+)$/u, '$1'],
];

function withoutStop(text: string): string {
  return text.replace(/[\s.…!?]+$/u, '');
}

/** The first words of `text` that are not `said` yet: what the mock says once in a conversation. */
function unsaid(text: string, said: string): boolean {
  const plain = (t: string): string =>
    ` ${t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()} `;
  return !plain(said).includes(plain(text.split(/\s+/).slice(0, 5).join(' ')).trim());
}

/**
 * One thing the record, or the founder earlier in this conversation (`told`), says, nearest what they asked about and not
 * `said` before; null with nothing but who they are.
 */
export function factIn(
  path: PathBlock,
  founderText: string,
  told: readonly string[] = [],
  said = '',
): string | null {
  const asked = contentWords(founderText);
  const lines = [...path.brief, ...told.map((t) => `Told: ${t}`)];
  const found = lines.flatMap((line, order) =>
    FACTS.flatMap(([pattern, say], rank) =>
      pattern.test(line)
        ? [
            {
              text: withoutStop(line.replace(pattern, say)),
              shared: [...contentWords(line)].filter((w) => asked.has(w)).length,
              rank,
              order,
            },
          ]
        : [],
    ).slice(0, 1),
  );
  found.sort((a, b) => b.shared - a.shared || a.rank - b.rank || a.order - b.order);
  return found.find((f) => unsaid(f.text, said))?.text ?? null;
}

/** What the record holds, said back ("what is my idea, what did we decide?"), when the path wrote no answer to it. */
function recalled(path: PathBlock, told: readonly string[]): string {
  const of = (pattern: RegExp, say: string): string[] =>
    path.brief.filter((l) => pattern.test(l)).map((l) => `${withoutStop(l.replace(pattern, say))}.`);
  return [
    ...of(/^Venture: ([^(]+?) \([^)]*\)\.? ?(.*)$/u, 'Your venture is $1. $2'),
    ...of(/^Idea, in their words: (.+)$/u, 'In your words: $1'),
    ...of(/^Decided ([\d-]+): (.+)$/u, 'On $1 you decided: $2'),
    ...of(/^Known \(([\d-]+)\): (.+)$/u, 'From $1: $2'),
    ...of(/^Last conversation \(([\d-]+)\): (.+)$/u, 'On $1 we talked: $2'),
    ...of(/^Said they would: (.+)$/u, 'You said you would: $1'),
    ...told.map((t) => `You told me ${withoutStop(t)}.`),
  ]
    .slice(0, 6)
    .join(' ')
    .replace(/\.{2,}/g, '.');
}

/** Business words a first-time founder is told the meaning of (a model does it in its own words). */
const MEANINGS: readonly (readonly [RegExp, string])[] = [
  [/\bvalue propositions?\b/iu, 'A value proposition is one sentence on who you help and how.'],
  [/\bunit economics\b/iu, 'Unit economics means what one sale leaves after its costs.'],
  [/\bletters? of intent\b/iu, 'A letter of intent is a signed note that says they plan to buy.'],
  [/\bbeachhead\b/iu, 'A beachhead is the first small group you win.'],
  [/\bmvp\b|\bminimum viable product\b/iu, 'An MVP is the smallest version that tests the idea.'],
];

interface ShownEvidence {
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly text: string;
}

/** What the record and the documents shown say about what they ask (never the play, which is the answer), and its key. */
function quoteIn(
  evidence: readonly ShownEvidence[],
  founderText: string,
  said: string,
): { readonly text: string; readonly key: string; readonly shared: number } | null {
  const asked = stemsOf(founderText);
  const found = evidence
    .filter((e) => e.kind === 'memory' || e.kind === 'chunk')
    .flatMap((e) =>
      unitsOf(e.text)
        .map((u) => withoutStop(u.text.replace(/^(?:[-*+•#>\s]|\d{1,3}[.)]\s)+/u, '')))
        .filter(
          (text) => wordsIn(text) >= 5 && wordsIn(text) <= 40 && !/[?:]$/u.test(text) && unsaid(text, said),
        )
        .map((text) => ({ text, key: e.key, shared: sharedCount(stemsOf(text), asked) })),
    )
    .filter((f) => f.shared >= 3);
  found.sort((a, b) => b.shared - a.shared);
  return found[0] ?? null;
}

export interface PathReplyOptions {
  readonly founderText?: string;
  /** What the founder said earlier in the conversation, as the mock says it back ("you sell boxes by the dozen"). */
  readonly told?: readonly string[];
  /** Where the last conversation was, when they ask about it ("When we spoke yesterday, we were on pricing."). */
  readonly lastTime?: string;
  /** The earlier replies of the conversation: what they said is not said again. */
  readonly said?: string;
  /** The evidence shown: what the record holds is cited where one of its items says it. */
  readonly evidence?: readonly ShownEvidence[];
  /** Said before the help (an honest answer about the coach, a repair, a word for a hard week). */
  readonly opening?: string;
  /** Said where the playbook answers nothing they asked: the mock's own observation. */
  readonly body?: string;
  /** Said after the help (a flagged topic). */
  readonly note?: string;
  /** Asked last. */
  readonly question?: string;
}

/** Words of a spoken reply (the prompt asks for 45). */
const SPOKEN_WORDS = 46;

/** Lower-cases a clause's first letter, unless it is a name or an acronym. */
function asClause(text: string): string {
  const word = /^[\p{L}\p{N}'’]+/u.exec(text)?.[0] ?? '';
  return /^\p{Lu}[\p{Lu}\d]|^\p{L}\p{Ll}*\p{Lu}|^I$/u.test(word)
    ? text
    : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** A reply in the path's shape from a system prompt, or null (no path, or a social turn or role-play). */
export function mockPathReply(
  system: string,
  channel: TurnChannel,
  options: PathReplyOptions = {},
): string | null {
  const path = pathBlockIn(system);
  if (path === null || path.social || path.rehearsal) return null;
  if (path.answer === null && path.stepTitle === null && path.opens === null) return null;
  const voice = channel === 'voice';
  const recall = path.kind === 'recall';
  const record = path.answer ?? (recall && path.opens === null ? recalled(path, options.told ?? []) : '');
  const told = [recall ? (options.lastTime ?? '') : '', record]
    .filter((t) => t !== '')
    .join(' ')
    .replace(/\s+How: 1\)[\s\S]*$/u, '');
  const key = path.evidenceKeys[0];
  const helps =
    told === ''
      ? ''
      : voice
        ? shortAnswer({ answer: told }, channel)
        : key === undefined
          ? told
          : withKey(told, key);
  const asks = options.founderText ?? '';
  const held = recall ? null : (path.prior ?? factIn(path, asks, options.told, options.said));
  const nearest =
    recall || voice ? null : quoteIn(options.evidence ?? [], asks, `${options.said ?? ''} ${helps}`);
  // The shown sentence, when it is nearer what they ask than what the brief holds.
  const quote =
    nearest !== null && nearest.shared > sharedCount(stemsOf(held ?? ''), stemsOf(asks)) ? nearest : null;
  const fact = quote?.text ?? held;
  const source =
    fact === null || voice
      ? null
      : (quote ??
        options.evidence?.find(
          (e) =>
            e.kind !== 'doctrine' &&
            (coverage(stemsOf(fact), stemsOf(`${e.title} ${e.text}`)) >= 0.7 ||
              (stemsOf(e.title).size >= 3 && coverage(stemsOf(e.title), stemsOf(fact)) >= 0.8)),
        ));
  const parts = {
    opening: path.opens === null ? (options.opening ?? '') : '',
    helps,
    body:
      helps !== ''
        ? ''
        : path.opens === null
          ? (options.body ?? '')
          : 'That is what the next part of your work builds on.',
    fact:
      fact === null
        ? ''
        : `This builds on what you have: ${fact}${source == null ? '' : ` [${source.key}]`}.`,
    referral:
      path.referral === null
        ? ''
        : `That one is for ${asClause(withoutStop(path.referral.who))}. Bring ${asClause(withoutStop(path.referral.bring))}.`,
    note: options.note ?? '',
    meaning: '',
    question: helps === '' && path.opens === null ? (options.question ?? '') : '',
  };
  if (path.firstTime && !voice)
    parts.meaning = MEANINGS.find(([word]) => word.test(`${helps} ${path.stepTitle ?? ''}`))?.[1] ?? '';
  if (!voice)
    return Object.values(parts)
      .filter((p) => p !== '')
      .join('\n\n');
  // Over the budget, the extras go first: the question, the fact, the note, the observation, what it opened with.
  for (const extra of ['question', 'fact', 'note', 'body', 'opening'] as const) {
    if (wordsIn(Object.values(parts).join(' ')) <= SPOKEN_WORDS) break;
    parts[extra] = '';
  }
  return Object.values(parts)
    .filter((p) => p !== '')
    .join(' ');
}
