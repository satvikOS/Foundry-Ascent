/**
 * The understand call on candidate models (docs/architecture/understand.md; the lab's `understand` suite,
 * docs/runbooks/conversation-lab.md): a turn's own prompt, schema, checks and sums (`prepareUnderstand`,
 * `readParts`) over the cases the lab made of its client scenarios, each case on every candidate before the next case, so a
 * run its budget stops has read the same cases on all of them. A case is the turn's three calls, made at once.
 *
 *   MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1 \
 *   pnpm --filter @foundry/api exec tsx src/scripts/lab-understand.ts --cases FILE --budget-usd 2 --out DIR \
 *     [--candidates id@effort,id] [--concurrency 3] [--typed-ms 3000] [--voice-ms 1700]
 *
 * Candidates are `understand` in ops/lab/models.json. Without MODEL_PROVIDER=bedrock it runs on the mock model's rules (a
 * plumbing check, free). A call is given longer than a turn's budget, so what is late is measured rather than cut off: each
 * case is read with every part, and again with those a turn would have had at the caps (`--typed-ms`, `--voice-ms`).
 * `--budget-usd` is a hard cap: a call is made only when its worst case still fits beside what was spent and what the
 * calls in flight may still cost. Every reading goes to `<DIR>/private/understand-bench.json` (synthetic founders' words:
 * the lab seals it); only counts and codes are printed.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UNDERSTAND_JUDGE_WAIT_MS,
  UNDERSTAND_MAX_OUTPUT_TOKENS,
  UNDERSTAND_PARTS,
  UNDERSTAND_SCHEMAS,
  UNDERSTAND_SCHEMA_NAMES,
  UNDERSTAND_TIMEOUT_MS,
  createModelGateway,
  isModelGatewayError,
  modelGatewayConfigFromEnv,
  readJudge,
  readParts,
  readRoute,
  readSums,
  betterSums,
  sumsAgain,
  sumsDoubt,
  thinksOnRequest,
  type ChatMessage,
  type GenerateStructuredResult,
  type ModelGateway,
  type ModelGatewayConfig,
  type Understanding,
  type UnderstandContext,
  type UnderstandPart,
  type UnderstandReadings,
  type UnderstandReport,
} from '@foundry/ai';
import { PathIntake, VentureDomain, VentureStage } from '@foundry/contracts';
import {
  PLAYBOOK,
  judgeLeads,
  phraseIntent,
  prepareUnderstand,
  type PreparedPart,
  type PreparedUnderstand,
} from '@foundry/core';
import { z } from 'zod';

import { reasoningWorstUsd } from './lab-models.js';

export const CANDIDATES_FILE = fileURLToPath(new URL('../../../../ops/lab/models.json', import.meta.url));

/** One message of a lab scenario, with what its venture's record held then (conversation_lab/understand_bench.py). */
export const Case = z.object({
  id: z.string().regex(/^[A-Z]{2}-\d{2}:\d+\.\d+$/),
  day: z.iso.date(),
  channel: z.enum(['text', 'voice']),
  venture: z.object({
    name: z.string(),
    oneLiner: z.string(),
    stage: VentureStage,
    domain: VentureDomain,
    goal: z.string(),
  }),
  founder: z.string(),
  record: z.array(
    z.object({ type: z.string(), title: z.string(), content: z.string(), daysAgo: z.number().int() }),
  ),
  /** What the founder told in earlier conversations. */
  said: z.array(z.object({ text: z.string(), daysAgo: z.number().int() })),
  intake: PathIntake.partial().nullable(),
  /** The founder's earlier lines of this conversation, with the reply where the case has one. */
  history: z.array(z.union([z.string(), z.object({ founder: z.string(), reply: z.string() })])),
  message: z.string().min(1),
});
export type Case = z.infer<typeof Case>;
const Cases = z.object({ version: z.literal(1), cases: z.array(Case).min(1) });

/** A model at one reasoning effort. */
export interface Arm {
  readonly key: string;
  readonly modelId: string;
  readonly effort: 'none' | 'low' | null;
}
const Candidates = z.object({
  understand: z.array(z.object({ id: z.string(), efforts: z.array(z.enum(['none', 'low'])) })),
});

/** Every arm of the committed candidates, in order: a model with no effort listed has one of its own. */
export function armsOf(raw: unknown): Arm[] {
  return Candidates.parse(raw).understand.flatMap(({ id, efforts }): Arm[] =>
    efforts.length === 0
      ? [{ key: id, modelId: id, effort: null }]
      : efforts.map((effort) => ({ key: `${id}@${effort}`, modelId: id, effort })),
  );
}

/** One call of a case. */
export interface PartRow {
  /** `ok`, `skipped` (a turn would not make it) or the failure's code. */
  readonly code: string;
  readonly ms: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly raw: unknown;
  /** Why SUMS was asked once more. */
  readonly again?: string;
}

export interface Row {
  readonly arm: string;
  readonly caseId: string;
  /** `ok`, `nothing_held` or the first failed part's code. */
  readonly code: string;
  /** When its last part was in. */
  readonly ms: number;
  /** A part came after a turn's budget on its channel. */
  readonly late: boolean;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly parts: Readonly<Record<UnderstandPart, PartRow & { readonly late: boolean }>>;
  /** With every part that came. */
  readonly understanding: Understanding | null;
  /** With the parts a turn would have had in time. */
  readonly inTime: Understanding | null;
  readonly report: UnderstandReport | null;
  /** The category of the play's referral, and the play a phrase of the playbook names for the message. */
  readonly playReferral: string | null;
  readonly phrasePlay: string | null;
}

/** A case as a turn would prepare it. */
export function prepareCase(c: Case): PreparedUnderstand {
  const at = (daysAgo: number): string =>
    new Date(Date.parse(`${c.day}T09:00:00Z`) - daysAgo * 86_400_000).toISOString();
  const item = (type: string, title: string, content: string, daysAgo: number, i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    type,
    title,
    content: content.slice(0, 280),
    attributes: {},
    status: 'confirmed',
    origin: 'founder',
    pinned: false,
    createdAt: at(daysAgo),
  });
  const memory = [
    ...c.record.map((r, i) => item(r.type, r.title, r.content, r.daysAgo, i)),
    ...c.said
      .map((s, i) => item('fact', 'Told earlier', s.text, s.daysAgo, 1_000 + i))
      .map((m, i) => ({
        ...m,
        title: `Told in conversation ${String(i + 1)}`,
      })),
  ];
  const ventureId = '00000000-0000-4000-8000-000000000000';
  return prepareUnderstand({
    playbook: PLAYBOOK,
    ventureId,
    venture: {
      name: c.venture.name,
      stage: c.venture.stage,
      oneLiner: c.venture.oneLiner,
      domain: c.venture.domain,
      currentGoal: c.venture.goal,
    },
    reads: {
      path:
        c.intake === null
          ? null
          : {
              ventureId,
              stage: c.venture.stage,
              intake: PathIntake.parse(c.intake),
              intakeBy: null,
              pivots: [],
              playbookVersion: PLAYBOOK.version,
              version: 1,
            },
      steps: [],
      criteria: [],
      memory,
    },
    continuity: { founderFirstName: c.founder.split(' ')[0] ?? null },
    today: c.day,
    message: c.message,
    history: c.history.map((h) =>
      typeof h === 'string' ? { founderText: h, answer: null } : { founderText: h.founder, answer: h.reply },
    ),
    opener: null,
    channel: c.channel,
  });
}

const charsOf = (p: PreparedPart): number =>
  p.system.length + p.messages.reduce((n, m) => n + m.content.length, 0);

/**
 * The most one case can be billed on an arm, as lab-models.ts bounds a call: each part's input at the dearest rate with a full
 * answer, read again for a repair, and the gateway's fallback (the same model) doing the same.
 */
export function worstUsd(arm: Arm, prepared: PreparedUnderstand): number {
  return UNDERSTAND_PARTS.reduce((sum, name) => sum + partWorstUsd(arm, name, prepared.parts[name]), 0);
}

/** The most one part can be billed on an arm. */
export function partWorstUsd(arm: Arm, name: UnderstandPart, part: PreparedPart | null): number {
  return part === null
    ? 0
    : // SUMS may be asked once more.
      (name === 'sums' ? 2 : 1) *
        reasoningWorstUsd(
          arm.modelId,
          charsOf(part),
          UNDERSTAND_MAX_OUTPUT_TOKENS[part.form],
          arm.effort === 'low' && thinksOnRequest(arm.modelId),
        );
}

/** How long a call may take here: longer than a turn gives it, so a late one is measured. */
export const BENCH_TIMEOUT_MS = 20_000;

const NOT_ASKED: PartRow = {
  code: 'skipped',
  ms: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  raw: null,
};

async function readPart(
  gateway: ModelGateway,
  arm: Arm,
  name: UnderstandPart,
  prepared: PreparedPart | null,
  context: UnderstandContext,
): Promise<PartRow> {
  if (prepared === null) return NOT_ASKED;
  const started = performance.now();
  const took = (): number => Math.round(performance.now() - started);
  const call = (messages: ChatMessage[]): Promise<GenerateStructuredResult<unknown>> =>
    gateway.generateStructured<unknown>({
      // Sampled as a turn is.
      purpose: 'turn',
      requestId: randomUUID(),
      route: name === 'sums' ? 'understand_sums' : 'understand',
      system: prepared.system,
      messages,
      promptCache: prepared.promptCache,
      schemaName: UNDERSTAND_SCHEMA_NAMES[prepared.form],
      zodSchema: UNDERSTAND_SCHEMAS[prepared.form],
      maxOutputTokens: UNDERSTAND_MAX_OUTPUT_TOKENS[prepared.form],
      timeoutMs: BENCH_TIMEOUT_MS,
      estimateCut: true,
      signal: AbortSignal.timeout(BENCH_TIMEOUT_MS),
      ...(arm.effort === 'low' && thinksOnRequest(arm.modelId) ? { think: 'low' as const } : {}),
    });
  try {
    const first = await call(prepared.messages);
    // As a turn does: a sum a cheap check disagrees with is asked for once more.
    const sums = name === 'sums' ? readSums(first.value) : null;
    const doubt = sums === null ? null : sumsDoubt(sums, context);
    const second =
      sums === null || doubt === null
        ? null
        : await call(sumsAgain(prepared.messages, sums, doubt)).catch(() => null);
    const made = second === null ? [first] : [first, second];
    const total = (of: (x: GenerateStructuredResult<unknown>) => number): number =>
      made.reduce((n, x) => n + of(x), 0);
    return {
      code: 'ok',
      ms: took(),
      inputTokens: total((x) => x.usage.inputTokens),
      cachedInputTokens: total((x) => x.usage.cacheReadInputTokens ?? 0),
      outputTokens: total((x) => x.usage.outputTokens),
      costUsd: total((x) => x.costUsd),
      raw:
        second === null || sums === null || doubt === null
          ? first.value
          : betterSums(sums, readSums(second.value), doubt, context),
      ...(doubt === null ? {} : { again: doubt.code }),
    };
  } catch (err) {
    const attempts = isModelGatewayError(err) ? err.attempts : [];
    const last = attempts.at(-1);
    return {
      code: last?.errorName ?? (isModelGatewayError(err) ? err.code : 'error'),
      ms: took(),
      inputTokens: attempts.reduce((n, a) => n + a.usage.inputTokens, 0),
      cachedInputTokens: 0,
      outputTokens: attempts.reduce((n, a) => n + a.usage.outputTokens, 0),
      costUsd: attempts.reduce((n, a) => n + a.costUsd, 0),
      raw: null,
    };
  }
}

/** How long a turn waits, by channel. */
export interface Caps {
  readonly text: number;
  readonly voice: number;
}

/** The parts' readings, of those `kept`. */
function readingsOf(
  parts: Readonly<Record<UnderstandPart, PartRow>>,
  kept: (name: UnderstandPart) => boolean,
): UnderstandReadings {
  const of = <T>(name: UnderstandPart, parse: (raw: unknown) => T): T | null =>
    parts[name].code === 'ok' && kept(name) ? parse(parts[name].raw) : null;
  return {
    route: of('route', readRoute),
    sums: of('sums', readSums),
    judge: of('judge', readJudge),
  };
}

/** Which parts a turn would have had: those within the cap, JUDGE only for as long as a turn waits for it. */
export function inTimeParts(
  parts: Readonly<Record<UnderstandPart, PartRow>>,
  channel: 'text' | 'voice',
  caps: Caps,
): (name: UnderstandPart) => boolean {
  const cap = caps[channel];
  const within = (name: UnderstandPart): boolean => parts[name].ms <= cap;
  const { route } = readingsOf(parts, (name) => name === 'route' && within(name));
  const needed = Math.min(cap, Math.max(parts.route.ms, parts.sums.ms));
  return (name) =>
    within(name) &&
    (name !== 'judge' || judgeLeads(route) || parts.judge.ms <= needed + UNDERSTAND_JUDGE_WAIT_MS[channel]);
}

/** A SUMS model read beside an arm's own SUMS, on the arm's ROUTE and JUDGE. */
export interface SumsArm {
  readonly arm: Arm;
  readonly gateway: ModelGateway;
}

/** The key of an arm whose SUMS is another model's. */
export const sumsKey = (arm: Arm, sums: Arm): string => `${arm.key}+sums:${sums.key}`;

/** A case on an arm, and on each SUMS model beside it: one row each, their ROUTE and JUDGE read once. */
async function readOnce(
  gateway: ModelGateway,
  arm: Arm,
  c: Case,
  caps: Caps,
  sumsArms: readonly SumsArm[] = [],
): Promise<Row[]> {
  const prepared = prepareCase(c);
  const [route, sums, judge, ...others] = await Promise.all([
    readPart(gateway, arm, 'route', prepared.parts.route, prepared.context),
    readPart(gateway, arm, 'sums', prepared.parts.sums, prepared.context),
    readPart(gateway, arm, 'judge', prepared.parts.judge, prepared.context),
    ...sumsArms.map((s) => readPart(s.gateway, s.arm, 'sums', prepared.parts.sums, prepared.context)),
  ]);
  return [
    rowOf(arm.key, c, caps, prepared, route, sums, judge),
    ...sumsArms.map((s, i) =>
      rowOf(sumsKey(arm, s.arm), c, caps, prepared, route, others[i] ?? NOT_ASKED, judge),
    ),
  ];
}

function rowOf(
  key: string,
  c: Case,
  caps: Caps,
  prepared: PreparedUnderstand,
  route: PartRow,
  sums: PartRow,
  judge: PartRow,
): Row {
  const phrasePlay = phraseIntent(PLAYBOOK, c.message)?.intent.playId ?? null;
  const late = (p: PartRow): PartRow & { late: boolean } => ({ ...p, late: p.ms > caps[c.channel] });
  const parts = { route: late(route), sums: late(sums), judge: late(judge) };
  const all = [route, sums, judge];
  const { understanding, report } = readParts(
    readingsOf(parts, () => true),
    prepared.context,
  );
  const { understanding: inTime } = readParts(
    readingsOf(parts, inTimeParts(parts, c.channel, caps)),
    prepared.context,
  );
  const failed = all.find((p) => p.code !== 'ok' && p.code !== 'skipped');
  const play = PLAYBOOK.plays.find((p) => p.id === understanding?.playId);
  const total = (of: (p: PartRow) => number): number => all.reduce((n, p) => n + of(p), 0);
  return {
    arm: key,
    caseId: c.id,
    code: understanding === null ? (failed?.code ?? 'nothing_held') : 'ok',
    ms: Math.max(...all.map((p) => p.ms)),
    late: UNDERSTAND_PARTS.some((name) => parts[name].late),
    inputTokens: total((p) => p.inputTokens),
    cachedInputTokens: total((p) => p.cachedInputTokens),
    outputTokens: total((p) => p.outputTokens),
    costUsd: total((p) => p.costUsd),
    parts,
    understanding,
    inTime,
    report: understanding === null ? null : report,
    playReferral: play?.referral?.category ?? null,
    phrasePlay,
  };
}

export interface BenchOptions {
  readonly budgetUsd: number;
  readonly concurrency: number;
  readonly gatewayFor: (arm: Arm) => ModelGateway;
  /** How long a turn waits (default its own). */
  readonly caps?: Caps;
  /** The most a case can be billed on an arm (default {@link worstUsd}). */
  readonly worst?: (arm: Arm, prepared: PreparedUnderstand) => number;
  /** A SUMS model read beside each arm's own SUMS (`--sums-model`), and its gateway. */
  readonly sums?: { readonly arm: Arm; readonly gateway: (arm: Arm) => ModelGateway };
}

/**
 * Every case on every arm, within the budget. A case is begun only when its worst case on all of them still fits, so the
 * arms are always compared on the same cases.
 */
export async function runBench(
  arms: readonly Arm[],
  cases: readonly Case[],
  options: BenchOptions,
): Promise<{ rows: Row[]; spentUsd: number; budgetReached: boolean; casesRead: number }> {
  const gateways = new Map(arms.map((arm) => [arm.key, options.gatewayFor(arm)]));
  const sums = options.sums;
  const sumsArms = new Map(
    arms.map((arm): [string, SumsArm[]] => [
      arm.key,
      sums === undefined ? [] : [{ arm: sums.arm, gateway: sums.gateway(arm) }],
    ]),
  );
  const worstOf = options.worst ?? worstUsd;
  const caps = options.caps ?? UNDERSTAND_TIMEOUT_MS;
  const rows: Row[] = [];
  let spent = 0;
  let reserved = 0;
  let next = 0;
  let budgetReached = false;
  let casesRead = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = cases[next];
      if (c === undefined || budgetReached) return;
      const prepared = prepareCase(c);
      const worst = arms.reduce(
        (sum, arm) =>
          sum +
          worstOf(arm, prepared) +
          (sums === undefined ? 0 : partWorstUsd(sums.arm, 'sums', prepared.parts.sums)),
        0,
      );
      if (spent + reserved + worst > options.budgetUsd) {
        budgetReached = true;
        return;
      }
      next += 1;
      casesRead += 1;
      reserved += worst;
      for (const arm of arms) {
        const gateway = gateways.get(arm.key);
        if (gateway === undefined) continue;
        const [row, ...beside] = await readOnce(gateway, arm, c, caps, sumsArms.get(arm.key));
        if (row === undefined) continue;
        // ROUTE and JUDGE are shared: billed once.
        spent += row.costUsd + beside.reduce((n, b) => n + b.parts.sums.costUsd, 0);
        rows.push(row, ...beside);
      }
      reserved -= worst;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return { rows, spentUsd: Math.round(spent * 1e6) / 1e6, budgetReached, casesRead };
}

/** A wrong command line: its message names flags only, so it is printed. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

interface Args {
  readonly cases: string;
  readonly candidates: readonly string[];
  readonly concurrency: number;
  readonly budgetUsd: number;
  readonly out: string;
  readonly caps: Caps;
  /** A SUMS model to read beside each arm's own. */
  readonly sumsModel: string | null;
}

/** The owner's cap on a paid run. */
export const MAX_BUDGET_USD = 2;

const FLAGS = [
  '--cases',
  '--candidates',
  '--concurrency',
  '--budget-usd',
  '--out',
  '--typed-ms',
  '--voice-ms',
  '--sums-model',
];

export function parseArgs(argv: readonly string[]): Args {
  const given = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (!FLAGS.includes(flag)) throw new UsageError(`unknown argument ${flag}`);
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    given.set(flag, value);
  }
  const cases = given.get('--cases');
  const out = given.get('--out');
  if (cases === undefined || out === undefined) throw new UsageError('--cases and --out are required');
  const budgetUsd = Number(given.get('--budget-usd') ?? '1');
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > MAX_BUDGET_USD)
    throw new UsageError(`--budget-usd is between 0 and ${String(MAX_BUDGET_USD)}`);
  const concurrency = Number(given.get('--concurrency') ?? '3');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new UsageError('--concurrency is between 1 and 8');
  const cap = (flag: string, most: number, fallback: number): number => {
    const value = Number(given.get(flag) ?? fallback);
    if (!Number.isInteger(value) || value < 500 || value > most)
      throw new UsageError(`${flag} is between 500 and ${String(most)}`);
    return value;
  };
  return {
    cases,
    out,
    budgetUsd,
    concurrency,
    caps: {
      text: cap('--typed-ms', 10_000, UNDERSTAND_TIMEOUT_MS.text),
      voice: cap('--voice-ms', 5_000, UNDERSTAND_TIMEOUT_MS.voice),
    },
    candidates: (given.get('--candidates') ?? '').split(',').filter((c) => c.trim() !== ''),
    sumsModel:
      (given.get('--sums-model') ?? '').trim() === '' ? null : (given.get('--sums-model') ?? '').trim(),
  };
}

/** The arms a run compares: all, or the models and arms named (`id` is every effort of it). */
export function chosenArms(arms: readonly Arm[], named: readonly string[]): Arm[] {
  const unknown = named.find((n) => !arms.some((a) => a.key === n || a.modelId === n));
  if (unknown !== undefined) throw new UsageError('--candidates names no candidate of models.json');
  return named.length === 0
    ? [...arms]
    : arms.filter((a) => named.includes(a.key) || named.includes(a.modelId));
}

/** A gateway of the candidate alone: a failure is counted, never answered by another model. */
function armConfig(config: ModelGatewayConfig, arm: Arm): ModelGatewayConfig {
  return config.provider === 'mock'
    ? config
    : {
        ...config,
        primaryModelId: arm.modelId,
        fallbackModelId: arm.modelId,
        ...(arm.effort === null || thinksOnRequest(arm.modelId) ? {} : { reasoningEffort: arm.effort }),
      };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const known = armsOf(JSON.parse(await readFile(CANDIDATES_FILE, 'utf8')));
  const arms = chosenArms(known, args.candidates);
  const { cases } = Cases.parse(JSON.parse(await readFile(args.cases, 'utf8')));
  const config = modelGatewayConfigFromEnv(process.env);
  if (args.sumsModel !== null && !known.some((a) => a.modelId === args.sumsModel))
    throw new UsageError('--sums-model names no candidate of models.json');
  const started = performance.now();
  const { rows, ...run } = await runBench(arms, cases, {
    budgetUsd: args.budgetUsd,
    concurrency: args.concurrency,
    caps: args.caps,
    // The mock bills nothing.
    ...(config.provider === 'mock' ? { worst: () => 0 } : {}),
    gatewayFor: (arm) => createModelGateway(armConfig(config, arm)),
    ...(args.sumsModel === null
      ? {}
      : {
          sums: {
            // At the model's own effort (gpt-oss: low).
            arm: { key: args.sumsModel, modelId: args.sumsModel, effort: null },
            gateway: (arm: Arm) => {
              const own = armConfig(config, arm);
              return createModelGateway(
                own.provider === 'mock'
                  ? own
                  : { ...own, understand: { ...own.understand, sumsModelId: args.sumsModel ?? '' } },
              );
            },
          },
        }),
  });
  const report = {
    provider: config.provider,
    arms: arms.map((a) => a.key),
    ...(args.sumsModel === null ? {} : { sumsModel: args.sumsModel }),
    cases: cases.length,
    ...run,
    budgetUsd: args.budgetUsd,
    caps: args.caps,
    wallMs: Math.round(performance.now() - started),
  };
  const dir = join(args.out, 'private');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'understand-bench.json'), JSON.stringify({ report, rows }));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && /lab-understand\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // Only a usage error's message is printed: anything else may echo a prompt or a provider message.
    process.stderr.write(
      `lab-understand: ${err instanceof UsageError ? err.message : err instanceof Error ? err.name : 'error'}\n`,
    );
    process.exitCode = 1;
  });
}
