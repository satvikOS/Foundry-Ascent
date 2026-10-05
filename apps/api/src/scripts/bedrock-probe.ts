/**
 * Live Bedrock probe for the production model path (ops, not part of the app).
 *
 * Sends one structured coach request (the CoachResponse schema with the forced tool choice that every
 * coaching turn uses) to each reasoning model on its own, then one Titan embedding, through the same
 * gateway the API Lambda builds. Prints model ids, outcomes, error class names, token counts and
 * timings only: never prompts or model output. Exits 1 if any check fails.
 *
 *   MODEL_PROVIDER=bedrock pnpm --filter @foundry/api exec tsx src/scripts/bedrock-probe.ts
 *
 * Model ids come from MODEL_PRIMARY_ID / MODEL_FALLBACK_ID / MODEL_EMBEDDINGS_ID (see .github/workflows/
 * ops-bedrock-probe.yml, which reads them from infra/cdk/config/production.json).
 */
import { randomUUID } from 'node:crypto';

import { createModelGateway, isModelGatewayError, modelGatewayConfigFromEnv } from '@foundry/ai';
import { CoachResponse } from '@foundry/contracts';

/** Same value as COACH_RESPONSE_SCHEMA_NAME in packages/ai/src/prompts/version.ts. */
const SCHEMA_NAME = 'CoachResponse';

const SYSTEM = [
  'You are Foundry Guide, a neutral venture coach for a startup accelerator.',
  'Answer by calling the provided tool with a complete, schema-valid CoachResponse.',
  'This is a synthetic connectivity probe: keep every field short.',
].join(' ');

const PROMPT =
  'We are a two-person team building a quiet study-room booking app for universities. ' +
  'What is the single most important assumption we should test this week?';

interface CheckResult {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

function describeError(error: unknown): string {
  if (isModelGatewayError(error)) {
    const attempts = error.attempts
      .map((a) => `${a.modelId}:${a.kind}:${a.outcome}${a.errorName ? `(${a.errorName})` : ''}`)
      .join(', ');
    return `${error.name} code=${error.code} attempts=[${attempts}]`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

async function probeReasoning(modelId: string, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  // Primary and fallback both set to the model under test, so a failure cannot hide behind the fallback.
  const gateway = createModelGateway(
    modelGatewayConfigFromEnv({ ...env, MODEL_PRIMARY_ID: modelId, MODEL_FALLBACK_ID: modelId }),
  );
  const started = Date.now();
  try {
    const result = await gateway.generateStructured({
      purpose: 'turn',
      system: SYSTEM,
      messages: [{ role: 'user', content: PROMPT }],
      schemaName: SCHEMA_NAME,
      zodSchema: CoachResponse,
      requestId: randomUUID(),
      timeoutMs: 45_000,
    });
    const kinds = result.attempts.map((a) => `${a.kind}:${a.outcome}`).join(', ');
    return {
      check: `structured coach response via ${modelId}`,
      ok: true,
      detail:
        `model=${result.modelId} fallback=${String(result.fallbackUsed)} attempts=[${kinds}] ` +
        `tokens in/out=${result.usage.inputTokens}/${result.usage.outputTokens} ` +
        `cost=$${result.costUsd.toFixed(5)} latency=${result.latencyMs}ms`,
    };
  } catch (error) {
    return {
      check: `structured coach response via ${modelId}`,
      ok: false,
      detail: `${describeError(error)} after ${Date.now() - started}ms`,
    };
  }
}

async function probeEmbeddings(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const gateway = createModelGateway(modelGatewayConfigFromEnv(env));
  try {
    const result = await gateway.embed(['Customer discovery interview notes (synthetic probe).'], {
      purpose: 'embedding',
      requestId: randomUUID(),
    });
    const dims = result.vectors[0]?.length ?? 0;
    return {
      check: `embedding via ${gateway.info.embeddingsModelId}`,
      ok: dims === gateway.info.embeddingDimensions,
      detail: `model=${result.modelId} dimensions=${dims} latency=${result.latencyMs}ms`,
    };
  } catch (error) {
    return { check: 'embedding', ok: false, detail: describeError(error) };
  }
}

async function main(): Promise<void> {
  const env = process.env;
  if (env.MODEL_PROVIDER !== 'bedrock') throw new Error('Set MODEL_PROVIDER=bedrock');
  const primary = env.MODEL_PRIMARY_ID;
  const fallback = env.MODEL_FALLBACK_ID;
  if (!primary || !fallback) throw new Error('Set MODEL_PRIMARY_ID and MODEL_FALLBACK_ID');

  const results: CheckResult[] = [];
  for (const modelId of [...new Set([primary, fallback])]) {
    results.push(await probeReasoning(modelId, env));
  }
  results.push(await probeEmbeddings(env));

  for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}: ${r.detail}\n`);
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(
    failed === 0 ? 'All Bedrock checks passed.\n' : `${failed} Bedrock check(s) failed.\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
