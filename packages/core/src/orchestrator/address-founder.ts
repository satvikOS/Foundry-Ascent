import { isEverydayWord, tidyFounderWords } from '@foundry/ai';

/**
 * How a model-written line (the notebook's next opener, written at distillation) is said TO the founder.
 *
 * LAB-U2: a chat opener named the founder in the third person, in lower case ("…the facility budget numbers maya will
 * get…"): the distilled line, written about the founder, was pasted as it stood. Every distilled line an opener says is
 * addressed to the founder first ({@link addressFounder}): their name or "the founder" becomes "you"/"your", other
 * people's names get their real case back, and a line that still speaks of the founder in the third person is dropped.
 * Nothing here picks what an opener is about: that is the model's line (orchestrator/continuity.ts `chooseOpener`).
 */

/** The people an opener may speak of: the founder (said as "you") and their team (names in their real case). */
export interface OpenerPeople {
  /** The founder's display name ("Maya Patel"); null when unknown. */
  readonly founder: string | null;
  /** Display names of the venture's people (the founder among them is ignored). */
  readonly team?: readonly string[];
  /**
   * Proper nouns the conversation wrote with their capitals (the vEIR's own replies, its digest:
   * {@link properNounsIn}): what the founder typed in lower case gets that case back ("harbour hall" → "Harbour Hall").
   */
  readonly names?: readonly string[];
}

/**
 * The proper nouns in `texts` (written by the vEIR, so in their real case): one to three capitalised words in a row
 * that do not open a sentence, at least one of them no everyday word ("Harbour Hall", "Hartwell", "QuietQuad"); or one
 * everyday word written with its capital where no sentence opens, after a word in lower case or a sentence's first
 * determiner ("integrate with Canvas", "A Canvas integration", "stock it at Target": the review of e9e49fb), which
 * {@link addressFounder} gives back only where a line opens with it.
 */
export function properNounsIn(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(
      /(?<=[\p{Ll}\p{N},;:'’)] )\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*){0,2}/gu,
    )) {
      const phrase = m[0].replace(/['’]s$/, '');
      if (phrase.split(' ').some((w) => !isEverydayWord(w)) && phrase.length >= 3) found.add(phrase);
    }
    for (const m of text.matchAll(EVERYDAY_NAME)) {
      const name = m[0];
      if (isEverydayWord(name) && !CALENDAR_NAMES.has(name.toLowerCase())) found.add(name);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * One capitalised word where no sentence opens: after a word in lower case ("integrate with Canvas"), or after the
 * determiner a sentence opens with ("A Canvas integration", "The Notion templates"), on one line; never after a colon
 * or a line break ("Next steps: Book the room").
 */
const EVERYDAY_NAME =
  /(?<=(?:\p{Ll}|(?:^|[.!?]["”’)]?\s+)(?:A|An|The|Your|Our|This|That|These|Those|Their|Its)) )\p{Lu}\p{Ll}{2,}(?![\p{L}\p{N}'’-])/gu;

/** Whether `name` (of {@link properNounsIn}) is one everyday word, written with its capital ("Canvas", "Target"). */
function isEverydayName(name: string): boolean {
  return /^\p{Lu}\p{Ll}{2,}$/u.test(name) && isEverydayWord(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Third-person verbs said after the founder's name, as they read after "you". */
const AGREEMENT: Readonly<Record<string, string>> = {
  is: 'are',
  was: 'were',
  has: 'have',
  does: 'do',
  "isn't": "aren't",
  "wasn't": "weren't",
  "hasn't": "haven't",
  "doesn't": "don't",
  says: 'say',
  goes: 'go',
  tries: 'try',
};
/** Regular verbs in the third person singular a distilled note uses after the founder's name. */
const S_VERBS = new Set(
  (
    'plans wants needs gets hopes thinks expects intends knows likes prefers asks owes runs leads owns handles ' +
    'sends calls meets talks works feels seems believes keeps makes takes gives checks reviews builds writes shares ' +
    'agrees decides promises mentions follows tests sets starts finishes reaches books emails visits pitches ' +
    'chases drafts prepares ends begins launches closes opens loves hates falls'
  ).split(' '),
);
const THIRD_PERSON = /\b(?:she|he|her|hers|him|his|herself|himself)\b/i;

/**
 * `text` (a distilled line: the notebook's next topic or opener, a digest topic) addressed to the founder: their
 * name, or "the founder", becomes "you" or "your" (and the verb after it agrees: "maya will get" → "you will get",
 * "Maya plans" → "You plan", "the founder's pilot" → "your pilot"); other people's names get their real case
 * back ("noor" → "Noor"). Null when the line still speaks of the founder in the third person (he, she, her…), so it
 * is dropped rather than said.
 */
export function addressFounder(text: string, people: OpenerPeople): string | null {
  const founderNames = new Set<string>(['the founder']);
  if (people.founder !== null && people.founder.trim() !== '') {
    const full = people.founder.normalize('NFKC').trim().replace(/\s+/g, ' ');
    founderNames.add(full);
    const first = full.split(' ')[0];
    if (first !== undefined && first.length >= 2) founderNames.add(first);
  }
  const alternation = [...founderNames]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  // Capitalised where a sentence starts: after its punctuation, or at the start when the line was capitalised there
  // (a lower-case line is a phrase said mid-sentence: "we left off on the numbers you will get").
  const startOfSentence = (source: string, at: number): boolean =>
    at === 0 ? /^\p{Lu}/u.test(source) : /[.!?]\s+$/.test(source.slice(0, at));
  const cased = (word: string, source: string, at: number): string =>
    startOfSentence(source, at) ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
  let out = text
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(new RegExp(`\\b(?:${alternation})'s\\b`, 'giu'), (_m, at: number, source: string) =>
      cased('your', source, at),
    )
    .replace(
      new RegExp(`\\b(?:${alternation})\\s+([a-z']+)\\b`, 'giu'),
      (_m, verb: string, at: number, source: string) => {
        const lower = verb.toLowerCase();
        const agreed = AGREEMENT[lower] ?? (S_VERBS.has(lower) ? lower.slice(0, -1) : verb);
        return `${cased('you', source, at)} ${agreed}`;
      },
    )
    .replace(new RegExp(`\\b(?:${alternation})\\b`, 'giu'), (_m, at: number, source: string) =>
      cased('you', source, at),
    );
  if (THIRD_PERSON.test(out)) return null;
  const founderFirst = people.founder?.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
  for (const name of people.team ?? []) {
    for (const part of new Set([name.trim(), name.trim().split(/\s+/)[0] ?? ''])) {
      if (part.length < 2 || part.toLowerCase() === founderFirst) continue;
      out = out.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, 'giu'), part);
    }
  }
  // Names the conversation wrote with capitals, where the founder typed them in lower case (wave 7, item 2). One
  // everyday word ("Canvas", "Target") only where a subject opens with it, its sentence's first word: "target" is
  // said as written anywhere else ("your target market").
  for (const name of people.names ?? []) {
    if (name.toLowerCase() === founderFirst) continue;
    const at = isEverydayName(name) ? '^' : '(?<![\\p{L}\\p{N}])';
    out = out.replace(new RegExp(`${at}${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), name);
  }
  return tidyFounderWords(out);
}

/** Months, days and holidays: names that keep their capital mid-sentence, everyday words or not ("May", "Thanksgiving"). */
const CALENDAR_NAMES = new Set(
  (
    'january february march april may june july august september october november december monday tuesday ' +
    'wednesday thursday friday saturday sunday thanksgiving christmas easter halloween hanukkah passover ramadan ' +
    'diwali'
  ).split(' '),
);
