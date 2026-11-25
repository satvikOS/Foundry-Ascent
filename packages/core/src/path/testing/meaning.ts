import { type retrievalRepo } from '@foundry/db';

import { nearestAsks } from '../match.js';
import { type Playbook } from '../types.js';

/** A model id with constants of its own (`PLAY_MATCH_PROFILES`): what a test's scores are said to be of. */
export const TEST_MODEL = 'amazon.titan-embed-text-v2:0';

/**
 * An embedding model that reads as well as a person told the playbook would (tests of what follows a match, never of the
 * matching): near the play whose phrases the message shares telling words with, and near nothing when it shares none.
 */
export function meaningOfTest(playbook: Playbook, message: string): retrievalRepo.NearPlays {
  const near = nearestAsks(playbook, message, (i) => i.note !== true);
  const [first, second] = near;
  const plain =
    first !== undefined &&
    ((first.likeness >= 0.36 && first.evidence >= 3.4) ||
      (first.likeness >= 0.35 && first.shared >= 3) ||
      (first.likeness >= 0.5 && first.shared >= 2));
  if (!plain) return { modelId: TEST_MODEL, plays: [{ playId: first?.intent.playId ?? 'none', score: 0.1 }] };
  return {
    modelId: TEST_MODEL,
    plays: [
      { playId: first.intent.playId, score: 0.9 },
      ...(second === undefined ? [] : [{ playId: second.intent.playId, score: 0.5 }]),
    ],
  };
}
