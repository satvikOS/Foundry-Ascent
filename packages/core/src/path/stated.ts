import { asksFor, ownSentences, statesItHappened } from './kinds.js';
import { bare, lowerFirst, toYou } from './tell.js';
import { plain } from './words.js';

/**
 * What they said in so many words of the lines of the one-page idea: who it is for, what people do now, and what they
 * themselves know or reach. Their own words or nothing: a line nobody told keeps its bracket. Pure.
 */

/** People and the places that act for them, as an idea names who it is for. */
const PEOPLE =
  '(?:people|students|undergraduates|undergrads|freshmen|graduates|assistants|nurses|parents|teachers|founders|owners|managers|clinics|labs|shops|schools|clubs|groups|bands|choirs|troupes|societies|families|farmers|farms|cooks|caterers|teams|beginners|athletes|offices|restaurants|hotels|companies|doctors|dentists|renters|tenants|residents|commuters|cyclists|volunteers|captains|coaches|musicians|artists|performers|singers|dancers|actors|players|researchers|scientists|makers|sellers|guests|neighbou?rs|workers|couples|veterans|drivers|runners|hikers|rangers|marinas|boatyards|breweries|gyms|salons|cafes|bakeries|kindergartens|libraries|churches|museums|kids|children|seniors|patients|tutors|landlords|housemates|roommates|beekeepers|gardeners|organi[sz]ers)';
const KIND = String.raw`(?:(?!(?:the|an?|my|our|your|their|its|it|them|you|each|every|all|and|or|to|with|for|that|who|which|from|of|by)\b)[a-z'’-]+ ){0,2}${PEOPLE}`;
/** One kind of them, or two, with who they are up to the end of what is said ("assistants who teach in a second language"). */
const ALL = String.raw`${KIND}(?: (?:and|or) ${KIND})?`;
const TO_END = String.raw`(?: who [^.,;:!?]{3,70}(?=[.,;:!?]|$)|(?=[.,;:!?]|$| (?!who\b|and\b|or\b)[a-z]+))`;

const PAIRED = new RegExp(
  String.raw`\b(?:match(?:es|ing)?|pairs?|pairing|connect(?:s|ing)?|links?|linking) (${KIND}(?: who [^.,;:!?]{3,60}?)?) (?:with|to|and) (${KIND}(?: who [^.,;:!?]{3,60})?)(?=[.,;:!?]|$)`,
  'iu',
);
const ACTED_ON = new RegExp(
  String.raw`\b(?:lets?|helps?|allows?|enables?|teach(?:es)?|warns?|reminds?|shows?|tells?) (${KIND}) (?:to )?[a-z]+`,
  'iu',
);
const GIVEN_TO = new RegExp(
  String.raw`\b(?:rents?|sells?|lends?|gives?|offers?|delivers?|brings?|sends?|ships?|renting|selling|lending|giving|offering|delivering|bringing|sending)\b[^.,;:!?]{0,60}? to (${ALL}${TO_END})`,
  'iu',
);
const MADE_FOR = new RegExp(String.raw`\bfor (${ALL}${TO_END})`, 'iu');

/** "people" alone, and "my friends", say nobody. */
const NOBODY = /^(?:people|companies|students and people|(?:other|some|many|most|more|any|new) people)$/iu;

/** Who it is for, in the words of their idea ("students who drive home and people who need a ride"); null: not said. */
export function whoIn(idea: string): string | null {
  const text = bare(idea.replace(/\s+/g, ' '));
  const pair = PAIRED.exec(text);
  const found =
    pair?.[1] !== undefined && pair[2] !== undefined
      ? `${bare(pair[1])} and ${lowerFirst(bare(pair[2]))}`
      : bare((GIVEN_TO.exec(text) ?? ACTED_ON.exec(text) ?? MADE_FOR.exec(text))?.[1] ?? '');
  return found === '' || NOBODY.test(found) ? null : lowerFirst(found);
}

const NOW =
  /^(?:(?:so|and|but|well)[, ]+)*(?:right now|today|now|at the moment|currently|these days),? ((?:they|people|students|everyone|most (?:people|students|of them)|[a-z]+(?:ers|ors|ists|ents)) (?!will\b|would\b|can(?:not|['’]t)?\b|should\b)[^.;!?]{6,110})/iu;
const ME =
  /^(?:(?:so|and|but|well)[, ]+)*(I(?:['’]ve| have)? (?:work|worked|volunteer|volunteered|coach|coached|teach|taught|write|wrote|manage|managed|repair|repaired) (?!on (?:it|this|that)\b|(?:it|this|that|them)\b)[^.;!?,]{8,90})/u;

const said = (texts: readonly string[]): string[] =>
  texts.flatMap((t) =>
    ownSentences(t)
      .map((s) => s.trim())
      .filter((s) => !s.endsWith('?') && !asksFor(s)),
  );

/** What people do about it now, as they told it; null: not said. */
export function todayIn(texts: readonly string[]): string | null {
  for (const s of said(texts)) {
    const told = NOW.exec(s)?.[1];
    if (told !== undefined && statesItHappened(s) && !/\b(?:app|idea|startup|venture)\b/.test(plain(told)))
      return lowerFirst(toYou(bare(told)));
  }
  return null;
}

/** What they themselves do that bears on it, as a page of theirs says it ("I write …"); null: not said. */
export function meIn(texts: readonly string[]): string | null {
  for (const s of said(texts)) {
    const told = ME.exec(s)?.[1];
    // Where they work on a venture, or what they work out, is nothing they reach.
    if (
      told !== undefined &&
      statesItHappened(told) &&
      !/\b(?:idea|startup|venture|business plan|numbers)\b/.test(plain(told))
    )
      return bare(told);
  }
  return null;
}
