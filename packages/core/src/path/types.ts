import type { PathCriterion, Play, PlaySource, VentureStage } from '@foundry/contracts';

/** One kind of ask a founder makes, and the play that answers it. */
export interface PathIntent {
  readonly id: string;
  readonly playId: string;
  /** Phrases that ask it, as students write or say them; matched on normalised words (see the engine). */
  readonly phrases: readonly string[];
  /** Words that make it another ask ("price" in "price of the conference ticket"). */
  readonly unless?: readonly string[];
  /** A qualified person must decide: wins over every other ask. */
  readonly referral?: boolean;
  /**
   * Asks where they are and what comes next ("get me organized", "what next"): the step is the path's own, never the
   * play's. `path`: where this venture stands is the answer; `play`: the play's answer stands, at its own stage.
   */
  readonly overview?: 'path' | 'play';
  /**
   * Said in passing ("my advisor is on the paper"): who to see comes with the reply, whatever they ask; the step stays
   * what it would have been.
   */
  readonly note?: boolean;
  /** A push for more keeps this answer ("just a hint"), as it keeps a referral. */
  readonly holds?: boolean;
}

export interface PlaybookStage {
  readonly stage: VentureStage;
  readonly title: string;
  readonly goal: string;
}

/** Everything the path engine decides from; data only (`playbook/`). */
export interface Playbook {
  readonly version: string;
  readonly stages: readonly PlaybookStage[];
  readonly criteria: readonly PathCriterion[];
  readonly plays: readonly Play[];
  readonly intents: readonly PathIntent[];
  readonly sources: readonly PlaySource[];
}
