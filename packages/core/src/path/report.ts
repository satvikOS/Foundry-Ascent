import { type PathReport } from '@foundry/contracts';

import { statesItHappened } from './kinds.js';
import { shortOfCount } from './progress.js';
import { type Playbook } from './types.js';

/**
 * What the model says a message reports, held to the founder's own words: a report counts only when its quote is in the
 * message, word for word (spaces, case and quote marks aside), and the sentence it stands in says it happened. The model
 * can point at what they said; it never decides it.
 */
function flat(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_QUOTE_WORDS = 2;

/** The quote as the founder wrote it (clipped to `max`), or null when it is not theirs. */
export function verbatimQuote(
  quote: string | null | undefined,
  founderText: string,
  max = 1000,
): string | null {
  if (typeof quote !== 'string') return null;
  const wanted = flat(quote).replace(/^[\s.,;:'-]+|[\s.,;:'-]+$/g, '');
  if (wanted.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length < MIN_QUOTE_WORDS) return null;
  const said = flat(founderText);
  const at = said.indexOf(wanted);
  if (at < 0) return null;
  // Whole words: "did it" is not in "candid item".
  const before = said[at - 1] ?? ' ';
  const after = said[at + wanted.length] ?? ' ';
  if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) return null;
  return quote.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Whether every sentence the quote touches states it happened (no question, plan, wish or denial). */
function stated(quote: string, founderText: string): boolean {
  const wanted = flat(quote);
  const touching = founderText.split(/(?<=[.?!;])\s+|\n+/u).filter((s) => {
    const own = flat(s);
    return own !== '' && (own.includes(wanted) || wanted.includes(own));
  });
  return touching.length === 0 ? statesItHappened(quote) : touching.every(statesItHappened);
}

export interface GuardedReport {
  readonly step: NonNullable<PathReport['step']> | null;
  /** Their words for the step's report (null with `step` null). */
  readonly quote: string | null;
  readonly criteria: { id: string; quote: string }[];
}

/** The report as it may be kept; null when nothing in it is the founder's own. */
export function guardReport(
  report: PathReport | null | undefined,
  founderText: string,
  playbook: Pick<Playbook, 'criteria'>,
): GuardedReport | null {
  if (report === null || report === undefined) return null;
  const quote = verbatimQuote(report.quote, founderText);
  const happened = quote !== null && stated(quote, founderText);
  // Something to show: a few words of their own, never a bare "done".
  const shows = quote !== null && (quote.split(/\s+/).length >= 4 || /\d/.test(quote));
  const step =
    report.step === null || quote === null
      ? null
      : report.step === 'done'
        ? happened && shows
          ? report.step
          : null
        : report.step;
  const criteria: { id: string; quote: string }[] = [];
  for (const c of report.criteria) {
    const criterion = playbook.criteria.find((x) => x.id === c.id);
    if (criterion === undefined || criteria.some((x) => x.id === c.id)) continue;
    const own = verbatimQuote(c.quote, founderText);
    if (own === null || own.split(/\s+/).length < 4 || !stated(own, founderText)) continue;
    // "Eight interviews" is progress towards ten, never a claim of them.
    if (shortOfCount(criterion, own)) continue;
    criteria.push({ id: c.id, quote: own });
  }
  if (step === null && criteria.length === 0) return null;
  return { step, quote: step === null ? null : quote, criteria };
}
