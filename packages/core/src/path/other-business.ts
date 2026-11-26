/**
 * Another business a founder runs beside the venture, by their own words: its facts are never the venture's (a note to keep,
 * a line of what the venture has).
 */

/** Another business of theirs, named as such: "the pottery is a separate business", "my other job, the cafe". */
const OTHER_BUSINESS = [
  /\bmy (\p{L}[\p{L}-]{2,})(?:['’]s| is) (?:the|my) other (?:thing|business|job|gig|venture|company|shop) (?:i|we) (?:run|do|have|own)\b/iu,
  /\b(?:my|our) other (?:business|venture|company|shop|job|gig)(?:,| is)? (?:the |a |my |our )?(\p{L}[\p{L}-]{2,}(?: (?!is\b|does\b|was\b|and\b)\p{L}[\p{L}-]{2,})?)\b/iu,
  /\b(?:the|my|our) (\p{L}[\p{L}-]{2,}) is (?:a )?(?:separate|another|a different) (?:thing|business|venture|company)\b/iu,
];

/** The names of other businesses they run, by their own words: none of them is the venture's. */
export function otherBusinessesIn(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of texts)
    for (const re of OTHER_BUSINESS) {
      const name = re.exec(text)?.[1]?.toLowerCase();
      if (name !== undefined && !/^(?:one|thing|business|venture|company|idea|side)$/u.test(name))
        out.add(name);
    }
  return [...out];
}

/** Whether a note is about one of those other businesses, and so no fact of this venture. */
export function ofAnotherBusiness(text: string, others: readonly string[]): boolean {
  const said = text.toLowerCase();
  // "food truck" is named by both words.
  return others.some((name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}s?\\b`, 'u').test(said),
  );
}
