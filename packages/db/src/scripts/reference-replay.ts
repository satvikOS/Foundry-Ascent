/**
 * Replays the student turns of opened conversation-lab outputs through the reference library's relevance gate and
 * prints rates only (never a word of a transcript): how many turns, and how many runs, would get a reference
 * passage, as a turn would (the founder's own message; one call turn at most one item; an item already cited in the
 * conversation not again), and how many of them came in context, unasked (coaching v3: an item the message and the
 * founder's last messages, or the venture's own words, both name, at most one every `REFERENCE_GATE.contextGapTurns`
 * turns after any reference).
 *
 * Two rates are printed: `founderWordsOnly` (the founder's messages alone) and `withVenture` (as production runs it:
 * the venture's one-liner and current goal corroborate too, `run-turn.ts`). The venture of a run is read from the lab's
 * seed plan beside the run files (`logs/live-seed-plan.json`: each scenario's seeded one-liner and goal); a run whose
 * venture is not there counts in both with its founder's words only, and `runsWithVenture` says how many had one.
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

/**
 * The gate's outcome over `runs`, as coaching turns would see it. `ventures[i]` is run i's venture in its own words
 * (its one-liner and current goal, as a turn passes them), or null.
 */
export function replayRates(
  runs: readonly ReplayRun[],
  ventures: readonly (string | null)[] = [],
): ReplayRates {
  let turns = 0;
  let turnsWithReference = 0;
  let contextualTurns = 0;
  let passages = 0;
  let runsWithReference = 0;
  let worstRunShare = 0;
  for (const [r, run] of runs.entries()) {
    const venture = ventures[r] ?? null;
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
          shown = selectContextualReference(turn.student, {
            earlierFounderTexts: earlier,
            venture,
          }).matches.filter((m) => !cited.has(m.key));
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
  run_id: z.string().nullish(),
  transcript: z.array(
    z.object({
      channel: z.string().nullish(),
      turns: z.array(z.object({ student: z.string().nullish() })),
    }),
  ),
});

function asRun(value: unknown): { readonly id: string | null; readonly run: ReplayRun } | null {
  const parsed = RunFile.safeParse(value);
  if (!parsed.success) return null;
  return {
    id: parsed.data.run_id ?? null,
    run: parsed.data.transcript.map((session) =>
      session.turns
        .map((t) => t.student ?? '')
        .filter((student) => student.trim() !== '')
        .map((student) => ({ student, channel: session.channel === 'call' ? 'voice' : 'text' })),
    ),
  };
}

/** The lab's seed plan: each scenario's seeded venture (`ops/lab/conversation_lab/live`, `live-seed-plan.json`). */
const SeedPlan = z.array(
  z.looseObject({ key: z.string(), oneLiner: z.string().nullish(), goal: z.string().nullish() }),
);

/** A seeded venture in its own words, as a turn passes them (`run-turn.ts`: the one-liner, then the current goal). */
export function ventureWords(entry: {
  readonly oneLiner?: string | null;
  readonly goal?: string | null;
}): string | null {
  return (
    [entry.oneLiner, entry.goal]
      .map((t) => (t ?? '').trim())
      .filter((t) => t !== '')
      .join('. ') || null
  );
}

function rounded(rates: ReplayRates) {
  const share = rates.turns === 0 ? 0 : rates.turnsWithReference / rates.turns;
  return {
    ...rates,
    turnShare: Number(share.toFixed(4)),
    worstRunShare: Number(rates.worstRunShare.toFixed(4)),
  };
}

async function main(dirs: readonly string[]): Promise<number> {
  if (dirs.length === 0) {
    process.stderr.write('usage: reference-replay <opened-dir> [<opened-dir>…]\n');
    return 2;
  }
  const runs: ReplayRun[] = [];
  const ids: (string | null)[] = [];
  const seeded = new Map<string, string | null>();
  for (const dir of dirs) {
    for (const file of await jsonFiles(dir)) {
      try {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'));
        const plan = file.endsWith('live-seed-plan.json') ? SeedPlan.safeParse(value) : null;
        if (plan?.success === true) {
          for (const entry of plan.data) seeded.set(entry.key.toLowerCase(), ventureWords(entry));
          continue;
        }
        const run = asRun(value);
        if (run !== null) {
          runs.push(run.run);
          ids.push(run.id);
        }
      } catch {
        // Not a run file.
      }
    }
  }
  const ventures = ids.map((id) => (id === null ? null : (seeded.get(id.toLowerCase()) ?? null)));
  process.stdout.write(
    `${JSON.stringify({
      runsWithVenture: ventures.filter((v) => v !== null).length,
      founderWordsOnly: rounded(replayRates(runs)),
      withVenture: rounded(replayRates(runs, ventures)),
    })}\n`,
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
