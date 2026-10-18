/**
 * A greeting said twice. A call's intro greets the founder by name ("Hi Mina, how did the interviews go?"); the
 * vEIR's first reply then opened "Hello Mina, nice to hear from you." (the matrix's MX-0005) or "Good to talk
 * again." right after the intro said it (the lab's LAB-R4). Once the conversation's opening line has greeted them,
 * the first reply leaves out a greeting it opens with (`withoutRepeatedGreeting`), in the sentence gate (typed and
 * spoken) and in the final validator; a reply that was nothing but the greeting becomes a short hand-back
 * ({@link REPEATED_GREETING_FALLBACK}).
 *
 * Only the greeting clause goes: "Hi Mina, how did it go?" keeps "How did it go?", "Hey, good to have you back!
 * So, the pilot…" keeps "So, the pilot…". A sentence that greets and says something else in the same clause
 * ("Good to hear the pilot went well.") is not a greeting.
 */

/** What a reply that was only a repeated greeting says instead: the opener's question still stands. */
export const REPEATED_GREETING_FALLBACK = 'Whenever you’re ready.';

const GREETING_WORDS = [
  'hi',
  'hello',
  'hey',
  'hiya',
  'howdy',
  'hey there',
  'hi there',
  'hello there',
  'hello again',
  'hi again',
  'hey again',
  'good morning',
  'good afternoon',
  'good evening',
  'morning',
  'welcome back',
  'welcome',
  'great to see you',
  'good to see you',
  'nice to see you',
  'lovely to see you',
];

/** Greeting phrases (lower case, apostrophes straightened), as the whole of a clause with a name or "again". */
const GREETING_CLAUSE = new RegExp(
  String.raw`^(?:` +
    [
      ...GREETING_WORDS.map((w) => w.replace(/ /g, '\\s+')),
      String.raw`(?:it'?s\s+)?(?:so\s+|really\s+)?(?:good|great|nice|lovely)\s+to\s+(?:see|hear\s+from|hear|talk\s+(?:to|with)|speak\s+(?:to|with)|have|catch\s+up\s+with)\s+you(?:\s+(?:again|back|here|too))?`,
      String.raw`(?:good|great|nice|lovely)\s+to\s+(?:talk|speak|catch\s+up)(?:\s+again)?`,
      String.raw`(?:glad|happy)\s+(?:you(?:'re|\s+are)\s+(?:back|here)|to\s+(?:see|hear\s+from)\s+you(?:\s+again)?|you\s+(?:stopped\s+by|came\s+back))`,
    ].join('|') +
    String.raw`)(?:\s+again)?$`,
  'u',
);

function normalise(text: string): string {
  return text.normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `clause` without the person's names (and a trailing "again", "there", "too"), lower case. */
function withoutNames(clause: string, names: readonly string[]): string {
  let text = normalise(clause).replace(/[!.…,;:\s]+$/u, '');
  for (const name of names) {
    const forms = [name, name.split(/\s+/)[0] ?? ''].filter((n) => n.length >= 2).map((n) => normalise(n));
    for (const form of forms) {
      text = text
        .replace(new RegExp(`(?:^|[\\s,]+)${escapeRegExp(form)}(?=$|[\\s,!.])`, 'gu'), '')
        .trim()
        .replace(/[,\s]+$/u, '');
    }
  }
  return text.replace(/[,\s]+(?:again|there|too)$/u, '').trim();
}

/** Whether `clause` (no punctuation at its ends) is only a greeting, with the person's name at most. */
function isGreetingClause(clause: string, names: readonly string[]): boolean {
  const text = withoutNames(clause, names);
  return text !== '' && GREETING_CLAUSE.test(text);
}

/**
 * `text` without the greeting it opens with (see the module comment): clauses split at commas, full stops and
 * exclamation marks are dropped from the start while each is only a greeting (with `names`, the founder's, at most).
 * `removed` when something was dropped; `text` is '' when the whole reply was a greeting.
 */
export function withoutRepeatedGreeting(
  text: string,
  names: readonly string[] = [],
): { readonly text: string; readonly removed: boolean } {
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  let rest = text.slice(lead.length);
  let removed = false;
  for (;;) {
    const clause = /^([^,.!?…\n]+)([,.!…]+["'”’)]*\s*|$)/u.exec(rest);
    if (clause?.[1] === undefined) break;
    // A greeting, or the name after one ("Welcome back, Mina.").
    const greets = isGreetingClause(clause[1], names) || (removed && withoutNames(clause[1], names) === '');
    if (!greets) break;
    rest = rest.slice(clause[0].length);
    removed = true;
    if (rest === '') break;
  }
  if (!removed) return { text, removed: false };
  const trimmed = rest.replace(/^[\s,;:—–-]+/u, '');
  // What is left starts a sentence now.
  const capital = trimmed.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
  return { text: capital === '' ? '' : `${lead}${capital}`, removed: true };
}

/**
 * Whether the conversation's opening line said hello (a call's intro: "Hi Maya, …", "Hello, I'm…"): then its first
 * reply must not greet again. A chat opener that only welcomes them back ("Good to have you back. …") leaves a hello
 * a warm hello back.
 */
export function openerSaidHello(opener: string | null): boolean {
  return opener !== null && /^(?:hi|hello|hey|hiya)\b/i.test(opener.trim());
}
