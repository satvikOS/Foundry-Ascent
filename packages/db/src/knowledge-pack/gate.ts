/**
 * The reference library's relevance gate: which items of the startup knowledge base (if any) a founder's message
 * is about. It reads the founder's OWN message only, never the composed retrieval query (the vEIR's last question
 * and the venture goal are the coach's words, not a request for a reference).
 *
 * The coaching diagnosis (C1) traced fixation to library notes injected on almost every turn whatever was asked.
 * An earlier gate called a word distinctive when few of the library's ~99 passages had it; inside so small a
 * library everyday words ("could", "work") qualified, and replaying a pilot's real student turns retrieved a
 * passage on 22 % of them. Here an item is named only by its own curated vocabulary (`vocabulary.ts`), and:
 *
 * - **Everyday English never names anything.** A one-word term is never among the 10,000 most frequent English
 *   words (`knowledge/common-english`, wordfreq, CC BY-SA 4.0); a common word only counts inside a phrase ("market
 *   size"), or paired with a cue in the same sentence ("scaling" with "mentor").
 * - **A framework or stage only when the founder asks about it.** Its term must be in a sentence that asks or
 *   requests something ("What's a good CAC?", "explain the lean canvas"), so a status report that mentions a term in
 *   passing ("We did five customer interviews.") retrieves nothing.
 * - **A case by its company's full name** (or a short form that is not everyday English), case-insensitive, as
 *   whole words, in an entrepreneurship context. A company whose name is everyday English or an everyday product
 *   needs a word that shows the company is meant within six words of the name in its sentence, or a case frame in
 *   its own clause ("Grove Street has cheaper rent" and "the deck is on Dropbox" retrieve nothing; "How did Dropbox
 *   grow?" and "the Dropbox referral program" do). A short one-word name ("NONA", "Locu") needs a business word
 *   beside it or a case frame, not just any question ("Is my nona coming?" retrieves nothing).
 * - **A case's subject** ("home try-on") counts only in a sentence that genuinely asks for an example, a case or a
 *   company's story ("any examples of startups that…", "a case study", "which companies have…"), within ten words
 *   of that ask, and never on an idiom ("in that case", "for example", "companies like ours", "use cases").
 * - **A question about the program itself** (its curriculum, stage gates, cohort, EIRs) is answered from the
 *   program's own guidance: no reference item.
 * - **One item per turn**, the strongest match, unless the founder explicitly asks for several (examples, cases,
 *   frameworks, a comparison; an idiom such as "in some cases" is not asking) or names several library subjects
 *   themselves; then at most `limit`. A subject asked for as an example does not count as naming one.
 *
 * The database side (`retrieval.ts`) adds what needs the database: the vector floor (a passage whose embedding is
 * far from the query is vetoed; similarity never admits one), and never an item already cited in the conversation.
 */
import commonEnglish from '../../knowledge/common-english/common_english_10000.json' with { type: 'json' };
import { PACK_URI_PREFIX } from './render.js';
import { type ItemVocabulary, REFERENCE_VOCABULARY } from './vocabulary.js';

const COMMON: ReadonlySet<string> = new Set(commonEnglish);

/** Whether `word` (lowercase) is among the 10,000 most frequent English words. */
export function isCommonEnglish(word: string): boolean {
  return COMMON.has(word.toLowerCase());
}

/** Longest founder message read (a pasted document is not a question about a framework). */
const MAX_CHARS = 4_000;

/** Lowercase words of `text` (letters and digits), possessive "'s" dropped, hyphens and slashes split. */
export function gateTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/'s\b/g, '')
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w !== '');
}

/** Sentences of `text` (a call's transcript is often one). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const QUESTION_START =
  /^(?:what|whats|what's|how|why|when|where|which|who|whom|should|shall|can|could|would|will|is|are|am|do|does|did|was|were|have|has|any|anything)\b/;
const REQUEST =
  /\b(?:explain|tell me|walk me through|show me|teach me|help me (?:understand|think|figure|work out|calculate|estimate|apply|use|choose|decide|size|map|build|fill|run|plan)|give me|i(?:'d| would) like to (?:know|understand|learn)|i want to (?:know|understand|learn)|i(?:'m| am) (?:wondering|curious|confused|not sure)|how (?:do|does|did|should|can|could|would|to)|what (?:is|are|was|does|did)|is it (?:worth|better|ok|okay|normal)|(?:can|could) you|please)\b/;

/** Whether `sentence` asks or requests something. */
export function asks(sentence: string): boolean {
  const s = sentence.trim().toLowerCase().replace(/[’‘]/g, "'");
  return s.includes('?') || QUESTION_START.test(s) || REQUEST.test(s);
}

/**
 * Everyday idioms that use "case", "example" or "companies" without asking for one ("in that case", "for example",
 * "companies like ours", "the business case", "use cases"). They are removed before looking for an ask.
 */
const IDIOMS =
  /\b(?:(?:just )?in case|(?:in|for) (?:that|this|any|which|either|each|every|such|my|our|your|their|his|her|its|the|most|some|many|few|those|these|all|both|no|other|rare|extreme|certain) cases?|case by case|(?:for|as an?) (?:example|instance)|(?:lead|leading|led|set|setting) (?:an? |the |by )?example|follow (?:the |their |his |her |that |this )?example|(?:companies|startups|businesses|people|founders) like (?:ours|us|mine|me|yours|you|theirs|them|this|that)|(?:business|use|edge|test|worst|best|base|phone|court|legal) cases?|(?:make|makes|making|made|build|building|built) (?:an? |the |my |our |a strong |a good |a better )?case|(?:is|was|be|been|not|isn't|wasn't) (?:it |that |this |always |really |actually |still )?the case|the case (?:that|for|against|with))\b/g;

const DETERMINER =
  '(?:an?|any|some|one|other|another|more|real|good|concrete|specific|famous|known|well known|similar|successful|documented|actual|startup|company|business|real[- ]world|real[- ]life|two|three|a few|few)';
/**
 * A genuine ask for an example, a case or a company or startup story ("any examples of startups that…", "a case
 * study", "which companies have…", "show me a real case", "has anyone done…"). Read only after the idioms are
 * removed, and only in a sentence that asks; a case's subject must then be near it (`EXAMPLE_REACH`).
 */
const EXAMPLE_ASKS: readonly RegExp[] = [
  /\bexamples? (?:of|where|in which|like|from)\b/g,
  new RegExp(`\\b${DETERMINER}(?: ${DETERMINER}){0,2} examples?\\b`, 'g'),
  /\b(?:show|give|tell|send|share with) (?:me|us) (?:an? |some |one |two |three |a few |more )?(?:real |good |concrete |actual )?(?:examples?|cases?|stor(?:y|ies))\b/g,
  /\bcase stud(?:y|ies)\b/g,
  new RegExp(
    `\\b${DETERMINER}(?: ${DETERMINER}){0,2} cases? (?:of|where|in which|like|that|about|from)\\b`,
    'g',
  ),
  /\b(?:startup|company|founder|founding|success|failure|real|true) stor(?:y|ies)\b/g,
  /\bstories (?:of|about|from) (?:startups?|companies|founders|businesses)\b/g,
  /\b(?:which|what) (?:other |real |successful |existing )?(?:companies|startups|businesses|company|startup|business|founders)\b (?:have|has|had|did|do|does|are|were|tried|used|went|built|solved|started|succeeded|failed|managed|got|made|launched|pulled)\b/g,
  /\b(?:are there|is there|were there|was there|do you know(?: of)?|know of|know any|can you name|name|any|did any|has any|have any) (?:an? |any |other |some |real |successful |existing )?(?:companies|startups|businesses|company|startup|business|founders?)\b(?! (?:model|models|plan|plans|idea|ideas|card|cards|name|names|owner|owners|license|licence|account|accounts|school|class|email|partner|partners|loan|loans|hours|insurance|address|bank|registration|tax|taxes|expense|expenses|trip|meeting|meetings|lunch|dinner|event|events|course|degree|major|advice|tips|questions|question|stuff|thing|things)\b)/g,
  /\b(?:a|another|one) (?:company|startup|business) (?:that|who|which)\b/g,
  /\bhas anyone (?:ever |else )?(?:done|tried|built|made|started|used|solved|pulled off|launched|succeeded|figured out|cracked)\b/g,
  /\banyone (?:who|that) (?:has|have|did|tried|built|started|made|launched|solved)\b/g,
  /\b(?:any|a|some) precedents?\b/g,
];

/** Furthest a case's subject may be from the ask, in words ("any examples of startups that did home try-on"). */
const EXAMPLE_REACH = 10;

/** `sentence` lowercased as `gateTokens` reads it, with the everyday idioms removed. */
function withoutIdioms(sentence: string): string {
  return sentence
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/-/g, ' ')
    .replace(IDIOMS, ' ; ');
}

/** Word spans [start, end) of the genuine asks for an example in `text` (already `withoutIdioms`). */
function exampleAskSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const pattern of EXAMPLE_ASKS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const start = gateTokens(text.slice(0, m.index)).length;
      spans.push([start, start + gateTokens(m[0]).length]);
      if (m[0] === '') pattern.lastIndex += 1;
    }
  }
  return spans;
}

/** Words between two spans [start, end) (0 when they touch or overlap). */
function gap(a: readonly [number, number], b: readonly [number, number]): number {
  if (a[1] <= b[0]) return b[0] - a[1];
  if (b[1] <= a[0]) return a[0] - b[1];
  return 0;
}

/** The founder explicitly asks for several (examples, cases, frameworks, a comparison); read without the idioms. */
const SEVERAL =
  /\b(?:examples|cases|case studies|frameworks|compare|comparing|comparison|difference between|versus|vs)\b/;

/** How near a cue must stand to an everyday company name, in words of the same sentence ("the Dropbox referral program"). */
const CUE_REACH = 6;

/** A one-word company name this short ("NONA", "Locu", "r2c") needs a business word or a case frame beside it. */
const SHORT_NAME = 5;

/** Words of a message about the program itself (its name, curriculum, gates, EIRs). */
const PROGRAM_TOKENS = new Set(['ain', 'foundry', 'cohort', 'curriculum', 'handbook', 'eir', 'eirs']);
const PROGRAM_PHRASES = [
  ['stage', 'gate'],
  ['stage', 'gates'],
];

/** Words that place a company name in an entrepreneurship context anywhere in the message. */
const CONTEXT_TOKENS = new Set(
  (
    'startup startups company companies case cases founder founders founded business businesses venture ventures ' +
    'brand product products customer customers user users market markets launch launched grow grew growth scale ' +
    'scaled scaling raise raised funding investors pivot pivoted revenue pricing model strategy example examples ' +
    'lesson lessons learn learned story approach competitor competitors sell sold sales'
  ).split(' '),
);

/** Words right after an everyday company name that show the company is meant ("Dropbox grew", "the Grove case"). */
const FRAME_AFTER = new Set(
  (
    'case story example founders founder grew growth started launched pivoted scaled raised did succeeded failed ' +
    'approach strategy startup company handled solved'
  ).split(' '),
);
/**
 * Phrases right before an everyday company name that show the company's history is meant ("how did Dropbox").
 * Present-tense frames ("what does Dropbox charge", "something like Duolingo") are about the product, not the case.
 */
const FRAME_BEFORE = [
  ['how', 'did'],
  ['what', 'did'],
  ['why', 'did'],
  ['when', 'did'],
  ['tell', 'me', 'about'],
  ['learn', 'from'],
  ['learned', 'from'],
  ['lessons', 'from'],
  ['case', 'of'],
  ['happened', 'with'],
  ['happened', 'to'],
  ['company'],
  ['startup'],
];

export interface ReferenceMatch {
  /** Item key (`framework/F07`, `case/SC01`, `stage/growth`). */
  readonly key: string;
  /** `knowledge_sources.uri` of the item. */
  readonly uri: string;
  /** 3 a case by name, 2 a framework or stage term, 1.5 a paired term, 1 a case topic asked as an example. */
  readonly strength: number;
  /** What matched (for tests and logs; the founder's words, lowercased). */
  readonly matched: readonly string[];
}

export interface ReferenceSelection {
  /** At most one, or `limit` when several were asked for; strongest first. */
  readonly matches: readonly ReferenceMatch[];
  /** Why nothing or several: `program` (a question about the program), `several` (asked for or named several). */
  readonly reason: 'none' | 'program' | 'one' | 'several';
}

interface Compiled {
  readonly key: string;
  readonly kind: 'framework' | 'case' | 'stage';
  readonly vocab: ItemVocabulary;
  readonly terms: readonly (readonly string[])[];
  readonly acronyms: readonly RegExp[];
  readonly paired: readonly { terms: readonly (readonly string[])[]; cues: readonly (readonly string[])[] }[];
  readonly names: readonly (readonly string[])[];
  readonly nameCues: readonly (readonly string[])[];
  readonly topics: readonly (readonly string[])[];
}

function phrase(text: string): string[] {
  return gateTokens(text);
}

function compile(key: string, vocab: ItemVocabulary): Compiled {
  const kind = key.split('/')[0] as Compiled['kind'];
  const strict = new Set(vocab.caseSensitive ?? []);
  return {
    key,
    kind,
    vocab,
    terms: (vocab.terms ?? []).map(phrase),
    acronyms: (vocab.acronyms ?? []).map(
      (a) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${a}s?(?![\\p{L}\\p{N}])`,
          strict.has(a) || isCommonEnglish(a) ? 'u' : 'iu',
        ),
    ),
    paired: (vocab.paired ?? []).map((p) => ({ terms: p.terms.map(phrase), cues: p.cues.map(phrase) })),
    names: (vocab.names ?? []).map(phrase),
    nameCues: (vocab.nameCues ?? []).map(phrase),
    topics: (vocab.topics ?? []).map(phrase),
  };
}

const COMPILED: readonly Compiled[] = Object.entries(REFERENCE_VOCABULARY).map(([key, vocab]) =>
  compile(key, vocab),
);

/** Positions where `words` occurs in `tokens` as whole words (the last word may be a plural). */
function occurrences(tokens: readonly string[], words: readonly string[]): number[] {
  const out: number[] = [];
  if (words.length === 0) return out;
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < words.length; j += 1) {
      const t = tokens[i + j];
      const w = words[j];
      const last = j === words.length - 1 && words.length > 1;
      if (!(t === w || (last && (t === `${w}s` || t === `${w}es`)))) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function has(tokens: readonly string[], words: readonly string[]): boolean {
  return occurrences(tokens, words).length > 0;
}

function startsAt(tokens: readonly string[], at: number, words: readonly string[]): boolean {
  return words.every((w, j) => tokens[at + j] === w);
}

/** Whether an everyday company name at `at` (of `length` words) is framed as the company. */
function framed(tokens: readonly string[], at: number, length: number): boolean {
  const after = tokens[at + length];
  if (after !== undefined && FRAME_AFTER.has(after)) return true;
  return FRAME_BEFORE.some((before) => at >= before.length && startsAt(tokens, at - before.length, before));
}

interface Hit {
  readonly key: string;
  readonly strength: number;
  readonly matched: string;
  /** Matched by the item's own name or term (not a topic asked as an example). */
  readonly named: boolean;
}

/** Whether a cue stands within `CUE_REACH` words of the name at `at` in `tokens` (one sentence). */
function cueBeside(c: Compiled, tokens: readonly string[], at: number, length: number): boolean {
  const name: [number, number] = [at, at + length];
  return c.nameCues.some((cue) =>
    occurrences(tokens, cue).some((start) => gap(name, [start, start + cue.length]) <= CUE_REACH),
  );
}

/** Whether a word placing a company in an entrepreneurship context stands within `CUE_REACH` words of the name. */
function contextBeside(tokens: readonly string[], at: number, length: number): boolean {
  for (let i = Math.max(0, at - CUE_REACH); i < Math.min(tokens.length, at + length + CUE_REACH); i += 1) {
    if ((i < at || i >= at + length) && CONTEXT_TOKENS.has(tokens[i] ?? '')) return true;
  }
  return false;
}

function caseHits(
  c: Compiled,
  all: readonly string[],
  parts: readonly string[],
  clauses: readonly (readonly string[])[],
): Hit[] {
  const hits: Hit[] = [];
  const context = all.some((t) => CONTEXT_TOKENS.has(t)) || parts.some(asks);
  const sentenceTokens = parts.map(gateTokens);
  const inFrame = (name: readonly string[]) =>
    clauses.some((clause) => occurrences(clause, name).some((at) => framed(clause, at, name.length)));
  for (const name of c.names) {
    if (!has(all, name)) continue;
    const short = name.length === 1 && (name[0]?.length ?? 0) <= SHORT_NAME;
    let ok: boolean;
    if (c.vocab.everyday) {
      // An everyday name needs a cue beside it in its sentence, or a case frame inside its own clause ("in Dropbox,
      // does the layout…" is not "Dropbox does").
      ok =
        sentenceTokens.some((tokens) =>
          occurrences(tokens, name).some((at) => cueBeside(c, tokens, at, name.length)),
        ) || inFrame(name);
    } else if (short) {
      // A short name ("my nona is coming") needs a business word beside it or a case frame, not just any question.
      ok =
        sentenceTokens.some((tokens) =>
          occurrences(tokens, name).some((at) => contextBeside(tokens, at, name.length)),
        ) || inFrame(name);
    } else {
      ok = context;
    }
    if (ok) hits.push({ key: c.key, strength: 3, matched: name.join(' '), named: true });
  }
  for (const sentence of parts) {
    if (!asks(sentence)) continue;
    // A case's subject counts only near a genuine ask for an example ("any examples of startups that did home
    // try-on"), never on an idiom ("in that case", "for example", "companies like ours").
    const text = withoutIdioms(sentence);
    const spans = exampleAskSpans(text);
    if (spans.length === 0) continue;
    const tokens = gateTokens(text);
    for (const topic of c.topics) {
      const near = occurrences(tokens, topic).some((start) =>
        spans.some((span) => gap(span, [start, start + topic.length]) <= EXAMPLE_REACH),
      );
      if (near) hits.push({ key: c.key, strength: 1, matched: topic.join(' '), named: false });
    }
  }
  return hits;
}

function subjectHits(c: Compiled, parts: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const sentence of parts) {
    if (!asks(sentence)) continue;
    const tokens = gateTokens(sentence);
    for (const term of c.terms) {
      if (has(tokens, term)) {
        hits.push({ key: c.key, strength: 2 + term.length / 100, matched: term.join(' '), named: true });
      }
    }
    for (const acronym of c.acronyms) {
      const m = acronym.exec(sentence);
      if (m) hits.push({ key: c.key, strength: 2, matched: m[0].toLowerCase(), named: true });
    }
    for (const pair of c.paired) {
      const term = pair.terms.find((t) => has(tokens, t));
      if (term !== undefined && pair.cues.some((cue) => has(tokens, cue))) {
        hits.push({ key: c.key, strength: 1.5, matched: term.join(' '), named: true });
      }
    }
  }
  return hits;
}

/** Drops a hit whose words are part of a longer hit of another item ("MVP" inside "MVP stage"). */
function withoutContained(hits: readonly Hit[]): Hit[] {
  return hits.filter(
    (h) =>
      !hits.some(
        (o) =>
          o.key !== h.key &&
          o.matched.length > h.matched.length &&
          has(o.matched.split(' '), h.matched.split(' ')),
      ),
  );
}

/**
 * The reference items `founderText` (the founder's own message, nothing else) is about: at most one, or up to
 * `limit` when the founder asks for several or names several library subjects themselves.
 */
export function selectReferences(
  founderText: string,
  options: { readonly limit: number },
): ReferenceSelection {
  const text = founderText.slice(0, MAX_CHARS);
  const all = gateTokens(text);
  if (options.limit <= 0 || all.length === 0) return { matches: [], reason: 'none' };
  if (all.some((t) => PROGRAM_TOKENS.has(t)) || PROGRAM_PHRASES.some((p) => has(all, p))) {
    return { matches: [], reason: 'program' };
  }
  const parts = sentences(text);
  const clauses = text
    .split(/[,;:.!?()\n]+/)
    .map(gateTokens)
    .filter((c) => c.length > 0);
  const hits = withoutContained(
    COMPILED.flatMap((c) => (c.kind === 'case' ? caseHits(c, all, parts, clauses) : subjectHits(c, parts))),
  );
  const byKey = new Map<string, { strength: number; matched: Set<string>; named: boolean; order: number }>();
  for (const h of hits) {
    const entry = byKey.get(h.key) ?? {
      strength: 0,
      matched: new Set<string>(),
      named: false,
      order: COMPILED.findIndex((c) => c.key === h.key),
    };
    entry.strength = Math.max(entry.strength, h.strength);
    entry.matched.add(h.matched);
    entry.named ||= h.named;
    byKey.set(h.key, entry);
  }
  const ranked = [...byKey.entries()]
    .map(([key, e]) => ({ key, ...e, score: e.strength + 0.01 * e.matched.size }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (ranked.length === 0) return { matches: [], reason: 'none' };
  const several =
    parts.some((sentence) => SEVERAL.test(withoutIdioms(sentence))) ||
    ranked.filter((r) => r.named).length >= 2
      ? options.limit
      : 1;
  const matches = ranked.slice(0, Math.min(several, options.limit)).map((r) => ({
    key: r.key,
    uri: `${PACK_URI_PREFIX}${r.key}`,
    strength: r.strength,
    matched: [...r.matched],
  }));
  return { matches, reason: matches.length > 1 ? 'several' : 'one' };
}

/** Every item key the vocabulary covers (tests compare it with the pack's items). */
export function vocabularyKeys(): string[] {
  return COMPILED.map((c) => c.key);
}
