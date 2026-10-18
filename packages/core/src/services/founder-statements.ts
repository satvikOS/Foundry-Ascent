import { contentWords } from '@foundry/ai';
import { type MemoryCandidate } from '@foundry/contracts';

/**
 * What the founder states about their venture in their own words, kept with the turn that stated it (LAB-K1).
 *
 * knowledge.spec against the real model: "We've decided to ask each library for a paid commitment before the pilot
 * starts." kept nothing with the turn (2 of 2 attempts): the model rarely fills `memory_candidates`, and in a chat
 * nothing else is kept until the conversation is distilled, nine minutes after its last turn. A call passed only
 * because an ended call is distilled at once.
 *
 * Distilling chats sooner would multiply distillation calls (every pause longer than the active window inside a chat
 * distils what came before it, then the rest again), and a model call per turn to extract statements would add a
 * call to every turn. So an explicit first-person decision, goal or constraint is read from the founder's message
 * here, without a model: high precision, the plain shapes only ("we've decided to…", "our goal is…", "we can't…"),
 * never a question or a hedge ("maybe", "thinking about", "not sure"). It is offered as one more `founder_stated`
 * candidate, unless the model's own candidates already say it, and goes through the same hygiene as any other
 * (the coach-echo and forgotten checks, deduplication against the venture's memory, settling by meaning after the
 * turn); the distillation later refines it like any kept item.
 */

const LEAD = String.raw`^(?:(?:so|ok(?:ay)?|right|well|update|news|honestly|quick update|fyi|just so you know)[\s,:;!.—–-]+)*`;
const DECISION = new RegExp(
  `${LEAD}(we|i)(?:['’]ve| have)?\\s+(?:now\\s+|just\\s+|finally\\s+|officially\\s+)?(decided|agreed|chosen|chose|committed|settled on|signed off on)\\s+(to\\s+)?(.+)$`,
  'i',
);
const GOAL = new RegExp(
  `${LEAD}(our|my)\\s+(?:main\\s+|big\\s+|real\\s+|first\\s+|top\\s+)?(goal|aim|target|priority)(?:\\s+(?:for|this|next|in)\\s+[\\w\\s]{1,30}?)?\\s+is\\s+((?:to\\s+)?.+)$`,
  'i',
);
const CONSTRAINT = new RegExp(
  `${LEAD}(we|i)\\s+(can['’]?t|cannot|can not|won['’]?t be able to|don['’]?t have (?:the )?(?:budget|money|time|funding|runway) (?:to|for))\\s+(.+)$`,
  'i',
);
/** Hedges and questions: nothing is decided ("maybe we've decided…", "should we…?"). */
const HEDGE =
  /\?|\b(?:maybe|might|perhaps|probably|possibly|thinking (?:about|of)|considering|not sure|unsure|wondering|if we|whether|unless|kind of|sort of)\b/i;

const MIN_WORDS = 2;
const MAX_WORDS = 30;
const TITLE_CHARS = 80;
/** Share of a statement's content words a model candidate must already say for it to cover the statement. */
const COVERED_SHARE = 0.5;

/** The founder's words in the third person, for a note about the venture ("our pilot" → "their pilot"). */
function thirdPerson(text: string): string {
  return text
    .replace(/\b(?:our|my)\b/gi, 'their')
    .replace(/\b(?:ours|mine)\b/gi, 'theirs')
    .replace(/\b(?:us|me)\b/gi, 'them')
    .replace(/\b(?:we|i)\b/gi, 'they')
    .replace(/\b(?:ourselves|myself)\b/gi, 'themselves');
}

function clause(text: string): string | null {
  const words = text
    .trim()
    .replace(/[.!…]+$/, '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < MIN_WORDS || words.length > MAX_WORDS) return null;
  return thirdPerson(words.join(' '));
}

function titleOf(text: string): string {
  const capitalised = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  if (capitalised.length <= TITLE_CHARS) return capitalised;
  const cut = capitalised.slice(0, TITLE_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trimEnd()}…`;
}

/** Whether one of `candidates` already says `statement` (half of its content words, stemmed). */
function covered(
  statement: string,
  candidates: readonly Pick<MemoryCandidate, 'title' | 'content'>[],
): boolean {
  const words = [...contentWords(statement)];
  if (words.length === 0) return true;
  return candidates.some((c) => {
    const said = contentWords(`${c.title} ${c.content}`);
    return words.filter((w) => said.has(w)).length / words.length >= COVERED_SHARE;
  });
}

/**
 * The decisions, goals and constraints `founderText` states in the plain first-person shapes (see the module
 * comment), as `founder_stated` memory candidates, except those `modelCandidates` already say. `founderName` (their
 * first name) is the subject of what "I" decided; "we" is the team.
 */
export function statedMemory(
  founderText: string,
  options: {
    readonly founderName: string | null;
    readonly modelCandidates: readonly Pick<MemoryCandidate, 'title' | 'content'>[];
  },
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const sentences = founderText
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (sentence === '' || HEDGE.test(sentence)) continue;
    const who = (pronoun: string): string =>
      /^i$/i.test(pronoun) ? (options.founderName ?? 'The founder') : 'The team';
    const decision = DECISION.exec(sentence);
    const goal = GOAL.exec(sentence);
    const constraint = CONSTRAINT.exec(sentence);
    let item: Pick<MemoryCandidate, 'type' | 'title' | 'content'> | null = null;
    if (decision?.[1] !== undefined && decision[2] !== undefined && decision[4] !== undefined) {
      const what = clause(decision[4]);
      if (what !== null) {
        const verb = decision[2].toLowerCase() === 'chosen' ? 'chose' : decision[2].toLowerCase();
        item = {
          type: 'decision',
          title: titleOf(what),
          content: `${who(decision[1])} ${verb}${decision[3] === undefined ? '' : ' to'} ${what}.`,
        };
      }
    } else if (goal?.[1] !== undefined && goal[2] !== undefined && goal[3] !== undefined) {
      const what = clause(goal[3]);
      if (what !== null) {
        const whose = /^my$/i.test(goal[1]) ? `${options.founderName ?? 'The founder'}'s` : "The team's";
        item = {
          type: 'fact',
          title: titleOf(`${goal[2].toLowerCase()}: ${what}`),
          content: `${whose} ${goal[2].toLowerCase()} is ${what}.`,
        };
      }
    } else if (constraint?.[1] !== undefined && constraint[2] !== undefined && constraint[3] !== undefined) {
      const what = clause(constraint[3]);
      if (what !== null) {
        const limit = constraint[2]
          .toLowerCase()
          .replace(/['’]/g, "'")
          .replace(/^can not$/, 'cannot');
        // "The team" and the founder are one subject each: "doesn't have the budget to…".
        const verb = limit.replace(/^don't/, "doesn't");
        item = {
          type: 'fact',
          title: titleOf(`${limit} ${what}`),
          content: `${who(constraint[1])} ${verb} ${what}.`,
        };
      }
    }
    if (item === null || covered(item.content, [...options.modelCandidates, ...out])) continue;
    out.push({ ...item, evidence_ids: [], confidence: 0.7, source: 'founder_stated' });
  }
  return out;
}
