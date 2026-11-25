/**
 * The understand call on candidate models (docs/architecture/understand.md; the lab's `understand` suite,
 * docs/runbooks/conversation-lab.md): a turn's own prompt, schema, checks and sums (`prepareUnderstand`,
 * `readUnderstanding`) over the cases the lab made of its client scenarios, each case on every candidate before the next
 * case, so a run its budget stops has read the same cases on all of them.
 *
 *   MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1 \
 *   pnpm --filter @foundry/api exec tsx src/scripts/lab-understand.ts --cases FILE --budget-usd 2 --out DIR \
 *     [--candidates id@effort,id] [--concurrency 3]
 *
 * Candidates are `understand` in ops/lab/models.json. Without MODEL_PROVIDER=bedrock it runs on the mock model's rules (a
 * plumbing check, free). A call is given longer than a turn's budget, so what is late is measured rather than cut off.
 * `--budget-usd` is a hard cap: a call is made only when its worst case still fits beside what was spent and what the
 * calls in flight may still cost. Every reading goes to `<DIR>/private/understand-bench.json` (synthetic founders' words:
 * the lab seals it); only counts and codes are printed.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RawUnderstanding,
  UNDERSTAND_MAX_OUTPUT_TOKENS,
  UNDERSTAND_SCHEMA_NAME,
  UNDERSTAND_TIMEOUT_MS,
  createModelGateway,
  isModelGatewayError,
  modelGatewayConfigFromEnv,
  readUnderstanding,
  thinksOnRequest,
  type ModelGateway,
  type Understanding,
  type UnderstandReport,
} from '@foundry/ai';
import { PathIntake, VentureDomain, VentureStage } from '@foundry/contracts';
import { PLAYBOOK, phraseIntent, prepareUnderstand, type PreparedUnderstand } from '@foundry/core';
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
  /** The founder's earlier lines of this conversation (no reply exists: nothing was answered). */
  history: z.array(z.string()),
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

export interface Row {
  readonly arm: string;
  readonly caseId: string;
  /** `ok`, `nothing_held`, `budget` (not called) or the failure's code. */
  readonly code: string;
  readonly ms: number;
  /** Beyond a turn's own budget on its channel. */
  readonly late: boolean;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly raw: unknown;
  /** As a turn would use it. */
  readonly understanding: Understanding | null;
  /** The same, an input taken from anywhere the founder gave it (how much the named place costs). */
  readonly anywhere: Understanding | null;
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
    history: c.history.map((founderText) => ({ founderText, answer: null })),
    opener: null,
    channel: c.channel,
  });
}

const charsOf = (p: PreparedUnderstand): number =>
  p.system.length + p.messages.reduce((n, m) => n + m.content.length, 0);

/**
 * The most one case can be billed on an arm, as lab-models.ts bounds a call: its input at the dearest rate with a full
 * answer, read again for a repair, and the gateway's fallback (the same model) doing the same.
 */
export function worstUsd(arm: Arm, prepared: PreparedUnderstand): number {
  return reasoningWorstUsd(
    arm.modelId,
    charsOf(prepared),
    UNDERSTAND_MAX_OUTPUT_TOKENS,
    arm.effort === 'low' && thinksOnRequest(arm.modelId),
  );
}

/** How long a call may take here: longer than a turn gives it, so a late one is measured. */
export const BENCH_TIMEOUT_MS = 20_000;

async function readOnce(gateway: ModelGateway, arm: Arm, c: Case): Promise<Row> {
  const prepared = prepareCase(c);
  const started = performance.now();
  const phrasePlay = phraseIntent(PLAYBOOK, c.message)?.intent.playId ?? null;
  const base = { arm: arm.key, caseId: c.id, phrasePlay };
  const took = (): { ms: number; late: boolean } => {
    const ms = Math.round(performance.now() - started);
    return { ms, late: ms > UNDERSTAND_TIMEOUT_MS[c.channel] };
  };
  try {
    const result = await gateway.generateStructured({
      // Sampled as a turn is.
      purpose: 'turn',
      requestId: randomUUID(),
      route: 'understand',
      system: prepared.system,
      messages: prepared.messages,
      promptCache: prepared.promptCache,
      schemaName: UNDERSTAND_SCHEMA_NAME,
      zodSchema: RawUnderstanding,
      maxOutputTokens: UNDERSTAND_MAX_OUTPUT_TOKENS,
      timeoutMs: BENCH_TIMEOUT_MS,
      estimateCut: true,
      signal: AbortSignal.timeout(BENCH_TIMEOUT_MS),
      ...(arm.effort === 'low' && thinksOnRequest(arm.modelId) ? { think: 'low' as const } : {}),
    });
    const time = took();
    const { understanding, report } = readUnderstanding(result.value, prepared.context);
    const loose = readUnderstanding(result.value, prepared.context, { strictInputs: false });
    const play = PLAYBOOK.plays.find((p) => p.id === understanding?.playId);
    return {
      ...base,
      ...time,
      code: understanding === null ? 'nothing_held' : 'ok',
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cacheReadInputTokens ?? 0,
      outputTokens: result.usage.outputTokens,
      costUsd: result.costUsd,
      raw: result.value,
      understanding,
      anywhere: loose.understanding,
      report,
      playReferral: play?.referral?.category ?? null,
    };
  } catch (err) {
    const attempts = isModelGatewayError(err) ? err.attempts : [];
    const last = attempts.at(-1);
    return {
      ...base,
      ...took(),
      code: last?.errorName ?? (isModelGatewayError(err) ? err.code : 'error'),
      inputTokens: attempts.reduce((n, a) => n + a.usage.inputTokens, 0),
      cachedInputTokens: 0,
      outputTokens: attempts.reduce((n, a) => n + a.usage.outputTokens, 0),
      costUsd: attempts.reduce((n, a) => n + a.costUsd, 0),
      raw: last?.issues ?? null,
      understanding: null,
      anywhere: null,
      report: null,
      playReferral: null,
    };
  }
}

export interface BenchOptions {
  readonly budgetUsd: number;
  readonly concurrency: number;
  readonly gatewayFor: (arm: Arm) => ModelGateway;
  /** The most a case can be billed on an arm (default {@link worstUsd}). */
  readonly worst?: (arm: Arm, prepared: PreparedUnderstand) => number;
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
  const worstOf = options.worst ?? worstUsd;
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
      const worst = arms.reduce((sum, arm) => sum + worstOf(arm, prepared), 0);
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
        const row = await readOnce(gateway, arm, c);
        spent += row.costUsd;
        rows.push(row);
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
}

/** The owner's cap on a paid run. */
export const MAX_BUDGET_USD = 2;

export function parseArgs(argv: readonly string[]): Args {
  const given = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (!['--cases', '--candidates', '--concurrency', '--budget-usd', '--out'].includes(flag))
      throw new UsageError(`unknown argument ${flag}`);
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
  return {
    cases,
    out,
    budgetUsd,
    concurrency,
    candidates: (given.get('--candidates') ?? '').split(',').filter((c) => c.trim() !== ''),
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

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const arms = chosenArms(armsOf(JSON.parse(await readFile(CANDIDATES_FILE, 'utf8'))), args.candidates);
  const { cases } = Cases.parse(JSON.parse(await readFile(args.cases, 'utf8')));
  const config = modelGatewayConfigFromEnv(process.env);
  const started = performance.now();
  const { rows, ...run } = await runBench(arms, cases, {
    budgetUsd: args.budgetUsd,
    concurrency: args.concurrency,
    // The mock bills nothing.
    ...(config.provider === 'mock' ? { worst: () => 0 } : {}),
    gatewayFor: (arm) =>
      createModelGateway(
        config.provider === 'mock'
          ? config
          : {
              ...config,
              // The candidate alone: a failure is counted, never answered by another model.
              primaryModelId: arm.modelId,
              fallbackModelId: arm.modelId,
              ...(arm.effort === null || thinksOnRequest(arm.modelId) ? {} : { reasoningEffort: arm.effort }),
            },
      ),
  });
  const report = {
    provider: config.provider,
    arms: arms.map((a) => a.key),
    cases: cases.length,
    ...run,
    budgetUsd: args.budgetUsd,
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
