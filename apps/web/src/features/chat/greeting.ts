import { greeting as timeOfDay } from '@/lib/format';

/**
 * What New chat says first: a heading and the line under it. With something to pick up, it is the vEIR's opener
 * (`GET /ventures/:id/opener`), the line the conversation then opens with, word for word: the opener's own
 * greeting becomes the heading with the founder's name ("Welcome back." → "Welcome back, Maya") and the rest is
 * the line ("Last time we were on per-library pricing. How did the facilities call go?"). The time-of-day greeting
 * is only for nothing to pick up, or a private chat (which reads nothing).
 */
export interface NewChatGreeting {
  readonly title: string;
  readonly line: string;
}

/** How an opener's own greeting sentence starts ("Welcome back.", "Good to talk again.", "Hi Maya!"). */
const GREETING_START =
  /^(?:hi|hello|hey|hiya|welcome back|good to|nice to|great to|lovely to|good (?:morning|afternoon|evening)|morning|afternoon|evening)\b/i;
/** Longest greeting sentence taken for a heading. */
const GREETING_MAX_WORDS = 7;

/** Welcomes over a returning founder's opener that has no greeting of its own. */
const WELCOMES = ['Welcome back', 'Good to see you', 'Hello again', 'Nice to see you'] as const;

/** The welcome for an opener's line: the same line always gets the same one, a new line most likely another. */
function welcomeFor(line: string): string {
  let hash = 0;
  for (let i = 0; i < line.length; i += 1) hash = (Math.imul(hash, 31) + line.charCodeAt(i)) >>> 0;
  return WELCOMES[hash % WELCOMES.length] ?? WELCOMES[0];
}

/** An opener split into its own greeting sentence, when it starts with one, and the rest. */
export function splitOpener(opener: string): { readonly greeting: string | null; readonly rest: string } {
  const text = opener.replace(/\s+/g, ' ').trim();
  const match = /^([^.!?]+[.!])\s+(\S.*)$/u.exec(text);
  const first = match?.[1];
  const rest = match?.[2];
  if (
    first === undefined ||
    rest === undefined ||
    !GREETING_START.test(first) ||
    first.split(' ').length > GREETING_MAX_WORDS
  ) {
    return { greeting: null, rest: text };
  }
  return { greeting: first, rest };
}

/**
 * The greeting of New chat for the founder `firstName`: from the vEIR's `opener` when there is one (`returning`:
 * they have talked before), else the time of day and what to work on (also for a private chat).
 */
export function newChatGreeting(args: {
  readonly opener: string | null;
  readonly firstName: string;
  readonly ventureName: string;
  readonly returning: boolean;
  readonly privateChat: boolean;
  readonly now?: Date;
}): NewChatGreeting {
  const { firstName } = args;
  if (args.privateChat)
    return { title: `${timeOfDay(args.now)}, ${firstName}`, line: 'What’s on your mind?' };
  const opener = args.opener?.trim() ?? '';
  if (opener === '') {
    return {
      title: `${timeOfDay(args.now)}, ${firstName}`,
      line: 'What should we work on today?',
    };
  }
  const { greeting, rest } = splitOpener(opener);
  // The vEIR's own line has no greeting sentence: a welcome that changes with the line (coaching v3: the opener is
  // model-written and never the same twice in a row; one stock heading over it every time would undo that).
  if (greeting === null) {
    return { title: `${args.returning ? welcomeFor(rest) : 'Hi'}, ${firstName}`, line: rest };
  }
  const bare = greeting.replace(/[.!]+$/, '');
  const named = firstName !== '' && bare.toLowerCase().includes(firstName.toLowerCase());
  return { title: named ? bare : `${bare}, ${firstName}`, line: rest };
}
