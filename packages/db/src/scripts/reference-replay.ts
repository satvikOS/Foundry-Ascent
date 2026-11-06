/**
 * Replays the student turns of opened conversation-lab outputs through the reference library's relevance gate and
 * prints rates only (never a word of a transcript): how many turns, and how many runs, would get a reference
 * passage, as a turn would (the founder's own message; one call turn at most one item; an item already cited in the
 * conversation not again), and how many of them came in context, unasked (coaching v3: an item the message and the
 * founder's last messages both name, at most one every `REFERENCE_GATE.contextGapTurns` turns after any reference;
 * the venture's own words are not in a run file, so production can offer a little more than this counts).
 *
 *   pnpm --filter @foundry/db exec tsx src/scripts/reference-replay.ts <opened-dir> [<opened-dir>…]
 *
 * `<opened-dir>` is what `apps/api/src/scripts/lab-seal.ts open` restored from a `live-evals-sealed-*` artifact
 * (run JSON files with a `transcript` of sessions, `chat` or `call`, and their turns; `ops/lab/conversation_lab/live/runner.py`).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { CONTEXT_TURNS, selectContextualReference, selectReferences } from '../knowledge-pack/gate.js';
import { REFERENCE_GATE } from '../repositories/retrieval.js';

interface ReplayTurn {
  readonly student: string;
  readonly channel: string;
}

/** One run: its conversations, each a list of student turns in order. */
export type ReplayRun = readonly (readonly ReplayTurn[])[];

export interface ReplayRates {
  readonly runs: number;
  readonly turns: number;
  readonly turnsWithReference: number;
  /** Of `turnsWithReference`, the turns whose reference came in context, unasked. */
  readonly contextualTurns: number;
  readonly passages: number;
  readonly runsWithReference: number;
  /** The highest share of one run's turns that got a reference. */
  readonly worstRunShare: number;
}

/** The gate's outcome over `runs`, as coaching turns would see it. */
export function replayRates(runs: readonly ReplayRun[]): ReplayRates {
  let turns = 0;
  let turnsWithReference = 0;
  let contextualTurns = 0;
  let passages = 0;
  let runsWithReference = 0;
  let worstRunShare = 0;
  for (const run of runs) {
    let runTurns = 0;
    let runHits = 0;
    for (const conversation of run) {
      const cited = new Set<string>();
      // The index of the last turn that showed a reference passage (the database's `recent_ref`).
      let lastShown = Number.NEGATIVE_INFINITY;
      conversation.forEach((turn, i) => {
        runTurns += 1;
        const limit = turn.channel === 'text' ? REFERENCE_GATE.limit : 1;
        // As the database does: the gate's selection, without an item already cited in the conversation.
        let shown = selectReferences(turn.student, { limit }).matches.filter((m) => !cited.has(m.key));
        const asked = shown.length > 0;
        if (!asked && i - lastShown > REFERENCE_GATE.contextGapTurns) {
          const earlier = conversation
            .slice(Math.max(0, i - CONTEXT_TURNS), i)
            .map((t) => t.student)
            .reverse();
          shown = selectContextualReference(turn.student, { earlierFounderTexts: earlier }).matches.filter(
            (m) => !cited.has(m.key),
          );
          if (shown.length > 0) contextualTurns += 1;
        }
        for (const m of shown) cited.add(m.key);
        if (shown.length > 0) {
          runHits += 1;
          lastShown = i;
        }
        passages += shown.length;
      });
    }
    turns += runTurns;
    turnsWithReference += runHits;
    if (runHits > 0) runsWithReference += 1;
    if (runTurns > 0) worstRunShare = Math.max(worstRunShare, runHits / runTurns);
  }
  return {
    runs: runs.length,
    turns,
    turnsWithReference,
    contextualTurns,
    passages,
    runsWithReference,
    worstRunShare,
  };
}

async function jsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonFiles(path)));
    else if (entry.name.endsWith('.json')) out.push(path);
  }
  return out;
}

/** A lab run file as far as this needs it (`RunResult.private()`: sessions with their channel and turns). */
const RunFile = z.object({
  transcript: z.array(
    z.object({
      channel: z.string().nullish(),
      turns: z.array(z.object({ student: z.string().nullish() })),
    }),
  ),
});

function asRun(value: unknown): ReplayRun | null {
  const parsed = RunFile.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.transcript.map((session) =>
    session.turns
      .map((t) => t.student ?? '')
      .filter((student) => student.trim() !== '')
      .map((student) => ({ student, channel: session.channel === 'call' ? 'voice' : 'text' })),
  );
}

async function main(dirs: readonly string[]): Promise<number> {
  if (dirs.length === 0) {
    process.stderr.write('usage: reference-replay <opened-dir> [<opened-dir>…]\n');
    return 2;
  }
  const runs: ReplayRun[] = [];
  for (const dir of dirs) {
    for (const file of await jsonFiles(dir)) {
      try {
        const run = asRun(JSON.parse(await readFile(file, 'utf8')));
        if (run !== null) runs.push(run);
      } catch {
        // Not a run file.
      }
    }
  }
  const rates = replayRates(runs);
  const share = rates.turns === 0 ? 0 : rates.turnsWithReference / rates.turns;
  process.stdout.write(
    `${JSON.stringify({ ...rates, turnShare: Number(share.toFixed(4)), worstRunShare: Number(rates.worstRunShare.toFixed(4)) })}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
