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
 *   needs a word that shows the company is meant ("Grove Street has cheaper rent" and "the deck is on Dropbox"
 *   retrieve nothing; "How did Dropbox grow?" does). A case's subject ("home try-on") counts only when the founder
 *   asks for an example or a case.
 * - **A question about the program itself** (its curriculum, stage gates, cohort, EIRs) is answered from the
 *   program's own guidance: no reference item.
 * - **One item per turn**, the strongest match, unless the founder explicitly asks for several (examples, cases,
 *   frameworks, a comparison) or names several library subjects themselves; then at most `limit`.
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

const EXAMPLE_ASK =
  /\b(?:examples?|case stud(?:y|ies)|cases?|precedents?|companies|startups? (?:that|who)|(?:a|any) (?:company|startup|business) (?:that|who)|has anyone|anyone (?:who|that) (?:has|did))\b/;

/** Whether `sentence` asks for an example, a case or a company that did something. */
function asksForExample(sentence: string): boolean {
  return asks(sentence) && EXAMPLE_ASK.test(sentence.toLowerCase());
}

/** The founder explicitly asks for several (examples, cases, frameworks, a comparison). */
const SEVERAL =
  /\b(?:examples|cases|case studies|frameworks|compare|comparing|comparison|difference between|versus|vs)\b/;

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

function caseHits(
  c: Compiled,
  all: readonly string[],
  parts: readonly string[],
  clauses: readonly (readonly string[])[],
): Hit[] {
  const hits: Hit[] = [];
  const context = all.some((t) => CONTEXT_TOKENS.has(t)) || parts.some(asks);
  for (const name of c.names) {
    if (!has(all, name)) continue;
    // An everyday name needs a cue anywhere, or a case frame inside its own clause ("in Dropbox, does the layout…"
    // is not "Dropbox does").
    const ok = c.vocab.everyday
      ? c.nameCues.some((cue) => has(all, cue)) ||
        clauses.some((clause) => occurrences(clause, name).some((at) => framed(clause, at, name.length)))
      : context;
    if (ok) hits.push({ key: c.key, strength: 3, matched: name.join(' '), named: true });
  }
  for (const sentence of parts) {
    if (!asksForExample(sentence)) continue;
    const tokens = gateTokens(sentence);
    for (const topic of c.topics) {
      if (has(tokens, topic)) hits.push({ key: c.key, strength: 1, matched: topic.join(' '), named: false });
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
    SEVERAL.test(text.toLowerCase()) || ranked.filter((r) => r.named).length >= 2 ? options.limit : 1;
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
