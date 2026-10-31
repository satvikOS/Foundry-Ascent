/**
 * The database round trips a spoken turn waits for one after another, before its stream opens and before its first
 * spoken unit (docs/runbooks/latency.md, "Round trips before the stream and the first spoken unit"), pinned. On the RDS
 * Data API each statement, begin and commit is an HTTPS call (~65 ms in production), and they are what a turn waits
 * for before the founder hears anything: a change that adds one to the way fails here. A change that removes one
 * lowers the pinned number (and says so in the runbook).
 *
 * The whole API runs over a fresh seeded database with every round trip delayed (a test driver wrapper records when
 * each was sent and answered, `perf/rig.ts`), and the model and the embedding answering at once, so nothing but the
 * database stands between the request and its first spoken unit (`perf/critical-path.ts`). Calls with and without a
 * FULL face (a fake vendor voicing the admitted text: each unit is admitted to it before it is sent).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sequentialOf, type SequentialSample } from './critical-path.js';
import { createLatencyRig, QUICK_PREFIX, type LatencyRig } from './rig.js';
import { newConversation, startCall, turn } from './scenarios.js';
import { type SimulatedLatency } from './simulation.js';

/**
 * Long enough that a turn's own work between two round trips never outlasts one, even on a loaded machine: a commit
 * nobody waits for that ended before the next round trip was sent would count as one more.
 */
const ROUND_TRIP_MS = 100;

const LATENCY: SimulatedLatency = {
  dbRoundTripMs: ROUND_TRIP_MS,
  modelFirstTokenMs: 0,
  modelWordMs: 0,
  structuredMs: 0,
  embedMs: 0,
  speechFirstByteMs: 0,
};

/** Spoken turns of one call (none asks for a one-sentence reply). */
const MESSAGES = [
  'Our pilot at the north campus library starts in two weeks. What should we measure first?',
  'Two of the librarians said the sensors felt intrusive. How do we handle that?',
  'What would make you confident that quiet-space demand is real?',
];

/** A call's turns, in order: the round trips each waited for one after another. */
async function callTurns(rig: LatencyRig): Promise<SequentialSample[]> {
  const cookie = await rig.signIn(rig.founderId);
  const conversation = await newConversation(rig, cookie);
  const { started } = await startCall(rig, cookie, conversation.id);
  const out: SequentialSample[] = [];
  for (const text of MESSAGES) {
    expect(text.startsWith(QUICK_PREFIX)).toBe(false);
    await rig.drain();
    const sample = await turn(rig, { cookie, sessionId: conversation.id, text, callId: started.call.id });
    expect(sample.firstSpeechMs).not.toBeNull();
    out.push(sequentialOf(rig.queries, sample));
  }
  return out;
}

describe.each([
  // Before: 30 to the stream (35 on a call's first turn served by a container that never saw the conversation), 35-36
  // to the first spoken unit, 39 with a FULL face (harness, profile production, the same counting).
  { face: false, streamOpen: 10, firstSpeech: 13 },
  { face: true, streamOpen: 10, firstSpeech: 14 },
])('a spoken turn (FULL face: $face)', ({ face, streamOpen, firstSpeech }) => {
  let rig: LatencyRig;
  let turns: SequentialSample[];

  beforeAll(async () => {
    rig = await createLatencyRig(LATENCY, { traceQueries: true, face });
    turns = await callTurns(rig);
  }, 180_000);
  afterAll(async () => {
    await rig.cleanup();
  });

  it(`waits for ${String(streamOpen)} round trips before its stream opens and ${String(firstSpeech)} before its first spoken unit`, () => {
    expect(turns.map((t) => ({ streamOpen: t.streamOpen, firstSpeech: t.firstSpeech }))).toEqual(
      MESSAGES.map(() => ({ streamOpen, firstSpeech })),
    );
  });
});
