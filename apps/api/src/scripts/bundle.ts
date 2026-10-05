/**
 * Bundles the Lambda handlers the way CDK `NodejsFunction` does (infra/cdk/src/constructs/
 * platform-function.ts) and import-checks each bundle in a fresh Node process with a minimal
 * production-like environment. Catches ESM/CJS interop problems (`require` of builtins inside bundled
 * CommonJS, `__dirname`, dynamic imports) before `cdk synth` does.
 *
 * Platform, format, target, main fields, externals (`pg-native`) and the createRequire banner come from
 * `apps/api/lambda-contract.json`, the file the CDK app reads too, so the two cannot drift apart.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { ESM_REQUIRE_SHIM, environmentNames, LAMBDA_CONTRACT } from '../lambda-contract.js';

export const HANDLERS = ['api', 'worker', 'migrate'] as const;
export type HandlerName = (typeof HANDLERS)[number];

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The createRequire banner shared with CDK (see `lambda-contract.ts`). */
export { ESM_REQUIRE_SHIM };

export function handlerEntry(name: HandlerName): string {
  return join(SRC_DIR, 'handlers', `${name}.ts`);
}

export interface BundleResult {
  readonly name: HandlerName;
  readonly outfile: string;
  readonly bytes: number;
  readonly warnings: number;
}

/** Bundles one entry exactly like CDK NodejsFunction (ESM output keeps the entry's exports). */
export async function bundleEntry(
  entry: string,
  outfile: string,
): Promise<{ bytes: number; warnings: number }> {
  const { bundling } = LAMBDA_CONTRACT;
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: bundling.platform,
    format: bundling.format,
    target: bundling.target,
    mainFields: [...bundling.mainFields],
    banner: { js: ESM_REQUIRE_SHIM },
    external: [...bundling.externalModules],
    minify: true,
    keepNames: true,
    sourcemap: true,
    sourcesContent: false,
    charset: 'utf8',
    logLevel: 'silent',
  });
  if (result.errors.length > 0)
    throw new Error(`esbuild reported ${String(result.errors.length)} errors for ${entry}`);
  return { bytes: (await stat(outfile)).size, warnings: result.warnings.length };
}

export async function bundleHandler(name: HandlerName, outDir: string): Promise<BundleResult> {
  const outfile = join(outDir, name, 'index.mjs');
  const { bytes, warnings } = await bundleEntry(handlerEntry(name), outfile);
  return { name, outfile, bytes, warnings };
}

/** Fake but well-formed values for every runtime-contract variable (nothing is contacted at import). */
export const FAKE_ENV_VALUES: Readonly<Record<string, string>> = {
  APP_ENV: 'production',
  APP_VERSION: 'bundle-check',
  LOG_LEVEL: 'error',
  DB_DRIVER: 'dataapi',
  DB_CLUSTER_ARN: 'arn:aws:rds:us-east-1:123456789012:cluster:foundry-ascent',
  DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foundry-ascent/aurora-admin-AbCdEf',
  DB_NAME: 'foundry',
  DB_RESUME_BUDGET_MS: '40000',
  DOCUMENTS_BUCKET: 'foundry-ascent-documents-check',
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/FoundryAscent-Jobs',
  JOBS_MAX_RECEIVE_COUNT: '3',
  MODEL_PROVIDER: 'bedrock',
  MODEL_PRIMARY_ID: 'us.amazon.nova-2-lite-v1:0',
  MODEL_FALLBACK_ID: 'global.amazon.nova-2-lite-v1:0',
  MODEL_EMBEDDINGS_ID: 'amazon.titan-embed-text-v2:0',
  BEDROCK_REGION: 'us-east-1',
  OWNER_ACCESS_CODE_PREFIX: 'T9302',
  OWNER_ACCESS_CODE_HASH:
    'scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  OWNER_DISPLAY_NAME: 'Platform Owner',
  HOME_TENANT_SLUG: 'ain',
  HOME_TENANT_NAME: 'Ain Foundry',
};

/**
 * Exactly the environment the deployed `name` function gets: the lambda-contract variables of its role
 * (fake values), plus what CDK (`NODE_OPTIONS`) and the Lambda runtime (`AWS_REGION`) add.
 */
export function handlerEnv(name: HandlerName): Record<string, string> {
  const env: Record<string, string> = { AWS_REGION: 'us-east-1', NODE_OPTIONS: '--enable-source-maps' };
  for (const key of environmentNames(name)) {
    const value = FAKE_ENV_VALUES[key];
    if (value === undefined) throw new Error(`No bundle-check value for runtime-contract variable ${key}`);
    env[key] = value;
  }
  return env;
}

/** The api function's environment (kept for callers that check one bundle with a modified env). */
export const IMPORT_CHECK_ENV: Readonly<Record<string, string>> = handlerEnv('api');

/**
 * Stand-in for the Lambda runtime's `awslambda` global (streaming handlers are created at import time).
 * Mirrors the runtime: `streamifyResponse` tags and returns the same function.
 */
export const AWSLAMBDA_SHIM = `globalThis.awslambda = {
  streamifyResponse: (fn) => { fn[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response'; return fn; },
  HttpResponseStream: { from: (stream, metadata) => { stream.metadata = metadata; return stream; } },
};`;

export interface ImportCheckResult {
  readonly ok: boolean;
  readonly output: string;
}

/** Imports a bundle in a new Node process and checks that it exports a `handler` function. */
export function importCheck(
  bundle: string,
  env: Readonly<Record<string, string>> = IMPORT_CHECK_ENV,
): Promise<ImportCheckResult> {
  const script = `${AWSLAMBDA_SHIM}
const mod = await import(${JSON.stringify(pathToFileURL(bundle).href)});
if (typeof mod.handler !== 'function') throw new Error('handler export is missing');
process.stdout.write('handler:' + typeof mod.handler + '\\n');`;
  return runModuleScript(script, env, 'handler:function');
}

/** Runs an ES module script in a fresh Node process; ok when it exits 0 and prints `expect`. */
export function runModuleScript(
  script: string,
  env: Readonly<Record<string, string>>,
  expect: string,
): Promise<ImportCheckResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0 && output.includes(expect), output: output.slice(-4000) });
    });
  });
}
