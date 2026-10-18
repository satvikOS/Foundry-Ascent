import { contentTokens, founderMoves, isEverydayWord } from '@foundry/ai';

/**
 * What an opening line says the last conversation was about, and how it speaks of the founder.
 *
 * LAB-R3 (lab run 39080360013): openers quoted the founder's last line back, even when it was a recall or meta
 * question ('the last thing you asked was "Hey, do you remember what we talked about last time?" Want to pick that
 * up?'). So a line is only a subject when it names something to talk about ({@link isTopicLine}: not a greeting,
 * a check, a recall or memory question, a question about the vEIR itself, thanks or a wrap-up), and the topic is
 * summarised, never quoted ({@link topicOf}): "whether to price per library or per seat", "how to price the
 * pilot", "your plan to call facilities", "the Hartwell pilot".
 *
 * LAB-U2: a chat opener named the founder in the third person, in lower case ("Shall we pick up the facility budget
 * numbers maya will get…"): the distilled thread, written about the founder, was pasted as it stood. Every
 * distilled line an opener uses is addressed to the founder first ({@link addressFounder}): their name or "the
 * founder" becomes "you"/"your", other people's names get their real case back, and a line that still speaks of
 * the founder in the third person is dropped.
 */

/** The people an opener may speak of: the founder (said as "you") and their team (names in their real case). */
export interface OpenerPeople {
  /** The founder's display name ("Maya Patel"); null when unknown. */
  readonly founder: string | null;
  /** Display names of the venture's people (the founder among them is ignored). */
  readonly team?: readonly string[];
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
    'chases drafts prepares'
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
  return out;
}

/**
 * Words that open, check or fill a conversation without naming anything to talk about: greetings, "can you hear
 * me", acknowledgements, and the bare frame of a request ("I have a quick question").
 */
export const FILLER = new Set(
  (
    'hi hello hey hiya howdy yo hullo greetings morning afternoon evening good day night test testing tested ' +
    'hear me can you there are ok okay sure yes yeah yep yup no nope nah thanks thank cheers please sorry um ' +
    'uh umm hmm right great cool fine well again back just quick question something talk chat call start let ' +
    'what how about anything want would like need help got minute moment am doing do going today now here'
  ).split(' '),
);

/** Words that name something to talk about (content words that are not {@link FILLER}). */
export function topicWords(text: string): string[] {
  return [...contentTokens(text)].filter((w) => !FILLER.has(w));
}

/** Recall and memory questions the conversation-state cues do not cover ("What did I tell you in our chat…?"). */
const RECALL =
  /\b(?:remember|recall|remind me|last time|(?:we|you and i) (?:talked|spoke|discussed|chatted|covered)|did i (?:tell|say|mention|ask)|i (?:told|asked|said to|mentioned to) you|what did (?:i|we) (?:say|tell|talk|discuss|decide|agree|ask)|(?:in|from|during) our (?:last |previous |earlier |first )?(?:chat|call|conversation|session|talk)|you (?:said|told me|mentioned)|(?:forgot|forget)\b)/i;
/** Questions about the vEIR itself, not the venture. */
const ABOUT_THE_VEIR =
  /\b(?:are you (?:a |an |the )?(?:bot|robot|human|real|ai|person|machine|man|woman|really)|is this (?:really |actually )?(?:you|a bot|a human|an ai|real|a person|[A-Z][a-z]+\b(?=\s*\?))|am i (?:talking|speaking|chatting) (?:to|with)|who (?:am i talking to|are you|is this)|what are you|your name|do you (?:even )?(?:have a life|sleep|eat|feel|dream)|you(?:'re| are) (?:a bot|an ai|not real|a robot|human))/i;
/** Checks of the line itself. */
const META = /\b(?:can you hear me|are you there|is this (?:working|on)|mic check|testing|test test)\b/i;

/** Whether a founder line names something to pick up again (see the module comment). */
export function isTopicLine(text: string): boolean {
  const line = text.replace(/[‘’ʼ]/g, "'").trim();
  if (line === '') return false;
  const moves = founderMoves(line);
  if (moves.some((m) => m === 'recall' || m === 'resume' || m === 'closing' || m === 'short_reply'))
    return false;
  if (RECALL.test(line) || ABOUT_THE_VEIR.test(line) || META.test(line)) return false;
  return topicWords(line).length >= 2;
}

/** Words that end a noun phrase (function words and the common verbs of a founder's line). */
const BREAKERS = new Set(
  (
    'and or but so if then than to of in on at for with from by about into over under after before during between ' +
    'through without within per via as is are was were be been being am do does did done have has had will would ' +
    "can could should may might must shall not no yes it its it's i i'm i've i'd i'll we we're we've we'd we'll you " +
    "you're they they're he she me us them what which who whom whose when where why how there here just also very " +
    'really too quite all any some each every both either neither more most less much many enough get got gets make ' +
    'made makes take took said say says tell told ask asked want wants wanted need needs needed think thought know ' +
    'knew see saw go went going come came give gave try tried call called talk talked plan planned decided offer ' +
    'offered pay paid charge charged sign signed run ran use used start started finish finished book booked meet met ' +
    'send sent find found keep kept let help helps helped work worked look looks looking seem seems feel felt like ' +
    'love hate sure ok okay well right great good bad hi hey hello thanks please quick question still even already ' +
    'now today tomorrow yesterday week since because while until though although thing things stuff something ' +
    'anything everything nothing one lot lots pays month months year years day days hour hours minute minutes ' +
    'time times long ago different same other single whole'
  ).split(' '),
);
const DETERMINERS = new Set([
  'the',
  'a',
  'an',
  'our',
  'my',
  'your',
  'their',
  'this',
  'that',
  'these',
  'those',
]);
const DEFINITE = new Set(['the', 'our', 'my', 'your', 'this', 'that', 'these', 'those']);
const OWN = /\b(?:our|my|ours|mine|ourselves|myself)\b|\b(?:we|i|us|me)\b/gi;

/** The founder's own words as the vEIR says them: "our" → "your", "we" / "I" → "you". */
function yourWords(text: string): string {
  return text.replace(OWN, (word) => {
    const w = word.toLowerCase();
    if (w === 'our' || w === 'my') return 'your';
    if (w === 'ours' || w === 'mine') return 'yours';
    if (w === 'ourselves' || w === 'myself') return 'yourself';
    return 'you';
  });
}

/** The clause after a verb, as a topic: up to the first clause break, at most 10 words, no end punctuation. */
function clause(text: string): string | null {
  const cut = text.split(/[,;:—–]|\s(?:but|because|so|and then|since|though)\s/i)[0] ?? '';
  const words = cut
    .replace(/[.!?…"“”]+$/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 10) return null;
  return yourWords(words.join(' '));
}

interface Phrase {
  readonly text: string;
  readonly score: number;
}

/** The most telling noun phrase of a sentence ("the Hartwell pilot", "a two-week test", "Noor"), or null. */
function nounPhrase(sentence: string): Phrase | null {
  const raw = sentence.split(/\s+/).filter(Boolean);
  let best: Phrase | null = null;
  let i = 0;
  while (i < raw.length) {
    const words: string[] = [];
    let score = 0;
    let determiner: string | null = null;
    let j = i;
    const first = (raw[j] ?? '').replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%']+$/gu, '');
    if (DETERMINERS.has(first.toLowerCase())) {
      determiner = first.toLowerCase();
      words.push(determiner);
      j += 1;
    }
    let content = 0;
    let rejected = false;
    for (; j < raw.length && content < 5; j += 1) {
      const token = raw[j] ?? '';
      const word = token.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%']+$/gu, '');
      const lower = word.toLowerCase();
      if (word === '' || BREAKERS.has(lower) || S_VERBS.has(lower) || DETERMINERS.has(lower)) break;
      if (/^(?:her|his|him|she|he)$/.test(lower)) {
        rejected = true;
        break;
      }
      // A past-tense verb ends the phrase ("the student union offered…"), except right after the determiner.
      if (lower.endsWith('ed') && lower.length > 4 && !(determiner !== null && content === 0)) break;
      words.push(word);
      content += 1;
      const capitalised = /^\p{Lu}/u.test(word) && !isEverydayWord(word);
      if (capitalised) score += 2;
      if (topicWords(word).length > 0) score += 1;
      // A phrase ends at the punctuation that ends its last word.
      if (/[,.;:!?)]$/.test(token)) {
        j += 1;
        break;
      }
    }
    if (!rejected && content > 0) {
      if (determiner !== null && DEFINITE.has(determiner)) score += 1;
      const proper = words.some((w) => /^\p{Lu}/u.test(w) && !isEverydayWord(w));
      // Two words that name something ("the Hartwell pilot", "a two-week test"), or a name ("Noor").
      const enough = proper || topicWords(words.join(' ')).length >= 2;
      if (enough && (best === null || score > best.score)) best = { text: yourWords(words.join(' ')), score };
    }
    i = Math.max(j, i + 1);
  }
  return best;
}

/**
 * A yes/no question about a thing ("Should the pilot run in two libraries or three?", "Is a two-week test
 * enough?") as "whether the pilot should run in two libraries or three", "whether a two-week test is enough". The
 * subject is a determiner and up to three words before the next function word or verb; null for other shapes.
 */
function invertedQuestion(sentence: string): string | null {
  const match =
    /^(should|can|could|will|is|are|does|do|was|were)\s+(the|a|an|our|my|this|that|these|those)\s+(.+?)\??$/i.exec(
      sentence,
    );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const words = match[3].split(/\s+/);
  let n = 0;
  while (n < words.length && n < 3 && !BREAKERS.has((words[n] ?? '').toLowerCase().replace(/[^a-z'-]/g, '')))
    n += 1;
  if (n === 0 || n >= words.length) return null;
  const rest = clause(words.slice(n).join(' '));
  if (rest === null) return null;
  const subject = yourWords(`${match[2].toLowerCase()} ${words.slice(0, n).join(' ')}`);
  return `whether ${subject} ${match[1].toLowerCase()} ${rest}`;
}

/** "booked" → "booking", "planned" → "planning", "priced" → "pricing" (null for "agreed" and the like). */
function gerund(pastTense: string): string | null {
  const verb = pastTense.toLowerCase();
  if (!/^[a-z]{3,}ed$/.test(verb) || verb.endsWith('eed')) return null;
  return `${verb.slice(0, -2)}ing`;
}

/**
 * What the founder did or is doing, as an activity: "We booked the auditorium for demo day" → "booking the
 * auditorium for demo day", "We're pricing the Hartwell pilot at $900" → "pricing the Hartwell pilot at $900",
 * "Our goal is ten paying libraries by June" → "your goal of ten paying libraries by June". Null for other shapes.
 */
function doing(sentence: string): LineTopic | null {
  const progressive = /^(?:we|i)(?:'re| are|'m| am|'ve been| have been)\s+([a-z]+ing)\s+(.+)$/i.exec(
    sentence,
  );
  const past = /^(?:we|i)(?: just| finally| already)?\s+([a-z]+ed)\s+(.+)$/i.exec(sentence);
  const goal =
    /^(?:our|my)\s+(goal|plan|aim|target|idea|worry|concern|priority|problem)\s+is\s+(to\s+)?(.+)$/i.exec(
      sentence,
    );
  let text: string | null = null;
  if (progressive?.[1] !== undefined && progressive[2] !== undefined) {
    const rest = clause(progressive[2]);
    if (rest !== null && !BREAKERS.has(progressive[1].toLowerCase()))
      text = `${progressive[1].toLowerCase()} ${rest}`;
  } else if (past?.[1] !== undefined && past[2] !== undefined) {
    const verb = gerund(past[1]);
    const rest = clause(past[2]);
    if (verb !== null && rest !== null) text = `${verb} ${rest}`;
  } else if (goal?.[1] !== undefined && goal[3] !== undefined) {
    const rest = clause(goal[3]);
    if (rest !== null) text = `your ${goal[1].toLowerCase()} ${goal[2] === undefined ? 'of' : 'to'} ${rest}`;
  }
  return text === null || topicWords(text).length < 2
    ? null
    : { text, question: false, score: 3 + topicWords(text).length };
}

/** What a founder line was about, summarised as the vEIR can say it; `question` when it asked something. */
export interface LineTopic {
  readonly text: string;
  readonly question: boolean;
  /** How telling it is (higher is better). */
  readonly score: number;
}

const LEAD_IN =
  /^(?:(?:so|and|but|ok|okay|hey|hi|hello|well|also|actually|quick one|quick question|one more thing)\b[\s,.!:;-]*)+/i;

/**
 * The topic of a founder line, summarised, never quoted (see the module comment): a yes/no question becomes
 * "whether to …" / "whether you …", a "how / what should we …" question "how to …", a decision or a plan "your
 * decision to …" / "your plan to …", anything else its most telling noun phrase. Null when nothing names a topic.
 */
export function topicOf(line: string): LineTopic | null {
  const sentences = line
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/);
  let best: LineTopic | null = null;
  for (const raw of sentences) {
    const sentence = raw.replace(LEAD_IN, '').trim();
    if (topicWords(sentence).length === 0) continue;
    let found: LineTopic | null = null;
    const yesNo = /^(should|shall|can|could|do|would)\s+(?:we|i)\s+(.+?)\??$/i.exec(sentence);
    const wh =
      /^(how|what|which|when|where|who)\s+(?:should|do|can|could|would|shall)\s+(?:we|i)\s+(.+?)\??$/i.exec(
        sentence,
      );
    const decided = /^(?:we|i)(?:'ve| have)?\s+(?:decided|chose|agreed)\s+to\s+(.+)$/i.exec(sentence);
    const planned =
      /^(?:we|i)(?:'re| are|'m| am)?\s+(?:planning|going|hoping|trying|aiming|about)\s+to\s+(.+)$/i.exec(
        sentence,
      ) ?? /^(?:we|i)\s+(?:plan|want|need|have|hope|intend|will|'ll)\s+(?:to\s+)?(.+)$/i.exec(sentence);
    const inverted = invertedQuestion(sentence);
    if (inverted !== null) {
      found = { text: inverted, question: true, score: 4 + topicWords(inverted).length };
    } else if (yesNo?.[1] !== undefined && yesNo[2] !== undefined) {
      const rest = clause(yesNo[2]);
      const verb = yesNo[1].toLowerCase();
      if (rest !== null && verb !== 'would') {
        const lead =
          verb === 'should' || verb === 'shall'
            ? 'whether to'
            : verb === 'do'
              ? 'whether you'
              : 'whether you can';
        found = { text: `${lead} ${rest}`, question: true, score: 4 + topicWords(rest).length };
      }
    } else if (wh?.[1] !== undefined && wh[2] !== undefined) {
      const rest = clause(wh[2]);
      if (rest !== null)
        found = {
          text: `${wh[1].toLowerCase()} to ${rest}`,
          question: true,
          score: 4 + topicWords(rest).length,
        };
    } else if (decided?.[1] !== undefined) {
      const rest = clause(decided[1]);
      if (rest !== null)
        found = { text: `your decision to ${rest}`, question: false, score: 4 + topicWords(rest).length };
    } else if (planned?.[1] !== undefined) {
      const rest = clause(planned[1]);
      if (rest !== null)
        found = { text: `your plan to ${rest}`, question: false, score: 3 + topicWords(rest).length };
    } else {
      found = doing(sentence);
    }
    if (found === null) {
      const phrase = nounPhrase(sentence);
      if (phrase !== null) found = { text: phrase.text, question: false, score: phrase.score };
    }
    if (found !== null && found.text.length <= 70 && (best === null || found.score > best.score))
      best = found;
  }
  return best;
}
