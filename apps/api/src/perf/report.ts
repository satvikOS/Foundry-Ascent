import { type ScenarioResult, type TurnSample } from './scenarios.js';
import { type SimulatedLatency } from './simulation.js';

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentiles of the non-null values (null when there are none). */
export function summarize(values: readonly (number | null | undefined)[]): Summary | null {
  const xs = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = (p: number): number =>
    xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))] ?? 0;
  return { n: xs.length, p50: rank(0.5), p95: rank(0.95), max: xs[xs.length - 1] ?? 0 };
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** One row per metric: where it is measured, and its summary. */
export interface ReportRow {
  readonly group: string;
  readonly metric: string;
  readonly summary: Summary | null;
}

function turnRows(group: string, turns: readonly TurnSample[]): ReportRow[] {
  const server = (key: string) => turns.map((t) => num(t.server?.[key]));
  const speech = (key: string) => turns.map((t) => num(t.speech?.[key]));
  const rows: [string, (number | null)[]][] = [
    ['client: response headers', turns.map((t) => t.headersMs)],
    ['client: turn.accepted', turns.map((t) => t.acceptedMs)],
    ['client: first sentence (turn.delta)', turns.map((t) => t.firstDeltaMs)],
    ['client: first spoken unit (turn.speech)', turns.map((t) => t.firstSpeechMs)],
    ['client: first audio bytes', turns.map((t) => t.firstAudioMs)],
    ['client: last spoken unit', turns.map((t) => t.lastSpeechMs)],
    ['client: completed', turns.map((t) => t.completedMs)],
    ['server: auth', server('authMs')],
    ['server: accepted (auth + preflight + admission)', server('acceptedMs')],
    ['server: admission transaction', server('admissionMs')],
    ['server: retrieval (embedding wait + queries)', server('retrievalMs')],
    ['server: embedding call', server('embedMs')],
    ['server: prompt build', server('promptMs')],
    ['server: model start', server('modelStartMs')],
    ['server: model first token', server('modelFirstTokenMs')],
    ['server: first sentence (turn.delta)', server('firstDeltaMs')],
    ['server: first spoken unit (turn.speech)', server('firstSpeechMs')],
    ['server: generation (stream + annotations)', server('generationMs')],
    ['server: finish (validate + persist)', server('finishMs')],
    ['server: total', server('totalMs')],
    ['server: database round trips', server('dbRoundTrips')],
    ['server: database wait', server('dbWaitMs')],
    ['speech: first unit planned (cumulative)', speech('plannedMs')],
    ['speech: first unit reserved (cumulative)', speech('reservedMs')],
    ['speech: first unit synthesized (cumulative)', speech('synthesizedMs')],
    ['speech: first unit first audio (cumulative)', speech('firstAudioMs')],
    ['prompt: evidence items', turns.map((t) => t.evidenceItems)],
    ['prompt: evidence block (tokens, estimate)', turns.map((t) => t.evidenceTokens)],
    ['prompt: reply call input (tokens, estimate)', turns.map((t) => t.inputTokens)],
  ];
  return rows.map(([metric, values]) => ({ group, metric, summary: summarize(values) }));
}

/** Every metric of a scenario run (rows without data are left out). */
export function reportRows(result: ScenarioResult): ReportRow[] {
  const rows: ReportRow[] = [
    ...turnRows(
      'typed turn',
      result.turns.filter((t) => t.channel === 'text'),
    ),
    ...turnRows(
      'voice turn',
      result.turns.filter((t) => t.channel === 'voice'),
    ),
    ...turnRows(
      'voice turn, one-sentence reply',
      result.turns.filter((t) => t.channel === 'voice' && t.units === 1),
    ),
  ];
  const names = [...new Set(result.requests.map((r) => r.name))];
  for (const name of names) {
    const samples = result.requests.filter((r) => r.name === name);
    rows.push({
      group: name,
      metric: 'client: headers',
      summary: summarize(samples.map((s) => s.headersMs)),
    });
    rows.push({ group: name, metric: 'client: body', summary: summarize(samples.map((s) => s.bodyMs)) });
    rows.push({
      group: name,
      metric: 'server: database round trips',
      summary: summarize(samples.map((s) => num(s.server?.dbRoundTrips))),
    });
  }
  return rows.filter((r) => r.summary !== null);
}

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(0));

/** A Markdown table of the rows, with the simulated latencies it ran under. */
export function markdownReport(rows: readonly ReportRow[], latency: SimulatedLatency, label: string): string {
  const lines = [
    `### ${label}`,
    '',
    `Simulated: database round trip ${String(latency.dbRoundTripMs)} ms, model first token ${String(latency.modelFirstTokenMs)} ms then ${String(latency.modelWordMs)} ms per word, structured call ${String(latency.structuredMs)} ms, embedding ${String(latency.embedMs)} ms, speech first byte ${String(latency.speechFirstByteMs)} ms.`,
    '',
    '| Flow | Metric | n | p50 | p95 | max |',
    '| ---- | ------ | -: | --: | --: | --: |',
  ];
  for (const row of rows) {
    const s = row.summary;
    if (s === null) continue;
    lines.push(
      `| ${row.group} | ${row.metric} | ${String(s.n)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} |`,
    );
  }
  return lines.join('\n');
}
