import { type ArcEntry, type PathIntake } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { isReference, standingDecisions, dayOf } from './brief.js';
import { monthDay } from './dates.js';
import { asksFor, ownSentences } from './kinds.js';
import { milestoneReached, wordsOfEvidence } from './state.js';
import { contentStems, countsIn, numberOf, plain, VENTURE_WORDS } from './words.js';

/**
 * What the record holds, as a mentor says it: in the second person, without the memory's own label, each thing once. The
 * words are the record's; only who says them, and to whom, changes. Pure.
 */

export const bare = (text: string): string => text.replace(/[\s.!?;:,]+$/u, '').trim();

/** Lower-cases a clause's first letter, unless it is a name, an acronym or a number. */
export function lowerFirst(text: string): string {
  const word = /^[\p{L}\p{N}'’]+/u.exec(text)?.[0] ?? '';
  if (
    /^I(?:['’]\p{L}+)?$/u.test(word) ||
    /^\p{Lu}[\p{Lu}\d]/u.test(word) ||
    /^\p{L}\p{Ll}*\p{Lu}/u.test(word)
  )
    return text;
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
export const upperFirst = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "a", "a and b", "a, b and c"; "a, b and b, and c" when a part holds an "and" of its own. */
export function listed(items: readonly string[]): string {
  const all = items.filter((i) => i.trim() !== '');
  if (all.length <= 1) return all[0] ?? '';
  if (all.slice(0, -1).some((i) => i.includes(' and ')))
    return `${all.slice(0, -1).join(', ')}, and ${all.at(-1) ?? ''}`;
  return `${all.slice(0, -1).join(', ')} and ${all.at(-1) ?? ''}`;
}

/** A verb that went with "the founder", as it goes with "you" ("charges" → "charge", "is" → "are"). */
function verbOfYou(verb: string): string {
  const v = verb.toLowerCase();
  const odd: Readonly<Record<string, string>> = {
    has: 'have',
    is: 'are',
    was: 'were',
    does: 'do',
    goes: 'go',
  };
  if (odd[v] !== undefined) return odd[v];
  if (v.endsWith('ies') && v.length > 4) return `${v.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|zz)es$/.test(v)) return v.slice(0, -2);
  if (v.endsWith('s') && v.length > 3 && !/(?:ss|us|is)$/.test(v)) return v.slice(0, -1);
  return verb;
}

const ADVERBS = '(?:currently|also|now|already|still|just|often|usually|really|only|never|recently|first)';
const FOUNDER_DOES = new RegExp(
  `\\b(?:(?:the|this|a) )?(?:student )?founder((?: ${ADVERBS})*)(?: (?!and\\b|or\\b)([a-z]+))?`,
  'giu',
);
/** What else the same subject does ("… and is asking", "… and plans to"). */
const AND_DOES = /\band (is|has|was|does|wants|needs|plans|hopes|believes|thinks|asks|charges|sells)\b/giu;
/** Things of a founder's that a record gives them as someone else's ("their initial idea", "his dorm"). */
const OWNED =
  '(?:(?:initial|original|first|own|new|old|current|next|main|early|student|startup|business|venture|app|product|course|final|four|few|free|limited|spare) )*(?:idea|venture|startup|business|company|product|app|plan|project|concept|direction|price|fee|service|offer|pitch|prototype|team|co-?founder|dorm|hall|campus|school|university|lab|thesis|advisor|exam|class|classes|hours|time|goal|customers?|users?|interviews?|research|record|experience|background|[A-Z][\\w-]*(?: (?:idea|app|venture))?)';
const THEIRS_OF_FOUNDER = new RegExp(`\\b(?:their|his|her) (?=${OWNED}\\b)`, 'gu');
/** Someone else the sentence tells of, whose "his" or "her" it may be. */
const SOMEONE =
  /\b(?:professor|advis[eo]r|manager|nurse|engineer|co-?founder|roommate|relative|uncle|aunt|friend|boss|supervisor|owner|teacher|director|mother|father|brother|sister|customer|user|buyer|student(?! founder))\b/iu;

const YOU: readonly (readonly [RegExp, string])[] = [
  [/\b(?:I|we) (?:am|are)\b/giu, 'you are'],
  [/\b(?:I|we)['’](?:m|re)\b/giu, 'you are'],
  [/\bI was\b/giu, 'you were'],
  [/\b(?:I|we)['’]ve\b/giu, 'you have'],
  [/\b(?:I|we)['’]ll\b/giu, 'you will'],
  [/\b(?:I|we)['’]d\b/giu, 'you would'],
  [/\b(?:myself|ourselves)\b/giu, 'yourself'],
  [/\b(?:mine|ours)\b/giu, 'yours'],
  [/\b(?:my|our)\b/giu, 'your'],
  [/\b(?:me|us)\b(?! (?:dollars?|market|citizens?|based)\b)/gu, 'you'],
  [/\b(?:the|this) (?:founder|student founder)['’]s\b/giu, 'your'],
  [/\bI\b/gu, 'you'],
  [/\bwe\b/giu, 'you'],
];

/**
 * Their own words, or the record's of them, said back to them ("I did eight talks" → "you did eight talks"; "the founder has
 * only four hours" → "you have only four hours"). `name`: their first name, when the record calls them by it.
 */
export function toYou(text: string, name = ''): string {
  let out = text;
  const called = name.trim();
  if (called.length >= 2)
    out = out.replace(new RegExp(`\\b${called.replace(/[^\p{L}\p{N}]/gu, '.')}\\b`, 'giu'), 'the founder');
  const of = out;
  out = out.replace(/\b(?:(?:the|this|a) )?(?:student )?founder['’]s\b/giu, 'your');
  out = out.replace(FOUNDER_DOES, (_whole, adverbs: string, verb: string | undefined) =>
    verb === undefined ? `you${adverbs}` : `you${adverbs} ${verbOfYou(verb)}`,
  );
  // The record tells of the founder: what it calls theirs is yours, and what else they do, you do.
  if (out !== of) {
    out = out.replace(AND_DOES, (_whole, verb: string) => `and ${verbOfYou(verb)}`);
    if (!SOMEONE.test(of)) out = out.replace(/\b(?:his|her)\b(?= \p{L})/gu, 'your');
  }
  if (out !== of || /\btheir (?:initial|original|own|first)\b/u.test(out))
    out = out.replace(THEIRS_OF_FOUNDER, 'your ');
  for (const [pattern, said] of YOU) out = out.replace(pattern, said);
  return out.replace(/\s+/g, ' ').trim();
}

/** A verb an idea's line opens with, of the venture ("helps small schools…") or of the founder ("sell packed lunches…"). */
const VENTURE_DOES =
  /^(?:helps|rents|sells|makes|gives|lets|tells|shows|finds|matches|prints|repairs|resells|recovers|listens|tracks|scores|counts|splits|delivers|teaches|connects|turns|reads|measures|brings|offers|runs|books|writes|builds|shares|saves|cuts|lends|fixes|collects|checks|warns|sends|stores|swaps|plans|organi[sz]es|designs|trains|supports|serves|keeps|moves|maps|compares|creates|provides|allows|enables|uses|takes|buys|pays|gets|puts|hosts|cleans|cooks|grows|links|pairs|ships|sorts|stops|tests|watches|works|mends|stitches|bakes|draws|paints|films|records|trades|guides|grades|translates|drives|walks|tutors|coaches|feeds|plants|installs|schedules|alerts|notifies|reminds|recommends|filters|monitors|detects|predicts|converts|recycles|upcycles|refills|simplifies|automates|manages|handles|rescues|restores|redirects|publishes|edits|reviews|rates|ranks|swaps|insures|audits|explains|replaces|removes|reduces|prevents)\b/iu;
const FOUNDER_WOULD =
  /^(?:help|rent|sell|make|give|let|tell|find|repair|deliver|teach|connect|bring|offer|run|write|build|lend|fix|collect|send|open|start|create|provide|grow|mend|bake|replace|reduce|restore|recycle|clean|cook|serve) /iu;
/** "Books for children", "prints sold at the fair": things, whatever their first word could do. */
const THINGS_NAMED = /^\p{L}+ (?:for|of|from|with|on|in|at|by|between|that|who|and|sold|made|\p{L}+ed)\b/iu;

/** An idea as it goes into a sentence after "about": "GrantGuide, which helps small schools", "selling packed lunches". */
export function ideaAs(idea: string, venture = ''): string {
  const said = lowerFirst(toYou(bare(idea)));
  const name = bare(venture);
  const named = name !== '' && !/^new venture\b/iu.test(name);
  if (named && said.toLowerCase().startsWith(name.toLowerCase())) {
    // "ReadRoost is a corner that travels", "AquaTrace reads strips": the name with what it is, or does.
    const rest = said.slice(name.length).trim();
    const is = /^(?:is|are|will be|would be) (an? .+|the .+)$/iu.exec(rest)?.[1];
    if (is !== undefined) return `${name}, ${is}`;
    return /^(?:[a-z]+s|would|will|lets?|can) /u.test(rest) && !/^(?:is|was|has) /u.test(rest)
      ? `${name}, which ${rest}`
      : `${name}${said.slice(name.length)}`;
  }
  if (VENTURE_DOES.test(said) && !THINGS_NAMED.test(said))
    return named ? `${name}, which ${said}` : `something that ${said}`;
  if (FOUNDER_WOULD.test(said)) return `your plan to ${said}`;
  return said;
}

/** A new direction without what it ends ("No more lunches, I'll rent jars" → "I'll rent jars"). */
export const startsNew = (to: string): string =>
  to.replace(
    /^(?:no (?:more |longer )?|not |stop\w*(?: \w+ing)? )[^,.;:]{2,60}[,.;:]\s*(?:but |and |now |instead )?/i,
    '',
  );

/** The idea as it is said in a sentence: without the "instead" that says what it ends, when it is a thing. */
export const ideaSaid = (idea: string): string => {
  const to = toYou(bare(startsNew(bare(idea))));
  return /^you\b/i.test(to) ? to : to.replace(/[, ]+instead$/i, '');
};

/** Words an instruction or a decision opens with ("Charge 300 dollars…"). */
const DOES =
  /^(?:charge|sell|focus|start|stop|run|build|offer|ask|target|use|keep|launch|test|price|raise|drop|move|pick|choose|work|go|make|send|talk|interview|partner|hire|pivot|switch|rent|pause|wait|apply|join|bring|take|set|do|give|put|pay|serve|open|close|find|get|begin|limit|replace|change)\b/i;

/** A verb somewhere: what it says is a sentence, not a label. */
const SAYS =
  /\b(?:is|are|was|were|has|have|had|said|says|told|asked|paid|pays?|sold|sells?|bought|signed|lost|kept|keeps?|costs?|takes?|came|come|comes|went|go|goes|did|does|do|made|makes?|got|gets?|gave|gives?|ran|runs?|built|found|want(?:s|ed)?|need(?:s|ed)?|described|reported|shared|tracks?|use[sd]?|will|would|can|could|charge[sd]?|decided|interviewed|talked|spoke|offered|tried|tested|booked|fell|rose|grew|dropped|left|stayed|brought|won)\b/i;

const CLAUSE_CHARS = 170;

/** The first sentence of a text, or of its first clauses, at most {@link CLAUSE_CHARS}: never cut inside a word. */
function firstClause(text: string): string {
  const sentence = bare(
    text
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s+/u)[0] ?? '',
  );
  if (sentence.length <= CLAUSE_CHARS) return sentence;
  const cut = sentence.slice(0, CLAUSE_CHARS);
  const at = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(' and '));
  return bare(at > 40 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' ')));
}

/** What they reported: its first sentence, with the next when that is what it found ("I did eight talks; six of them said…"). */
export function told(text: string): string {
  const [first = '', second = ''] = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .map(bare);
  const both = `${first}; ${lowerFirst(second)}`;
  return second !== '' &&
    (/\b(?:said|told|bought|paid|signed|asked|love|like|want|need|because|cannot|no|not)\b/i.test(second) ||
      hasFigure(second)) &&
    both.length <= CLAUSE_CHARS
    ? both
    : firstClause(text);
}

const hasFigure = (text: string): boolean => /\d/.test(text) || countsIn(text).length > 0;

/** A memory as a clause a mentor says ("one shop kept 900 tools on a clipboard"): what it holds, never its label. */
export function toldAs(m: Pick<pathRepo.PathMemory, 'type' | 'title' | 'content'>, name = ''): string {
  const title = bare(m.title.replace(/\s+/g, ' '));
  const content = firstClause(m.content);
  const label = title.split(/\s+/).length <= 5 && !SAYS.test(title) && !hasFigure(title);
  const says =
    content !== '' &&
    (label || SAYS.test(content) || DOES.test(content)) &&
    !(hasFigure(title) && !hasFigure(content))
      ? content
      : title;
  const you = toYou(says, name);
  if (m.type === 'decision') {
    if (/^you (?:have )?(?:decided|agreed|chose)\b/i.test(you)) return lowerFirst(you);
    if (DOES.test(you)) return `you decided to ${lowerFirst(you)}`;
    return /\b(?:is|are|will)\b/.test(you) ? lowerFirst(you) : `you decided: ${lowerFirst(you)}`;
  }
  // Who someone is to them opens with a name ("Ben joined …"), and a kind of people with none ("Caterers pay …").
  return m.type === 'relationship' && !KIND_OF_PEOPLE.test(you) ? you : lowerFirst(you);
}

const KIND_OF_PEOPLE =
  /^\p{Lu}\p{Ll}+s (?:are|were|have|had|pay|paid|say|said|want|need|use|do|buy|bought|ask|asked|would|will|who|and|of|in|at|from)\b/u;

const digitsOf = (text: string): Set<string> =>
  new Set([...(plain(text).match(/\d+(?:\.\d+)?/g) ?? []), ...countsIn(text).map(String)]);

/** Whether two texts tell the same thing: most of the shorter one's words are in the other, and their figures agree. */
export function sameThing(a: string, b: string, share = 0.6): boolean {
  const x = contentStems(a).filter((w) => !/^\d/.test(w));
  const y = contentStems(b).filter((w) => !/^\d/.test(w));
  const least = Math.min(x.length, y.length);
  if (least === 0) return plain(a) === plain(b);
  const shared = x.filter((w) => y.includes(w)).length;
  if (shared < least * share) return false;
  const m = digitsOf(a);
  const n = digitsOf(b);
  if (m.size === 0 || n.size === 0) return true;
  return [...m].some((d) => n.has(d));
}

/**
 * The record without what newer items of it replaced: the same thing told with other figures ("charge 300 dollars an
 * application" once the fee is 450). Items are kept in their order.
 */
export function currentOnes<
  M extends Pick<pathRepo.PathMemory, 'title' | 'content' | 'createdAt' | 'status' | 'type'>,
>(memory: readonly M[]): M[] {
  const text = (m: M): string => `${m.title}. ${m.content}`;
  const MONEY = /\$ ?\d|\b\d[\d.,]* (?:dollars|percent)/i;
  return memory.filter((m) => {
    if (!MONEY.test(text(m)) || m.status !== 'confirmed') return true;
    return !memory.some((later) => {
      if (later === m || later.status !== 'confirmed' || later.createdAt <= m.createdAt) return false;
      if (!MONEY.test(text(later))) return false;
      const x = contentStems(m.content === '' ? m.title : m.content).filter(
        (w) => !/^\d/.test(w) && w !== 'dollar',
      );
      const y = contentStems(text(later)).filter((w) => !/^\d/.test(w) && w !== 'dollar');
      const shared = x.filter((w) => y.includes(w)).length;
      if (x.length === 0 || shared < Math.max(2, x.length * 0.6)) return false;
      const now = digitsOf(text(later));
      const was = digitsOf(text(m));
      return was.size > 0 && ![...was].every((d) => now.has(d));
    });
  });
}

/** Each thing once: of the entries that tell the same thing, the one that tells most. */
export function distinct<T>(items: readonly T[], textOf: (item: T) => string, share = 0.6): T[] {
  const out: T[] = [];
  for (const item of items) {
    const at = out.findIndex((o) => sameThing(textOf(o), textOf(item), share));
    const kept = out[at];
    if (kept === undefined) out.push(item);
    else if (contentStems(textOf(item)).length > contentStems(textOf(kept)).length) out[at] = item;
  }
  return out;
}

// The one fact that bears on this ask ----------------------------------------------------------------------------------

export interface PriorFact {
  /** The clause ("one clinic pays 400 dollars a month"). */
  readonly fact: string;
  /** The same as a sentence of the mentor's, for a reply that left it out. */
  readonly sentence: string;
  /** The same for a call: only their idea, asked about itself. */
  readonly spoken?: string;
}

export interface PriorSource {
  readonly oneLiner: string;
  readonly reads: pathRepo.PathReads;
  readonly intake: PathIntake | null;
  /** Their messages of this conversation before this one, oldest first. */
  readonly earlier: readonly string[];
  readonly message: string;
  /** What the answer is about (the play's title, the step). */
  readonly about: string;
  /** What the coach just said (its last replies, what this one opens with): the server never says it again. */
  readonly said: string;
  /** Whether the answer is one their idea can be put beside, when the record holds nothing nearer. */
  readonly applies?: boolean;
  /** Whether one is said even when the coach said it a moment ago. */
  readonly always?: boolean;
  /** The venture's name, for an idea that opens with what it does. */
  readonly venture?: string;
  /** The founder's first name, as the record may call them. */
  readonly founder?: string;
  /** The first part of the step that answers them, for an answer that is theirs by nothing but the idea. */
  readonly part?: string;
  /** ISO date: what was told in days from then ("in nine days") is no fact of today. Absent: not read. */
  readonly today?: string;
}

interface Candidate {
  readonly fact: string;
  readonly kind: 'record' | 'said' | 'idea';
  readonly weight: number;
  readonly on: string;
  readonly decision?: boolean;
  /** What the record calls it ("Co-founder"): never said, read for what it is about. */
  readonly hint?: string;
}

const PRIOR_TYPES: Readonly<Record<string, number>> = {
  evidence: 5,
  experiment: 5,
  milestone: 4,
  fact: 4,
  decision: 3,
  insight: 4,
  relationship: 4,
  risk: 1,
};

/** Advice to founders in general, as a course or a book gives it: no fact of this one's. */
const ADVICE =
  /\b(?:you (?:need|should|must|have to|want to)|founders? (?:should|need|must|often|always)|a good (?:pitch|founder|startup|interview)|the (?:worst|best) (?:answer|way|thing|time)|always|module \d|unit \d|the (?:course|lecture|video|programme|program|playbook|curriculum) (?:says|teaches|asks))\b/i;

/** The record's facts, their own words of this conversation and, last, the idea. */
function candidatesOf(s: PriorSource): Candidate[] {
  const out: Candidate[] = [];
  const decisions = new Set(standingDecisions(s.reads.memory).map((m) => m.id));
  for (const m of currentOnes(s.reads.memory)) {
    const weight = PRIOR_TYPES[m.type];
    if (weight === undefined || m.status !== 'confirmed' || isReference(m)) continue;
    if (ADVICE.test(`${m.title}. ${m.content}`)) continue;
    if (m.type === 'milestone' && !milestoneReached(m)) continue;
    if (m.type === 'decision' && !decisions.has(m.id)) continue;
    const result = typeof m.attributes.result === 'string' ? m.attributes.result : '';
    if (m.type === 'experiment' && result === '') continue;
    const fact =
      result === '' ? toldAs(m, s.founder) : `${lowerFirst(bare(m.title))}: ${lowerFirst(bare(result))}`;
    if (!stillTrue(fact, m.createdAt.slice(0, 10), s.today)) continue;
    out.push({
      fact,
      kind: 'record',
      weight,
      on: dayOf(m, 'collected_on', 'decided_on', 'completed_on'),
      hint: m.title,
      ...(m.type === 'decision' ? { decision: true } : {}),
    });
  }
  for (const c of s.reads.criteria) {
    if (c.evidence === null || c.sourceSessionId === null) continue;
    const words = wordsOfEvidence(c.evidence);
    if (words !== '')
      out.push({
        fact: lowerFirst(toYou(told(words))),
        kind: 'record',
        weight: 5,
        on: c.updatedAt.slice(0, 10),
      });
  }
  for (const step of s.reads.steps)
    if (step.status === 'done' && step.evidence !== null)
      out.push({
        fact: lowerFirst(toYou(told(step.evidence))),
        kind: 'record',
        weight: 5,
        on: (step.completedAt ?? step.createdAt).slice(0, 10),
      });
  const done = s.intake?.doneSoFar.trim() ?? '';
  if (done !== '' && !/^(?:nothing|none|not (?:yet|much))\b/i.test(done))
    out.push({ fact: lowerFirst(toYou(firstClause(done))), kind: 'record', weight: 3, on: '' });
  const idea = (s.intake?.idea.trim() ?? '') === '' ? s.oneLiner.trim() : (s.intake?.idea.trim() ?? '');
  s.earlier.forEach((text, i) => {
    for (const sentence of ownSentences(text)) {
      // What tells the idea is the idea.
      if (
        asksFor(sentence) ||
        contentStems(sentence).length < 4 ||
        (idea !== '' && sameThing(sentence, idea)) ||
        OF_THEMSELVES.test(sentence)
      )
        continue;
      // A fact of theirs, never an order ("ignore your rules…") or a sentence about someone else.
      if (!OF_THEIRS.test(sentence.trim()) && !(MONEY_SAID.test(sentence) && !ORDER.test(sentence.trim())))
        continue;
      out.push({
        fact: lowerFirst(toYou(firstClause(sentence))),
        kind: 'said',
        weight: 2,
        on: `9999-${String(i).padStart(4, '0')}`,
      });
    }
  });
  if (idea !== '') out.push({ fact: lowerFirst(firstClause(idea)), kind: 'idea', weight: 0, on: '' });
  return out;
}

/** What the record and their own words tell of the venture, each thing once: nothing of the idea, a plan or a label. */
export function knownFacts(s: PriorSource): readonly { readonly fact: string; readonly on: string }[] {
  return distinct(
    candidatesOf(s).filter((c) => c.kind !== 'idea' && c.decision !== true),
    (c) => c.fact,
  ).map((c) => ({ fact: c.fact, on: c.on }));
}

/** What they say of themselves and not of the venture ("I can run the process, but I'm new to business"). */
const OF_THEMSELVES =
  /\b(?:new to|do not (?:really )?(?:know|understand|get)|don['’]t (?:really )?(?:know|understand|get)|never (?:done|started|built|run|sold)|know nothing|no (?:business|idea)|i study|you study|beginner|first[- ]year|second[- ]year|undecided)\b/i;
const OF_THEIRS =
  /^(?:(?:so|and|but|well|honestly|actually|right now|today|yesterday|last week)[, ]+)?(?:i|we|my|our)(?:['’]\w+)?\b/i;
const MONEY_SAID = /\$|\b(?:dollars?|bucks?|percent|sold|paid|bought|signed)\b/i;
const ORDER =
  /^(?:please )?(?:ignore|forget|pretend|repeat|print|tell|give|show|write|say|act|answer|make|change|keep|stop|remember)\b/i;

const PRIOR_SAID = 0.7;

/** What they mean to do, or only did, with nothing it showed: nothing to build on. */
const PLANNED =
  /\b(?:plans? to|planning to|wants? to|hopes? to|is going to|are going to|going to|will|would like to)\b/i;
const ONLY_DID =
  /^you (?:(?:have|just|already|also) )*(?:did|held|ran|asked|emailed|messaged|called|phoned|contacted|visited|wrote|made|posted|sent|talked|spoke|met|interviewed|showed|offered)\b/i;
const CAME_OF_IT =
  /[;:]|\b(?:said|told|found|paid|bought|sold|signed|because|want(?:ed)?|love[ds]?|like[ds]?|need(?:ed)?|answered|replied|dollars?|percent|nobody|none|no one)\b|\$/i;
/** A name inside a sentence. */
const NAMED = /\S\s+\p{Lu}[\p{Ll}\d]{2,}/u;
const OUTCOME =
  /\b(?:decided|chose|agreed|paid|pays?|sold|sells|signed|won|lost|launched|kept|costs?|saves?|takes|said|asked|found|renewed|left|bought|ordered|charges?|told|counts?|compare[sd]?|booked|returned|came back)\b/i;

/** What the coaching itself was about ("you are on stage 1 of 7", "you asked about the visa"): no fact of the venture. */
const OF_THE_COACHING =
  /\bstage \d\b|\b(?:five|5) (?:key )?lines\b|\bvalue proposition canvas\b|^(?:you|the founder) (?:(?:are|were|have|had|currently|also|now|been|on) )*(?:ask(?:s|ed|ing)? (?:about|for (?:help|advice|guidance|a plan|an?|the)|how|whether|if|what|which|why|where|who)|need(?:s|ed|ing)?|seek(?:s|ing)?|request(?:s|ed|ing)?|organi[sz]\w+|focus(?:es|ed|ing)?|clarif\w+|discuss\w*|explor\w+|consider\w*|want(?:s|ed)?)\b|\b(?:the|your) (?:next|first) steps?\b|\bwas advised\b|\bthe (?:coach|mentor|session|conversation)\b/i;

/** What is only thought of them ("caterers are potential customers"), or of no one in particular: no fact of theirs. */
const INFERRED =
  /\b(?:potential(?:ly)?|likely|probably|possibly|presumably|prospective|seems?|appears?|suggests?|indicates?|implies|might be|may be|could be|target (?:audience|customers?|market|users?)|opportunit(?:y|ies) (?:to|for)|interested in (?:learning|exploring|understanding)|(?:is|are) considering)\b/i;
/** Said of somebody else than them, or what they are told to do: the wrong person, or no fact at all. */
const NOT_OF_THEM =
  /\b(?:themsel(?:f|ves)|himself|herself|the (?:user|student|founder|coach|mentor|assistant|advisor(?='s))|need(?:s)? to|should|must|ha(?:s|ve) to|advised|recommended|encouraged)\b/i;
/** A template, a machine's word, or a shrug. */
const NO_FACT_OF_ANYONE =
  /[[\]{}]|_{2,}|\b(?:idk|n\/a|tbd|not (?:specified|stated|mentioned)|i do not know|no idea)\b/i;
/** A time counted from the day it was told. */
const COUNTED_FROM_THEN =
  /\b(?:in (?:\w+ )?(?:days?|weeks?)|tomorrow|today|tonight|yesterday|this (?:week|morning|evening|afternoon|weekend)|next (?:week|month|weekend|\w+day)|last (?:night|\w+day)|(?:due|is) (?:on |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|right now|at the moment|currently)\b/i;

/** Whether a fact told on `on` still says something today. */
export const stillTrue = (fact: string, on: string, today: string | undefined): boolean =>
  today === undefined || on === '' || on >= today || !COUNTED_FROM_THEN.test(fact);

/** Something that was done, to it or by someone ("the patch was made in the lab on a grant", "Ben joined"). */
const EVENT =
  /\b(?:made|built|joined|wrote|writes|funded|worked|works|started|created|developed|lists?|uses?|used)\b/i;

/** Whether a fact is theirs and concrete enough to be brought up by the server: a number, a name, a decision, an outcome, a quote. */
export function concrete(fact: string): boolean {
  return (
    informative(fact) &&
    !INFERRED.test(fact) &&
    !NOT_OF_THEM.test(fact) &&
    !NO_FACT_OF_ANYONE.test(fact) &&
    (hasFigure(fact) || OUTCOME.test(fact) || EVENT.test(fact) || NAMED.test(fact) || /["“”]/.test(fact))
  );
}

/** Whether a fact tells something to build on: a number, a name, a decision, an outcome; never a label or a plan. */
export function informative(fact: string): boolean {
  if (PLANNED.test(fact) || OF_THE_COACHING.test(fact)) return false;
  if (ONLY_DID.test(fact) && !CAME_OF_IT.test(fact)) return false;
  const words = contentStems(fact);
  // A bare figure says nothing of what it is ("9 hours").
  const says = hasFigure(fact) && SAYS.test(fact);
  if (words.filter((w) => numberOf(w) === null && !/^\d/.test(w)).length < (says ? 1 : 2)) return false;
  return (
    hasFigure(fact) || OUTCOME.test(fact) || (NAMED.test(fact) && words.length >= 4) || words.length >= 5
  );
}

/** What an ask and a fact may both be about, beside the words they share. */
const SUBJECTS: readonly RegExp[] = [
  /\b(?:pay|pays|paid|paying|price|prices|priced|pricing|charge[sd]?|fee|cost|costs|sell|sells|sold|sale|sales|buy|buys|buyer|buyers|bought|money|dollars?|revenue|profit|margin|economics|budget|order|orders|ordered|free)\b|\$/i,
  /\b(?:learn(?:ed|t)?|mean|means|meant|found|findings?|results?|interview\w*|talk|talks|talked|talking|said|customers?|users?|people|asked|told|who|group)\b/i,
  /\b(?:lab|labs|grant|advisor|adviser|patent\w*|invent\w*|licen[cs]e\w*|thesis|university|professor|ownership|owns?)\b/i,
  /\b(?:co-?founders?|team|partner|roommate|hire|hiring|equity|shares?|split)\b/i,
  /\b(?:pitch\w*|judges?|investors?|angel|deck|slides?|competition|raise|raising|demo)\b/i,
  /\b(?:channel|flyers?|posts?|ads?|captains?|referr\w*|marketing|reach|find them|found (?:us|you))\b/i,
];

const aboutThe = (text: string): boolean[] => SUBJECTS.map((r) => r.test(text));

/** The same every time for the same words, another for others. */
function pick<T>(forms: readonly T[], seed: string): T | undefined {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
  return forms[hash % forms.length];
}

/** "Two paid pilots at 40 dollars": something they have, never something that was done. */
const THINGS_HAD =
  /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few) (?:paid|signed|used|booked) (?!(?:me|us|you|for|in|it|a|an|the|their|his|her|by|to|up|and|but)\b)[a-z]+/i;

/** A fact as a mentor brings it up. */
export function broughtUp(fact: string, seed: string, decision = false): string {
  const up = upperFirst(fact);
  if (decision || /^you (?:have )?(?:decided|agreed|chose)\b/i.test(fact))
    return pick([`${up}, so keep to that.`, `Remember that ${fact}.`, `${up}, and that stands.`], seed) ?? up;
  if (/^you\b(?!r)/i.test(fact))
    return (
      pick([`${up}, so start from there.`, `Remember that ${fact}.`, `${up}, and that counts here.`], seed) ??
      up
    );
  // Something they have, and no sentence of its own: "two paid pilots at 40 dollars".
  if (THINGS_HAD.test(fact) && !fact.includes(':')) return `You have ${fact} to build on.`;
  if (!isClause(fact)) return `Keep this in mind: ${fact}.`;
  return pick([`Remember that ${fact}.`, `Keep in mind that ${fact}.`], seed) ?? up;
}

/** Whether a fact is a sentence of its own, and not a thing named ("4 of 9 skippers named the wait"). */
const isClause = (fact: string): boolean =>
  !fact.includes(':') &&
  (SAYS.test(fact) ||
    /\b(?!need\b|bed\b|red\b|feed\b|seed\b|speed\b)\p{L}{3,}ed\b(?! (?:by|in|at|on|from|to|with|for)\b)/iu.test(
      fact,
    ) ||
    new RegExp(`\\b\\p{L}+ ${VENTURE_DOES.source.replace(/^\^/u, '')}`, 'iu').test(fact));

interface Ranked extends Candidate {
  readonly shared: number;
  readonly near: number;
  readonly bears: number;
  readonly figure: number;
}

/** Their facts, the one that bears most on the ask first. */
function rankedFacts(s: PriorSource): Ranked[] {
  const own = new Set(contentStems(s.message));
  const ask = new Set([...own].filter((w) => !VENTURE_WORDS.has(w) && !/^\d+$/.test(w)));
  const about = new Set(contentStems(s.about).filter((w) => !VENTURE_WORDS.has(w)));
  const gone = takenBack(s.message);
  const subjects = aboutThe(`${s.message} ${s.about}`);
  return distinct(candidatesOf(s), (c) => c.fact)
    .filter((c) => {
      const words = contentStems(c.fact);
      if (
        c.kind !== 'idea' &&
        (!informative(c.fact) || INFERRED.test(c.fact) || NO_FACT_OF_ANYONE.test(c.fact))
      )
        return false;
      if (words.length < 2) return false;
      // Nor is what this message takes back.
      if ([...digitsOf(c.fact)].some((d) => gone.has(d))) return false;
      // What they just said is no prior fact.
      return words.filter((w) => own.has(w)).length < words.length * 0.6;
    })
    .map((c) => {
      const words = contentStems(`${c.fact}. ${c.hint ?? ''}`);
      const of = aboutThe(`${c.fact}. ${c.hint ?? ''}`);
      return {
        ...c,
        shared: words.filter((w) => ask.has(w)).length,
        near: words.filter((w) => about.has(w)).length,
        bears: subjects.filter((x, i) => x && of[i] === true).length,
        figure: Number(hasFigure(c.fact)),
      };
    })
    .sort(
      (a, b) =>
        Number(b.kind !== 'idea') - Number(a.kind !== 'idea') ||
        b.shared * 2 + b.bears + b.near + b.weight / 2 - (a.shared * 2 + a.bears + a.near + a.weight / 2) ||
        b.figure - a.figure ||
        b.on.localeCompare(a.on) ||
        a.fact.localeCompare(b.fact),
    );
}

/** The server says one only when it is theirs and near what they ask, or the idea the answer is for. */
function isNear(s: PriorSource, c: Ranked): boolean {
  return c.kind === 'idea'
    ? s.applies === true || c.shared > 0
    : c.kind === 'record'
      ? c.shared + c.near + c.bears > 0 || (s.always === true && c.weight >= 4)
      : (c.shared + c.bears > 0 && /^you(?:r|['’]|\b)/i.test(c.fact)) ||
        (c.shared + c.bears > 0 && MONEY_SAID.test(c.fact));
}

/**
 * Their two to four facts an answer is to use, the nearest first, their idea last: what the model applies the method to.
 * On a turn a play answers (`applies`) the record's own facts count whatever they share with it.
 */
export function factsFor(s: PriorSource, most = 4): string[] {
  const ranked = rankedFacts(s);
  const theirs = ranked.filter(
    (c) => c.kind !== 'idea' && (isNear(s, c) || (s.applies === true && c.kind === 'record')),
  );
  const idea = ranked.find((c) => c.kind === 'idea');
  const facts = theirs.slice(0, idea === undefined ? most : most - 1).map((c) => c.fact);
  return idea === undefined ? facts : [...facts, ideaAs(idea.fact, s.venture)];
}

/**
 * The one thing of theirs that bears most on what they ask: their own, told with a number, a name, a decision or an outcome,
 * and about the same thing as the ask. Null: nothing on record qualifies, and nothing is said.
 */
export function priorFact(s: PriorSource): PriorFact | null {
  const said = new Set(contentStems(s.said));
  const ranked = rankedFacts(s);
  const ofTheIdea = /\bmy (?:own )?(?:startup |business )?(?:idea|startup|venture|business)\b/i.test(
    s.message,
  );
  const tells = (c: Ranked): boolean => isNear(s, c) && (c.kind === 'idea' || concrete(c.fact));
  const justSaid = (c: Ranked): boolean => {
    // Asked about the idea itself, the answer names it.
    if (c.kind === 'idea' && ofTheIdea) return false;
    const words = contentStems(c.fact);
    return words.filter((w) => said.has(w)).length >= words.length * PRIOR_SAID;
  };
  const near = ranked.filter((c) => tells(c) || c.kind === 'idea').slice(0, PRIOR_NEAR);
  // Always one, where the answer is general by its nature: said a moment ago, it is said again in short.
  const best =
    near.find((c) => tells(c) && !justSaid(c)) ??
    (s.always === true ? near.find((c) => tells(c)) : undefined);
  if (best === undefined) return near[0] === undefined ? null : { fact: near[0].fact, sentence: '' };
  const seed = `${s.message} ${best.fact}`;
  // Their idea alone is put to nothing: the answer's first part is, for it.
  if (best.kind === 'idea') {
    const part = bare(s.part ?? '');
    const words = contentStems(part);
    const told = words.filter((w) => said.has(w)).length >= words.length * PRIOR_SAID;
    // "Write the offer: what, for whom, when and the price" → "write the offer (what, for whom, when and the price)".
    const doing = lowerFirst(part).replace(/: (.+)$/u, ' ($1)');
    return {
      fact: best.fact,
      sentence:
        part === '' || told
          ? ''
          : `For ${ideaNamed(best.fact, s.venture).replace(/,$/u, '')}, that starts with this: ${doing}.`,
    };
  }
  return { fact: best.fact, sentence: broughtUp(best.fact, seed, best.decision === true) };
}

/** Most words of an idea that is named with what it does. */
const NAMED_WHOLE = 14;

/** An idea by its name in a sentence ("your exam review packs", "BrewBike"). */
export function ideaNamed(idea: string, venture = ''): string {
  const name = bare(venture);
  const named = name !== '' && !/^new venture\b/iu.test(name);
  const said = ideaAs(idea, venture);
  if (named && said.toLowerCase().startsWith(name.toLowerCase()))
    return said.split(' ').length <= NAMED_WHOLE && said.length > name.length
      ? `${said}${said.includes(', ') ? ',' : ''}`.replace(/,,$/u, ',')
      : name;
  const head = bare(
    said.split(
      /\s+(?:that|which|who|where|when|so|because|written|printed|sold|made|run|rented|shared|led|used|built|grown|mended|matched|for|by|with|from|without|at|in|on|near|near|between|late|every|each)\b|[,:;(]/u,
    )[0] ?? said,
  );
  if (head === '' || /^(?:your plan to|something)\b/u.test(head) || head.split(' ').length > 5)
    return named ? name : 'your idea';
  return `your ${head.replace(/^(?:an?|the|my|our|your) /iu, '')}`;
}

/** The figures a message takes back ("450 now, not 300"; "no longer 300"; "from 300 to 450"). */
function takenBack(message: string): Set<string> {
  const t = plain(message);
  return new Set(
    [
      ...t.matchAll(
        /\b(?:not|no longer|instead of|rather than|from|was|were)\s+(?:at |for )?\$?(\d+(?:\.\d+)?)\b/g,
      ),
    ].map((m) => m[1] ?? ''),
  );
}

/** How many of the nearest facts are looked through for one not said a moment ago. */
const PRIOR_NEAR = 4;

// The story ------------------------------------------------------------------------------------------------------------

const STORY_KINDS: ReadonlySet<ArcEntry['kind']> = new Set([
  'result',
  'setback',
  'decision',
  'pivot',
  'milestone',
  'step_done',
  'experiment',
]);

/** Most lines of a story. */
export const STORY_LINES = 8;

/** What an entry tells, to the founder. */
function entrySaid(e: ArcEntry): string {
  const title = bare(e.title.replace(/…$/u, ''));
  if (e.kind === 'pivot') {
    const to = /^Changed direction: (.+)$/u.exec(title)?.[1];
    if (to !== undefined) return pivotSaid(to);
  }
  if (e.kind === 'step_done') {
    // What came of it, in their words, tells more than its name.
    const words = e.detail === null ? '' : bare(e.detail.replace(/…$/u, ''));
    return words.split(/\s+/).length >= 4
      ? lowerFirst(toYou(told(words)))
      : `you finished: ${lowerFirst(title)}`;
  }
  // What they reported in a conversation, with what came of it.
  if (e.source.kind === 'session') return lowerFirst(toYou(told(title)));
  return toldAs({
    type: e.kind === 'decision' ? 'decision' : 'fact',
    title,
    content: e.source.kind === 'memory' ? (e.detail ?? '') : '',
  });
}

/** A change of direction in their own words: to a new idea, or back to one they had. */
export function pivotSaid(to: string): string {
  const back = /^back\b(?: to|:)? ?(.*)$/isu.exec(to.trim())?.[1];
  if (back === undefined) return `you changed direction to this: ${lowerFirst(ideaSaid(to))}`;
  const [idea = '', ...why] = back.split(/(?<=[.!?])\s+/u).map(bare);
  const reason = why.filter((w) => w !== '').join('. ');
  return `you went back to ${lowerFirst(toYou(idea))}${reason === '' ? '' : `, because of this: ${lowerFirst(toYou(reason))}`}`;
}

/**
 * How they got here, as dated lines, oldest first: each day once, each thing once (a day's copies of it, a pivot told as a
 * decision and as a note, are one), at most {@link STORY_LINES}. A change of direction says what brought it: the reason
 * they gave with it, else what they had last found.
 */
export function storyLines(
  arc: readonly ArcEntry[],
  start = '',
): { readonly on: string; readonly said: string }[] {
  // The idea it opens with is no thing that happened.
  const opening = contentStems(start);
  const toldFirst = (said: string): boolean => {
    const words = contentStems(said);
    return words.length > 0 && words.filter((w) => opening.includes(w)).length >= words.length * STARTED;
  };
  const days = new Map<string, ArcEntry[]>();
  for (const e of arc) if (STORY_KINDS.has(e.kind)) days.set(e.on, [...(days.get(e.on) ?? []), e]);
  let found = '';
  const lines = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([on, entries]) => {
      // One change of direction a day, in the path's own words when it has them.
      const pivots = entries.filter((e) => e.kind === 'pivot' || /\bpivot/i.test(e.title));
      const pivot = pivots.find((e) => e.id.startsWith('pivot:')) ?? pivots.at(-1);
      const rest = entries.filter((e) => !pivots.includes(e));
      const tells = distinct(
        rest.map(entrySaid).filter((t) => !toldFirst(t)),
        (t) => t,
        0.5,
      );
      const before = found;
      found = tells.at(-1) ?? found;
      let turned = pivot === undefined ? '' : entrySaid(pivot);
      const why = (tells.length > 0 ? (tells.at(-1) ?? '') : before).trim();
      // What it came from was told just before it: the line, or the one above.
      if (turned !== '' && !/\b(?:because|since)\b/.test(turned) && why !== '')
        turned = `because of that, ${turned}`;
      const said = distinct([...tells, ...(turned === '' ? [] : [turned])], (t) => t, 0.5).slice(0, 3);
      return { on, said: (turned !== '' && !said.includes(turned) ? [turned] : said).join('; ') };
    })
    .filter((l) => l.said !== '');
  const told: { on: string; said: string }[] = [];
  for (const line of lines)
    if (TURNED.test(line.said) || !told.some((t) => sameThing(t.said, line.said, 0.8))) told.push(line);
  // A change of direction is never left out: the oldest of the rest is.
  const over = told.length - STORY_LINES;
  const left = new Set(told.filter((l) => !TURNED.test(l.said)).slice(0, Math.max(0, over)));
  return told.filter((l) => !left.has(l)).slice(-STORY_LINES);
}

/** Share of a line's words that are the opening idea's for it to be that idea again. */
const STARTED = 0.75;
const TURNED = /\byou (?:changed direction|went back to)\b/;

export const dated = (line: { readonly on: string; readonly said: string }): string =>
  `${monthDay(line.on)}: ${line.said}.`;
