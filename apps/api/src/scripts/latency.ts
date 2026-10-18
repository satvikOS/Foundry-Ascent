/**
 *   pnpm --filter @foundry/api latency [--profile production|local] [--text N] [--voice N] [--json file]
 *                                      [--duplicate-memory N] [--gap-ms N] [--set dbRoundTripMs=45 …]
 *
 * The local latency harness (docs/runbooks/latency.md): the whole API in one process over a fresh seeded
 * database on the local cluster, with production-like latency added at the far ends (database round trips,
 * model, embedding, speech; `perf/simulation.ts`). Runs a founder's flow (sign in, open the venture, type
 * N messages, start a call and talk N times) and prints a Markdown table of the client's and the server's
 * stage timings. `--json` also writes the raw samples. `--gap-ms` waits between turns as a person paces a call
 * (LAB-P2: browser call turns were about ten seconds apart). Nothing here needs AWS, so connection reuse to AWS is
 * reported (`turn.timing` awsConnectionsOpened/awsConnectionsReused) but only a deployed run can show its effect.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { createLatencyRig } from '../perf/rig.js';
import { markdownReport, reportRows } from '../perf/report.js';
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
  const rig = await createLatencyRig(latency, { duplicateMemory: Number(values['duplicate-memory']) });
  try {
    // A warm-up conversation first: caches (keys, directory, sessions) fill as they do on a warm Lambda.
    await runScenario(rig, { textTurns: 1, voiceTurns: 1 });
    const result = await runScenario(rig, {
      textTurns: Number(values.text),
      voiceTurns: Number(values.voice),
      turnGapMs: Number(values['gap-ms']),
    });
    const label = values.label ?? `Profile ${profile}`;
    process.stdout.write(`${markdownReport(reportRows(result), latency, label)}\n`);
    if (values.json !== undefined) writeFileSync(values.json, JSON.stringify({ latency, result }, null, 2));
  } finally {
    await rig.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error('latency harness failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
