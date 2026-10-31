/**
 *   pnpm --filter @foundry/api latency [--profile production|local] [--text N] [--voice N] [--json file]
 *                                      [--duplicate-memory N] [--gap-ms N] [--set dbRoundTripMs=45 …] [--cold]
 *                                      [--queries] [--skip-init-warm-up] [--face]
 *
 * The local latency harness (docs/runbooks/latency.md): the whole API in one process over a fresh seeded
 * database on the local cluster, with production-like latency added at the far ends (database round trips,
 * model, embedding, speech; `perf/simulation.ts`). Runs a founder's flow (sign in, open the venture, type
 * N messages, start a call and talk N times) and prints a Markdown table of the client's and the server's
 * stage timings. `--json` also writes the raw samples. `--gap-ms` waits between turns as a person paces a call
 * (LAB-P2: browser call turns were about ten seconds apart). `--cold` skips the warm-up conversation, so the first turn
 * measured is the first this process serves, as a lab run's first turn is (the turn engine's first-run cost,
 * orchestrator/warm-up.ts); with `--text 0` that turn is the call's first. Nothing here needs AWS, so connection reuse
 * to AWS is reported (`turn.timing` awsConnectionsOpened/awsConnectionsReused) but only a deployed run can show its
 * effect. `--queries` also prints, for each measured turn, the database round trips made before its model call started,
 * by statement (which of a turn's round trips a call could load once: docs/runbooks/latency.md), and the round trips
 * each turn waited for one after another before its stream opened and before its first spoken unit, read on a second
 * run of the same turns with the model's and the embedding's time set to zero (`perf/critical-path.ts`).
 * `--skip-init-warm-up` measures a process that did not warm the turn engine when it started (runtime/warm-up.ts).
 * `--face` gives calls a FULL face (a fake vendor): each spoken unit is admitted to it as it is signed.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { sequentialOf, type SequentialSample } from '../perf/critical-path.js';
import { createLatencyRig, type LatencyRig, type TracedRoundTrip } from '../perf/rig.js';
import { markdownReport, reportRows, summarize } from '../perf/report.js';
import { runScenario } from '../perf/scenarios.js';
import { LATENCY_PROFILES, type LatencyProfileName, type SimulatedLatency } from '../perf/simulation.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'production' },
      text: { type: 'string', default: '8' },
      voice: { type: 'string', default: '8' },
      json: { type: 'string' },
      label: { type: 'string' },
      'duplicate-memory': { type: 'string', default: '0' },
      'gap-ms': { type: 'string', default: '0' },
      // No warm-up conversation: the first turn is the process's first (docs/runbooks/latency.md).
      cold: { type: 'boolean', default: false },
      // Each measured turn's round trips before its model call, by statement.
      queries: { type: 'boolean', default: false },
      // No process-start warm-up of the turn engine (the API Lambda's init and the dev server run one).
      'skip-init-warm-up': { type: 'boolean', default: false },
      // Calls get a FULL face (a fake vendor that voices the admitted text).
      face: { type: 'boolean', default: false },
      // One simulated latency changed from the profile's (calibration): `--set modelFirstTokenMs=1800`.
      set: { type: 'string', multiple: true, default: [] },
    },
  });
  const profile = values.profile as LatencyProfileName;
  if (!(profile in LATENCY_PROFILES)) throw new Error(`unknown profile ${values.profile}`);
  const settings: Record<string, number> = { ...LATENCY_PROFILES[profile] };
  for (const pair of values.set) {
    const [key = '', value = ''] = pair.split('=');
    if (!(key in settings) || !/^\d+$/.test(value))
      throw new Error(`--set ${pair}: unknown setting or value`);
    settings[key] = Number(value);
  }
  const latency = settings as unknown as SimulatedLatency;
  const rig = await createLatencyRig(latency, {
    duplicateMemory: Number(values['duplicate-memory']),
    traceQueries: values.queries,
    skipInitWarmUp: values['skip-init-warm-up'],
    face: values.face,
  });
  try {
    // A warm-up conversation first: caches (keys, directory, sessions) fill as they do on a warm Lambda.
    if (!values.cold) await runScenario(rig, { textTurns: 1, voiceTurns: 1 });
    const measuredFrom = rig.queries.length;
    const result = await runScenario(rig, {
      textTurns: Number(values.text),
      voiceTurns: Number(values.voice),
      turnGapMs: Number(values['gap-ms']),
    });
    const label = values.label ?? `Profile ${profile}`;
    process.stdout.write(`${markdownReport(reportRows(result), latency, label)}\n`);
    let sequential: SequentialSample[] = [];
    if (values.queries) {
      process.stdout.write(`${queryReport(rig.queries.slice(measuredFrom))}\n`);
      sequential = await sequentialPass(rig, Number(values.text), Number(values.voice));
      process.stdout.write(`${sequentialReport(sequential, latency)}\n`);
    }
    if (values.json !== undefined)
      writeFileSync(values.json, JSON.stringify({ latency, result, sequential }, null, 2));
  } finally {
    await rig.cleanup();
  }
}

/**
 * The same turns again with the model's and the embedding's time at zero (the database round trip unchanged): the
 * round trips each turn waited for one after another (`perf/critical-path.ts` says why the other waits are zeroed).
 */
async function sequentialPass(
  rig: LatencyRig,
  textTurns: number,
  voiceTurns: number,
): Promise<SequentialSample[]> {
  const saved = { ...rig.latency };
  rig.latency.modelFirstTokenMs = 0;
  rig.latency.modelWordMs = 0;
  rig.latency.structuredMs = 0;
  rig.latency.embedMs = 0;
  try {
    const from = rig.queries.length;
    const run = await runScenario(rig, { textTurns, voiceTurns });
    const queries = rig.queries.slice(from);
    return run.turns.map((t) => sequentialOf(queries, t));
  } finally {
    Object.assign(rig.latency, saved);
  }
}

function sequentialReport(samples: readonly SequentialSample[], latency: SimulatedLatency): string {
  const out = [
    `### Round trips waited for one after another (database round trip ${String(latency.dbRoundTripMs)} ms; model and embedding at 0)`,
    '',
    '| Turn | Channel | To the stream opening | To the first sentence | To the first spoken unit |',
    '| ---: | --- | ---: | ---: | ---: |',
  ];
  samples.forEach((s, i) => {
    out.push(
      `| ${String(i + 1)} | ${s.channel} | ${String(s.streamOpen)} | ${String(s.firstDelta ?? '')} | ${String(s.firstSpeech ?? '')} |`,
    );
  });
  for (const channel of ['text', 'voice'] as const) {
    const of = samples.filter((s) => s.channel === channel);
    if (of.length === 0) continue;
    const p50 = (values: (number | null)[]): string => String(summarize(values)?.p50 ?? '');
    out.push(
      '',
      `${channel}, p50: stream opening ${p50(of.map((s) => s.streamOpen))}, first sentence ${p50(of.map((s) => s.firstDelta))}, first spoken unit ${p50(of.map((s) => s.firstSpeech))}`,
    );
  }
  return out.join('\n');
}

/** Each turn's round trips before its model call started, by statement (most first). */
function queryReport(queries: readonly TracedRoundTrip[]): string {
  const turns = new Map<object, TracedRoundTrip[]>();
  for (const query of queries) {
    if (query.request === null || query.path?.endsWith('/turns') !== true || !query.beforeModel) continue;
    const list = turns.get(query.request) ?? [];
    list.push(query);
    turns.set(query.request, list);
  }
  const out: string[] = [];
  let index = 0;
  for (const list of turns.values()) {
    index += 1;
    const total = list.reduce((sum, q) => sum + q.roundTrips, 0);
    out.push(`### Turn ${String(index)}: ${String(total)} round trips before the model call`, '');
    out.push('| Round trips | Statement |', '| ---: | --- |');
    const by = new Map<string, number>();
    for (const q of list) {
      const key = q.sql.slice(0, 140);
      by.set(key, (by.get(key) ?? 0) + q.roundTrips);
    }
    for (const [sql, count] of [...by.entries()].sort((a, b) => b[1] - a[1]))
      out.push(`| ${String(count)} | \`${sql.replaceAll('|', '\\|')}\` |`);
    out.push('');
  }
  return out.join('\n');
}

main().catch((err: unknown) => {
  console.error('latency harness failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
