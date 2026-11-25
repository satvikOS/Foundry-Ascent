import { bare, SAYS, upperFirst } from './tell.js';

/**
 * Whether a line of the record, or a claim, can be said as it is: one whole sentence to them, with a subject and a verb, and
 * nobody else in it who is them. What can be put right is; what cannot is not said. Pure.
 */

/** A verb that stands where its subject should ("has two kilns", "uses a ladder"). */
const NO_SUBJECT =
  /^(?:has|have|had|is|are|was|were|does|did|wants?|wanted|needs?|needed|uses|used|pays|paid|says|said|asks|asked|thinks|owns|runs|ran|sells|sold|makes|made|takes|took|gets|got|gives|gave|keeps|kept|loves|hates|likes|lives|works|worked|knows|believes|plans|hopes|says|told|tells|will|would|can|could|should|may|might)\b(?! (?:you|it|he|she|they|we|there|the|that|this|anyone|somebody)\b[^.]*\?)/i;
const GERUND =
  /^(?!(?:nothing|anything|something|everything|morning|evening|during|spring|string|king|thing|ring)\b)[a-z]+ing\b/i;
const FINITE =
  /\b(?:is|are|was|were|has|have|had|does|did|will|would|can|could|should|must|may|might|[\p{L}]{2,}ed|pays?|paid|sells?|sold|says?|said|tells?|told|runs?|ran|gets?|got|comes?|came|goes|went|leaves?|left|makes?|made|takes?|took|gives?|gave|keeps?|kept|met|chose|buys?|bought|built|grew|fell|lost|won|found|spends?|spent|charges?|costs?|uses?|wants?|needs?|works?|asks?|opens?|brings?|brought|sends?|sent|holds?|held|shows?|began|knows?|knew|lends?|lent|rents?|stays?|stood|stands?|eats?|ate|rose|drops?|dropped|hates?|loves?|likes?|do|live|lives|sleeps?|speaks?|cook|cooks|read|reads)\b/iu;

/** "You do all of it himself": who it is said of is who it is said to. */
export function yourself(text: string): string {
  return text.replace(
    /\b(you\b(?:(?!\b(?:he|she|they|who|him|her|them|people|staff|team)\b)[^.;!?]){0,60}?\b)(?:himself|herself|themself|themselves)\b/giu,
    '$1yourself',
  );
}

/** What the record puts before a line: its own label, and no part of the sentence. */
const LABELLED =
  /^(?:a risk you named|you (?:said|told) of what is done so far|you reported|on [^,]{3,60}, your record says):\s+/iu;

/** A line of the record as it is said to them; '' when it is no whole sentence. */
export function lineSaid(text: string): string {
  const said = yourself(
    text
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(LABELLED, '')
      .replace(/^you decided:\s+(?:next:\s+)?(?=[a-z]+ing\b)/iu, 'You decided on ')
      .replace(/^you decided:\s+(?:next:\s+)?/iu, 'You decided to '),
  );
  return isWhole(said) ? upperFirst(said) : '';
}

/** Whether a text stands as a sentence: it has a subject and a verb. */
export function isWhole(text: string): boolean {
  const said = bare(text).replace(/^["“'‘(]+/u, '');
  if (said.split(/\s+/u).length < 3) return false;
  if (NO_SUBJECT.test(said)) return false;
  // "You sharpen all of it": whoever is spoken to does something.
  if (/^you [a-z]/i.test(said)) return true;
  // "First table of three": a title. "Applying for a grant": a doing nobody does.
  if (
    GERUND.test(said) &&
    !/^\S+ing\b[^,;:]*\b(?:is|are|was|were|takes?|took|costs?|brings?|brought|means?|gives?|gave|made|makes?|works?|worked|needs?)\b/iu.test(
      said,
    )
  )
    return false;
  return FINITE.test(said) || SAYS.test(said);
}
