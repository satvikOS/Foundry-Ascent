/**
 * The safety screen on a real model: runs the crisis pipeline (the deterministic rules, the ideation prefilter, then
 * the model-based screen exactly as a turn calls it: packages/core orchestrator/safety-screen.ts) over the E-crisis
 * corpus (ops/lab/scenarios/safety-screen.json, synthetic) and reports precision, recall, latency and cost.
 * docs/runbooks/conversation-lab.md, "Safety screen evaluation".
 *
 *   MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1 \
 *   MODEL_PRIMARY_ID=us.amazon.nova-2-lite-v1:0 MODEL_FALLBACK_ID=global.amazon.nova-2-lite-v1:0 \
 *   MODEL_EMBEDDINGS_ID=amazon.titan-embed-text-v2:0 \
 *   pnpm --filter @foundry/api exec tsx src/scripts/lab-safety-screen.ts [--scope screened|all] \
 *     [--limit N] [--concurrency 4] [--budget-usd 1] [--out DIR]
 *
 * `--scope screened` (default) calls the screen only where a turn would: the rules found no crisis and the prefilter
 * flagged the message. `--scope all` also screens what the prefilter lets pass (the screen's own recall, for
 * widening or narrowing the prefilter). Without MODEL_PROVIDER=bedrock it runs on the mock gateway's rule (a plumbing
 * check, free). Prints only counts, rates, row ids, model ids, milliseconds and dollars; with `--out`, every row's
 * verdict and reason (corpus text included) goes to `<DIR>/private/safety-screen.json` for the operator alone.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SAFETY_SCREEN_MAX_OUTPUT_TOKENS,
  SAFETY_SCREEN_SCHEMA_NAME,
  SAFETY_SCREEN_SYSTEM_PROMPT,
  SAFETY_SCREEN_TIMEOUT_MS,
  SafetyScreenVerdict,
  buildSafetyScreenMessages,
  classifyRisk,
  createModelGateway,
  ideationPrefilter,
  isModelGatewayError,
  modelGatewayConfigFromEnv,
  safetyScreenOutcome,
  safetyScreenReason,
  type ModelGateway,
  type SafetyScreenOutcome,
} from '@foundry/ai';
import { z } from 'zod';

export const DEFAULT_CORPUS = fileURLToPath(
  new URL('../../../../ops/lab/scenarios/safety-screen.json', import.meta.url),
);

export const CorpusRow = z.object({
  id: z.string(),
  text: z.string(),
  expect: z.enum(['crisis', 'wellbeing', 'none', 'debatable', 'unlabeled']),
  main: z.boolean(),
  group: z.string().nullable(),
  source: z.string(),
  /** The vEIR's reply the founder answered (closing rows: "goodbye" after a coaching reply), sent as a turn sends it. */
  previousReply: z.string().nullable().optional(),
});
export type CorpusRow = z.infer<typeof CorpusRow>;
const Corpus = z.object({ version: z.literal(1), rows: z.array(CorpusRow) });

/** How the pipeline reached a row's decision. */
export type Path = 'rules' | 'prefilter_miss' | 'screened' | 'not_screened';

export interface RowResult {
  readonly id: string;
  readonly expect: CorpusRow['expect'];
  /** Whether the screen read the row with the vEIR's previous reply. */
  readonly withReply: boolean;
  readonly path: Path;
  /** The screen's outcome (null when it was not called). */
  readonly screen: SafetyScreenOutcome | null;
  /** Whether a turn would take the crisis path: the rules, or the screen on a prefilter hit. */
  readonly crisis: boolean;
  /** Whether a turn would carry the wellbeing flag from the screen (a forced P1 escalation, the reply answered). */
  readonly wellbeing: boolean;
  readonly latencyMs: number | null;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string | null;
  readonly errorCode: string | null;
  /** The model's reason (private output only). */
  readonly reason: string | null;
}

export interface EvaluateOptions {
  readonly scope: 'screened' | 'all';
  readonly concurrency: number;
  /** Stops calling the model once this much has been spent. */
  readonly budgetUsd: number;
}

/** One screen call, as the turn pipeline makes it (same prompt, schema, output bound and time budget). */
async function screenOnce(
  gateway: ModelGateway,
  text: string,
  previousReply: string | null,
): Promise<
  Pick<
    RowResult,
    'screen' | 'latencyMs' | 'costUsd' | 'inputTokens' | 'outputTokens' | 'modelId' | 'errorCode' | 'reason'
  >
> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(SAFETY_SCREEN_TIMEOUT_MS);
  try {
    const result = await gateway.generateStructured({
      purpose: 'eval',
      system: SAFETY_SCREEN_SYSTEM_PROMPT,
      messages: buildSafetyScreenMessages({ founderText: text, previousReply }),
      schemaName: SAFETY_SCREEN_SCHEMA_NAME,
      zodSchema: SafetyScreenVerdict,
      maxOutputTokens: SAFETY_SCREEN_MAX_OUTPUT_TOKENS,
      timeoutMs: SAFETY_SCREEN_TIMEOUT_MS,
      requestId: randomUUID(),
      signal: timeout,
    });
    return {
      screen: safetyScreenOutcome(result.value),
      latencyMs: Math.round(performance.now() - started),
      costUsd: result.costUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      modelId: result.modelId,
      errorCode: null,
      reason: safetyScreenReason(result.value),
    };
  } catch (err) {
    const attempts = isModelGatewayError(err) ? err.attempts : [];
    return {
      screen: 'failed',
      latencyMs: Math.round(performance.now() - started),
      costUsd: attempts.reduce((acc, a) => acc + a.costUsd, 0),
      inputTokens: attempts.reduce((acc, a) => acc + a.usage.inputTokens, 0),
      outputTokens: attempts.reduce((acc, a) => acc + a.usage.outputTokens, 0),
      modelId: attempts.at(-1)?.modelId ?? null,
      errorCode: timeout.aborted ? 'timeout_budget' : isModelGatewayError(err) ? err.code : 'unknown',
      reason: null,
    };
  }
}

/** Runs the pipeline over `rows`; the model is called at most `concurrency` at a time, within the budget. */
export async function evaluateSafetyScreen(
  gateway: ModelGateway,
  rows: readonly CorpusRow[],
  options: EvaluateOptions,
): Promise<{ results: RowResult[]; budgetReached: boolean }> {
  const results: RowResult[] = new Array<RowResult>(rows.length);
  let spent = 0;
  let budgetReached = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const row = rows[index];
      if (row === undefined) return;
      const rules = classifyRisk(row.text).crisis;
      const hit = !rules && ideationPrefilter(row.text).hit;
      const path: Path = rules
        ? 'rules'
        : hit
          ? 'screened'
          : options.scope === 'all'
            ? 'not_screened'
            : 'prefilter_miss';
      const empty = {
        screen: null,
        latencyMs: null,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        modelId: null,
        errorCode: null,
        reason: null,
      };
      const call = path === 'screened' || path === 'not_screened';
      if (call && spent >= options.budgetUsd) budgetReached = true;
      const previousReply = row.previousReply ?? null;
      const screened = call && !budgetReached ? await screenOnce(gateway, row.text, previousReply) : empty;
      spent += screened.costUsd;
      results[index] = {
        id: row.id,
        expect: row.expect,
        withReply: previousReply !== null,
        path,
        ...screened,
        // Only a prefilter hit reaches the screen in a turn; `not_screened` rows are measured, never acted on.
        crisis: rules || (path === 'screened' && screened.screen === 'crisis'),
        wellbeing: path === 'screened' && screened.screen === 'wellbeing',
      };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return { results, budgetReached };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null;
}

/** How many rows, and the first ids (the private output has them all, with their text). */
function idList(rows: readonly RowResult[]): { count: number; firstIds: string[] } {
  return { count: rows.length, firstIds: rows.slice(0, 40).map((r) => r.id) };
}

/** Public-safe numbers (counts, rates, ids, ms, dollars) of an evaluation. */
export function summarize(results: readonly RowResult[]) {
  const labelled = results.filter((r) => r.expect === 'crisis' || r.expect === 'none');
  const positives = labelled.filter((r) => r.expect === 'crisis');
  const negatives = labelled.filter((r) => r.expect === 'none');
  const confusion = (flag: (r: RowResult) => boolean) => {
    const tp = positives.filter(flag).length;
    const fp = negatives.filter(flag).length;
    return {
      tp,
      fp,
      fn: positives.length - tp,
      tn: negatives.length - fp,
      precision: rate(tp, tp + fp),
      recall: rate(tp, positives.length),
    };
  };
  // The screen alone, on the rows it read (crisis vs ordinary).
  const read = labelled.filter((r) => r.screen !== null);
  const readPositives = read.filter((r) => r.expect === 'crisis');
  const readNegatives = read.filter((r) => r.expect === 'none');
  const screenTp = readPositives.filter((r) => r.screen === 'crisis').length;
  const screenFp = readNegatives.filter((r) => r.screen === 'crisis').length;
  const calls = results.filter((r) => r.screen !== null);
  const latencies = calls.map((r) => r.latencyMs ?? 0);
  const cost = calls.reduce((acc, r) => acc + r.costUsd, 0);
  const meanCost = calls.length === 0 ? 0 : cost / calls.length;
  const byExpect = (expectValue: RowResult['expect']) => {
    const rows = results.filter((r) => r.expect === expectValue && r.screen !== null);
    return {
      screened: rows.length,
      crisis: rows.filter((r) => r.screen === 'crisis').length,
      wellbeing: rows.filter((r) => r.screen === 'wellbeing').length,
      clear: rows.filter((r) => r.screen === 'clear').length,
      failed: rows.filter((r) => r.screen === 'failed').length,
    };
  };
  return {
    rows: results.length,
    paths: {
      rules: results.filter((r) => r.path === 'rules').length,
      screened: results.filter((r) => r.path === 'screened').length,
      prefilterMiss: results.filter((r) => r.path === 'prefilter_miss' || r.path === 'not_screened').length,
    },
    rulesOnly: confusion((r) => r.path === 'rules'),
    pipeline: confusion((r) => r.crisis),
    screenAlone: {
      read: read.length,
      precision: rate(screenTp, screenTp + screenFp),
      recall: rate(screenTp, readPositives.length),
      falseCrisis: idList(readNegatives.filter((r) => r.screen === 'crisis')),
      missedCrisis: idList(readPositives.filter((r) => r.screen !== 'crisis')),
    },
    outcomesByExpect: {
      crisis: byExpect('crisis'),
      none: byExpect('none'),
      wellbeing: byExpect('wellbeing'),
      debatable: byExpect('debatable'),
    },
    /**
     * Rows read with the vEIR's previous reply (sign-offs after a coaching reply, a goodbye after distress): the
     * screen's most frequent production input, where the reply decides.
     */
    withReply: {
      screened: read.filter((r) => r.withReply).length,
      falseCrisis: idList(readNegatives.filter((r) => r.withReply && r.screen === 'crisis')),
      missedCrisis: idList(readPositives.filter((r) => r.withReply && r.screen !== 'crisis')),
    },
    /** Wellbeing flags on ordinary lines: each forces a P1 escalation, so they count against precision too. */
    wellbeingOnOrdinary: idList(negatives.filter((r) => r.wellbeing)),
    failures: calls.filter((r) => r.screen === 'failed').length,
    failureCodes: [...new Set(calls.map((r) => r.errorCode).filter((c): c is string => c !== null))].sort(),
    models: [...new Set(calls.map((r) => r.modelId).filter((m): m is string => m !== null))].sort(),
    latencyMs: {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p99: percentile(latencies, 99),
      max: latencies.length === 0 ? null : Math.max(...latencies),
    },
    tokens: {
      meanInput:
        calls.length === 0 ? 0 : Math.round(calls.reduce((a, r) => a + r.inputTokens, 0) / calls.length),
      meanOutput:
        calls.length === 0 ? 0 : Math.round(calls.reduce((a, r) => a + r.outputTokens, 0) / calls.length),
    },
    costUsd: {
      total: Math.round(cost * 1e6) / 1e6,
      perCall: Math.round(meanCost * 1e7) / 1e7,
      /** Per 1,000 founder turns at a given share of turns that reach the screen (prefilter hits). */
      per1000TurnsAtHitRate: Object.fromEntries(
        [0.005, 0.01, 0.02, 0.05].map((share) => [
          String(share),
          Math.round(meanCost * share * 1000 * 1e5) / 1e5,
        ]),
      ),
    },
  };
}

/** A wrong command line: its message names flags only, so it is printed. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

interface Args {
  corpus: string;
  scope: 'screened' | 'all';
  limit: number | null;
  concurrency: number;
  budgetUsd: number;
  out: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    corpus: DEFAULT_CORPUS,
    scope: 'screened',
    limit: null,
    concurrency: 4,
    budgetUsd: 1,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const need = (): string => {
      if (value === undefined) throw new UsageError(`${flag ?? ''} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--corpus':
        args.corpus = need();
        break;
      case '--scope': {
        const scope = need();
        if (scope !== 'screened' && scope !== 'all') throw new UsageError('--scope is screened or all');
        args.scope = scope;
        break;
      }
      case '--limit':
        args.limit = Number.parseInt(need(), 10);
        break;
      case '--concurrency':
        args.concurrency = Math.min(16, Math.max(1, Number.parseInt(need(), 10)));
        break;
      case '--budget-usd':
        args.budgetUsd = Number.parseFloat(need());
        break;
      case '--out':
        args.out = need();
        break;
      default:
        throw new UsageError(`unknown argument ${flag ?? ''}`);
    }
  }
  if (!Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0 || args.budgetUsd > 20) {
    throw new UsageError('--budget-usd is between 0 and 20');
  }
  return args;
}

export async function loadCorpus(path: string): Promise<CorpusRow[]> {
  return Corpus.parse(JSON.parse(await readFile(path, 'utf8'))).rows;
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const rows = await loadCorpus(args.corpus);
  const selected = args.limit === null ? rows : rows.slice(0, args.limit);
  const gateway = createModelGateway(modelGatewayConfigFromEnv(process.env));
  const started = performance.now();
  const { results, budgetReached } = await evaluateSafetyScreen(gateway, selected, {
    scope: args.scope,
    concurrency: args.concurrency,
    budgetUsd: args.budgetUsd,
  });
  const report = {
    provider: gateway.info.provider,
    primaryModelId: gateway.info.primaryModelId,
    fallbackModelId: gateway.info.fallbackModelId,
    scope: args.scope,
    budgetReached,
    wallMs: Math.round(performance.now() - started),
    ...summarize(results),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.out !== null) {
    const dir = join(args.out, 'private');
    await mkdir(dir, { recursive: true });
    const texts = new Map(selected.map((r) => [r.id, r.text]));
    await writeFile(
      join(dir, 'safety-screen.json'),
      `${JSON.stringify({ report, rows: results.map((r) => ({ ...r, text: texts.get(r.id) ?? '' })) }, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && /lab-safety-screen\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // Only a usage error's message is printed: anything else may echo a prompt or a provider message.
    process.stderr.write(
      `lab-safety-screen: ${err instanceof UsageError ? err.message : err instanceof Error ? err.name : 'error'}\n`,
    );
    process.exitCode = 1;
  });
}
