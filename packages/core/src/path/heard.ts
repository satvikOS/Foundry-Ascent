import { plain } from './words.js';

/**
 * What a call heard badly, put right from the venture's own words: "the real room" where the record knows only ReelRoom,
 * "the booking bored" where it says "a booking board". A word is put right only when it sounds the same as one of theirs and
 * nothing else fits: a name of theirs heard as two words, or a word beside the one it stands beside in their own line. Pure.
 */
export interface Heard {
  /** The message with the words it must have been. */
  readonly text: string;
  /** What was heard, and what it is. */
  readonly changes: readonly { readonly heard: string; readonly meant: string }[];
}

/** How a word sounds, roughly: its consonants, alike ones one. */
export function soundOf(word: string): string {
  const w = word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/^(?:kn|gn|pn)/, 'n')
    .replace(/^wr/, 'r')
    .replace(/ph/g, 'f')
    .replace(/gh(?=t|$)/g, '')
    .replace(/(?:sch|sh|tch|ch)/g, 'x')
    .replace(/ck|q/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/dg(?=e)/g, 'j')
    .replace(/z/g, 's')
    .replace(/th/g, 't');
  const open = /^[aeiouy]/.test(w) ? 'a' : '';
  return (open + w.replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1');
}

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const wordsAt = (text: string): Word[] =>
  [...text.matchAll(/[\p{L}][\p{L}'’]*/gu)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));

/** Words heard as something, whatever a call makes of them: never a word of theirs. */
const SMALL =
  /^(?:a|an|the|and|or|but|so|to|of|in|on|at|for|with|is|are|was|be|it|i|me|my|we|our|you|your|they|them|he|she|um|uh|like|do|does|did|how|what|who|when|why|can|could|would|should|will|not|no|yes|this|that|there|here|as|if|by|from|up|out|about|get|got|have|has|had)$/;

/**
 * `names`: the venture's and other names; `lines`: its own sentences (what it does, its goal, who it is for, the idea).
 */
export function heardRight(message: string, names: readonly string[], lines: readonly string[]): Heard {
  const found = wordsAt(message);
  const known = new Set(
    [...names, ...lines].flatMap((l) =>
      wordsAt(l.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')).map((w) => w.text.toLowerCase()),
    ),
  );
  const whole = new Set([...names, ...lines].flatMap((l) => wordsAt(l).map((w) => w.text.toLowerCase())));
  const changes: { heard: string; meant: string; start: number; end: number }[] = [];
  const taken = (from: number, to: number): boolean => changes.some((c) => from < c.end && to > c.start);
  // A name of theirs, or one of their words, heard as two or three.
  const targets = [
    ...names.flatMap((n) => (n.trim() === '' ? [] : [{ word: n.trim(), name: true }])),
    ...[...whole].filter((w) => w.length >= 4 && !SMALL.test(w)).map((word) => ({ word, name: false })),
  ];
  for (const { word, name } of targets) {
    const sound = soundOf(word);
    if (sound.length < 3) continue;
    for (const n of [3, 2, 1]) {
      if (n === 1 && !name) continue;
      for (let i = 0; i + n <= found.length; i += 1) {
        const run = found.slice(i, i + n);
        const first = run[0];
        const last = run.at(-1);
        if (first === undefined || last === undefined || taken(first.start, last.end)) continue;
        const text = message.slice(first.start, last.end);
        if (/[.,;!?]/.test(text) || text.toLowerCase() === word.toLowerCase()) continue;
        if (n > 1 && SMALL.test(run[0]?.text.toLowerCase() ?? '')) continue;
        // Said right already, or all words of theirs.
        if (text.replace(/\s+/g, '').toLowerCase() === word.replace(/\s+/g, '').toLowerCase()) {
          if (name && n > 1) changes.push({ heard: text, meant: word, start: first.start, end: last.end });
          continue;
        }
        if (n === 1 && whole.has(text.toLowerCase())) continue;
        if (run.every((w) => whole.has(w.text.toLowerCase()))) continue;
        const of = run.map((w) => w.text).join('');
        if (soundOf(of) !== sound) continue;
        // A word of theirs in two pieces: both must be none of theirs ("fill em", never "film set").
        if (!name && run.some((w) => known.has(w.text.toLowerCase()) && w.text.length > 3)) continue;
        changes.push({ heard: text, meant: word, start: first.start, end: last.end });
      }
    }
  }
  // A word beside the one it stands beside in their own line ("booking bored" in "a booking board").
  for (const line of lines) {
    const own = wordsAt(line).map((w) => w.text.toLowerCase());
    own.forEach((word, k) => {
      if (word.length < 4 || SMALL.test(word)) return;
      const sound = soundOf(word);
      if (sound.length < 2) return;
      found.forEach((w, i) => {
        const t = w.text.toLowerCase();
        if (t === word || whole.has(t) || SMALL.test(t) || taken(w.start, w.end)) return;
        if (soundOf(t) !== sound) return;
        const before = found[i - 1]?.text.toLowerCase();
        const after = found[i + 1]?.text.toLowerCase();
        const beside =
          (before !== undefined && own[k - 1] === before && !SMALL.test(before)) ||
          (after !== undefined && own[k + 1] === after && !SMALL.test(after));
        if (beside) changes.push({ heard: w.text, meant: word, start: w.start, end: w.end });
      });
    });
  }
  let text = message;
  for (const c of [...changes].sort((a, b) => b.start - a.start))
    text = `${text.slice(0, c.start)}${c.meant}${text.slice(c.end)}`;
  return { text: withoutStutter(text), changes: changes.map(({ heard, meant }) => ({ heard, meant })) };
}

/** A call's fillers and words said twice ("um so like how do i uh get … to to pay") are no words of theirs. */
export function withoutStutter(text: string): string {
  const out = text
    .replace(/\b(?:um+|uh+|erm+|uhm+)\b[,.]?\s*/gi, '')
    .replace(/\b(\p{L}{1,12})(?: \1\b)+/giu, '$1')
    .replace(/\b((?:\p{L}+ ){1,2}\p{L}+) \1\b/giu, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return plain(out) === '' ? text : out;
}
