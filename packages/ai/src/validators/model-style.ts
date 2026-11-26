import { knownNumbersIn, numbersIn } from './figures.js';

/**
 * What a writer adds beside the reply in its own manner, held the same whichever model writes (Nova and Mistral Large 3
 * differ here): a stage direction ("*leans back*"), a done-check of its own beside the step's, a deadline of its own in a
 * draft, a self-introduction of the founder in a draft that reads as the mentor's, an example figure, a value made up for a
 * sum, and a thing of theirs said as done ("the paperwork you signed"). Provider-neutral: every rule reads the text alone.
 */

export interface StyleContext {
  /** The unit is inside words to send or say, in quotes. */
  readonly quoted: boolean;
  /** What the founder said, this message and before. */
  readonly founderText: string;
  /** Their first name, when known. */
  readonly founderName?: string | null;
  /** What figures may be stated from (their words, the record, the guidance). */
  readonly known: string;
}

export interface Styled {
  /** The unit as it may stand. */
  readonly text: string;
  /** Why it goes, or null. */
  readonly cut: 'stage' | 'example' | 'made_up_value' | 'markup' | null;
}

/** "*leans back, arms crossed*": an action in emphasis, alone on its line, that is not said. */
const STAGE = /^\s*(?:\*(?!\*)[^*\n]{2,80}\*|_(?!_)[^_\n]{2,80}_|\([^()\n]{2,60}\))\s*$/u;
const STAGE_WORDS =
  /(?<!\p{L})(?:leans?|nods?|smiles?|sighs?|pauses?|laughs?|shrugs?|grins?|crosse[sd]|arms|chuckles?|winks?|frowns?|thinks?|taps?|looks?)(?!\p{L})/iu;

/** A done-check of its own: the step's is the only one ("You are done when …"). */
const OWN_DONE = /^(\W*)(?:you(?:['’]re| are| will be|['’]ll be)\s+done|done)\s+(when|once)\b/iu;

const DAY_WORD =
  '(?:tomorrow|tonight|today|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:the )?end of (?:the |this )?(?:day|week))';
/** A deadline inside words to send ("let me know by tomorrow"): theirs to set, never ours. */
const QUOTED_DEADLINE = new RegExp(`\\b(by|before|until|no later than)\\s+(${DAY_WORD})\\b`, 'giu');
/** A quotation inside a unit. */
const INNER_QUOTE = /(["“])([^"“”\n]{1,400})(["”])/gu;

/** "Example: if it costs $22 …": an example made of a figure nobody gave. */
const EXAMPLE = /^\W*(?:example|for example|for instance|e\.g\.|say|suppose|imagine|let['’]s say)\b[,:]?\s/iu;
/** "if it costs $22": a value supposed for something nobody counted. */
const SUPPOSES =
  /\bif\s+(?:[\p{L}'’-]+\s){0,4}(?:is|are|was|were|costs?|comes? to|runs?)\s+(?:(?:you|us|them|me)\s+)?(?:about |around )?\$?\d/iu;
/** "bottles = 2 semesters": a value of a sum that nobody gave. */
const ASSIGNED = /\b\p{L}[\p{L} ]{0,24}\s=\s\$?\d/u;

/** "any paperwork you signed", "the grants you used": a thing of theirs said as done that they never told. */
const SAID_DONE = /\b((?:any|whatever) (?:[\p{L}-]+ ){0,3}?you) (signed|got|received|had|filed)\b/giu;

/** What of a draft is the founder's own to set, and a self-introduction that reads as the mentor's. */
function heldDraft(text: string, ctx: StyleContext): string {
  const own = ctx.founderText.toLowerCase();
  let out = text.replace(QUOTED_DEADLINE, (whole, by: string, day: string) =>
    own.includes(day.toLowerCase()) ? whole : `${by} [day]`,
  );
  const name = (ctx.founderName ?? '').trim();
  if (name !== '')
    out = out.replace(
      new RegExp(
        `\\b(?:I['’]m|I am|My name is)\\s+(${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})\\b`,
        'gu',
      ),
      'This is $1',
    );
  return out;
}

/** Figures of a text that nobody gave, as they stand (no arithmetic makes one theirs here). */
function unknownFigures(text: string, known: string): number[] {
  const given = knownNumbersIn(known);
  return numbersIn(text).filter((n) => n > 1 && !given.some((g) => Math.abs(g - n) < 0.005));
}

/** "in 48 hours": a wait of the writer's own, as a figure nobody gave; said in days, it is advice and no figure. */
const HOURS = /\b(24|48|72) hours\b/gu;
const HOURS_SAID: Readonly<Record<string, string>> = { '24': 'a day', '48': 'two days', '72': 'three days' };

/** Where a quotation opens in a text and does not close in it; null: none does. */
function openQuoteAt(text: string): number | null {
  let at: number | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '“' || (ch === '"' && at === null)) at = i + 1;
    else if (ch === '”' || ch === '"') at = null;
  }
  return at;
}

/** Whether a text is nothing but stage directions and space. */
export const onlyStage = (text: string): boolean =>
  text.split('\n').every((line) => line.trim() === '' || (STAGE.test(line.trim()) && STAGE_WORDS.test(line)));

/** A rule across the reply ("---"), and a heading alone on its line ("## What we own"): no part of a reply. */
const RULE_LINE = /(^|\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/gu;
// A bold line stays: it labels the list or the template under it.
const HEADING_ALONE = /^\s*#{1,6}\s+[^\n]{2,80}\s*$/u;
const STEP_LABEL = /^\s*\*\*\s*(?:next|on your path|done when)\b/iu;
/** "$X", "X%": a blank written as a letter, which reads as a figure; a bracket is a blank. */
const LETTER_BLANK = /\$\s?X\b|\bX\s?%|\$\s?\?\?+/gu;

/** One unit of the writer's, held to what the reply may hold: see the module comment. */
export function heldStyle(unit: string, ctx: StyleContext): Styled {
  const text = unit.replace(RULE_LINE, '$1').trim();
  if (text === '') return { text: '', cut: 'markup' };
  if (STAGE.test(text) && STAGE_WORDS.test(text) && !/\d/u.test(text)) return { text: '', cut: 'stage' };
  if (!ctx.quoted && HEADING_ALONE.test(text) && !STEP_LABEL.test(text)) return { text: '', cut: 'markup' };
  if (!ctx.quoted && EXAMPLE.test(text) && SUPPOSES.test(text) && unknownFigures(text, ctx.known).length > 0)
    return { text: '', cut: 'example' };
  if (!ctx.quoted && ASSIGNED.test(text) && unknownFigures(text, ctx.known).length > 0)
    return { text: '', cut: 'made_up_value' };
  let out = unit
    .replace(RULE_LINE, '$1')
    .replace(LETTER_BLANK, (m) => (m.includes('%') ? '[share]' : '[amount]'))
    .replace(HOURS, (whole, n: string) => (ctx.founderText.includes(n) ? whole : (HOURS_SAID[n] ?? whole)));
  if (ctx.quoted) out = heldDraft(out, ctx);
  else {
    out = out.replace(
      INNER_QUOTE,
      (_whole, open: string, inner: string, close: string) => `${open}${heldDraft(inner, ctx)}${close}`,
    );
    // Words that open here and go on past the unit ("In the body:\n"Hi Sam, I’m …").
    const opened = openQuoteAt(out);
    if (opened !== null) out = `${out.slice(0, opened)}${heldDraft(out.slice(opened), ctx)}`;
    out = out.replace(
      OWN_DONE,
      (_whole, lead: string, when: string) => `${lead}It is usually enough ${when}`,
    );
    const said = ctx.founderText.toLowerCase();
    out = out.replace(SAID_DONE, (whole, what: string, verb: string) =>
      said.includes(verb.toLowerCase()) ? whole : `${what} may have ${pastParticiple(verb)}`,
    );
  }
  return { text: out, cut: null };
}

const PARTICIPLES: Readonly<Record<string, string>> = {
  got: 'got',
  had: 'had',
  made: 'made',
  sent: 'sent',
  wrote: 'written',
  took: 'taken',
};
const pastParticiple = (verb: string): string => PARTICIPLES[verb.toLowerCase()] ?? verb;
