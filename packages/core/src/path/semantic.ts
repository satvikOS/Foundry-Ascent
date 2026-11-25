import { type Play } from '@foundry/contracts';
import { type knowledgePack, type retrievalRepo } from '@foundry/db';

import { firstSentence } from './brief.js';
import { isAnotherAsk } from './match.js';
import { playOf } from './steps.js';
import { type PathIntent, type Playbook } from './types.js';

/**
 * The second stage of matching: the play a message means when no phrase of the playbook names one (match.ts), by the
 * embedding of the founder's own words against what founders ask each play for (`knowledge-pack/play-asks.ts`). Pure: the
 * same scores always give the same play. docs/architecture/founder-path.md, "By meaning".
 */
export interface PlayMatchProfile {
  /** Cosine similarity from which the nearest play is what they ask. */
  readonly floor: number;
  /** How much nearer it must be than the next play: two about equally near say neither. */
  readonly margin: number;
  /** The floor of a play that sends them to a person: a wrong one costs more than none. */
  readonly referralFloor: number;
  /** Added to the floors of a message that is no plain first question ({@link Openness}). */
  readonly guard: number;
}

/**
 * Every constant of the matching, by embedding model (similarities of two models are not comparable). A model without a
 * row (the deterministic embedding of tests and local development is one: only shared words make texts similar there)
 * cannot be asked: the nearest words stand in, held to much more (match.ts).
 *
 * UNCALIBRATED starting values (2026-11-24), strict on purpose: a message left to the rules costs what it costs today,
 * a wrong play answers a question nobody asked. The models benchmark prints the pair that its messages suggest for each
 * model (docs/runbooks/conversation-lab.md, "Models benchmark"); set it here.
 */
export const PLAY_MATCH_PROFILES: Readonly<Record<string, PlayMatchProfile>> = {
  'amazon.titan-embed-text-v2:0': { floor: 0.5, margin: 0.06, referralFloor: 0.58, guard: 0.08 },
  'cohere.embed-v4:0': { floor: 0.55, margin: 0.05, referralFloor: 0.62, guard: 0.07 },
};

/** The constants of `modelId` (a cross-Region inference profile has its model's); null: it matches nothing. */
export function playMatchProfile(modelId: string): PlayMatchProfile | null {
  const id = modelId.replace(/^(?:us|eu|apac|global)\./, '');
  return Object.hasOwn(PLAY_MATCH_PROFILES, id) ? (PLAY_MATCH_PROFILES[id] ?? null) : null;
}

/** Plays compared: the nearest, and those it must be nearer than. */
export const PLAY_MATCH_TOP = 3;
/** Longest wait for the message's embedding, in milliseconds; a later one leaves the turn to the rules. */
export const PLAY_MATCH_WAIT_MS = 400;

/**
 * Why a message may be matched by meaning: it asks something at the start (`ask`), or it only may (`guarded`: a
 * statement, a few words, a question while another step is under way).
 */
export type Openness = 'ask' | 'guarded';

export interface SemanticMatch {
  /** The ask's intent; null: no play is near enough, or two are. */
  readonly intent: PathIntent | null;
  /** The similarity of the nearest play; null: there is none. */
  readonly score: number | null;
  /** Who decides, of a referral play that is about as near as any and not the one chosen. */
  readonly referral: Play['referral'];
}

/** The intent a play answers (never one only said in passing). */
export function intentOfPlay(playbook: Playbook, playId: string): PathIntent | null {
  return playbook.intents.find((i) => i.playId === playId && i.note !== true) ?? null;
}

/**
 * What a message means, from the plays it is nearest to: the first when it is near enough ({@link PlayMatchProfile}) and
 * nearer than any other play, else none. A referral play at the floor and about as near as the first that is not chosen
 * still brings its person.
 */
export function pickPlay(
  playbook: Playbook,
  message: string,
  near: retrievalRepo.NearPlays,
  open: Openness,
  /** Other constants, for measurement only (the models benchmark). */
  profile: PlayMatchProfile | null = playMatchProfile(near.modelId),
): SemanticMatch {
  const none: SemanticMatch = { intent: null, score: null, referral: null };
  if (profile === null) return none;
  const plays = near.plays
    .flatMap(({ playId, score }) => {
      const play = playOf(playbook, playId);
      const intent = play === null ? null : intentOfPlay(playbook, play.id);
      // An ask the play's own rules say is another one is another one by meaning too.
      return play === null || intent === null || isAnotherAsk(playbook, intent, message)
        ? []
        : [{ play, intent, score }];
    })
    .sort((a, b) => b.score - a.score || (a.play.id < b.play.id ? -1 : 1))
    .slice(0, PLAY_MATCH_TOP);
  const [first, second] = plays;
  if (first === undefined) return none;
  const guard = open === 'guarded' ? profile.guard : 0;
  const needed = (first.play.referral === null ? profile.floor : profile.referralFloor) + guard;
  const alone = second === undefined || first.score - second.score >= profile.margin;
  if (first.score >= needed && alone) return { intent: first.intent, score: first.score, referral: null };
  const person = plays.find(
    (p) =>
      p.play.referral !== null &&
      p.score >= profile.floor + guard &&
      first.score - p.score < Math.max(profile.margin, Number.EPSILON),
  );
  return { intent: null, score: first.score, referral: person?.play.referral ?? null };
}

/** The phrases of a play's ask are stored in at most this many groups, beside what the play says of itself. */
const PHRASE_GROUPS = 2;

/**
 * What founders ask each play for, as it is embedded: what the play says of itself (its title and the first sentence of
 * its answer) and its intent's phrases in two groups.
 */
export function playAsks(playbook: Playbook): knowledgePack.PlayAsks {
  const asks = playbook.plays.flatMap((play) => {
    const intents = playbook.intents.filter((i) => i.playId === play.id && i.note !== true);
    if (intents.length === 0) return [];
    const phrases = intents.flatMap((i) =>
      i.phrases.map((phrase) => phrase.replace(/\s*(?:\.\.\.|…|\*)\s*/gu, ' ').trim()),
    );
    const size = Math.ceil(phrases.length / PHRASE_GROUPS);
    const groups = Array.from({ length: PHRASE_GROUPS }, (_, g) => phrases.slice(g * size, (g + 1) * size));
    const texts = [
      `${play.title}. ${firstSentence(play.answer)}`,
      ...groups.filter((g) => g.length > 0).map((g) => `${g.join('. ')}.`),
    ];
    return [...new Set(texts)].map((text) => ({ playId: play.id, text }));
  });
  return { version: playbook.version, asks };
}
