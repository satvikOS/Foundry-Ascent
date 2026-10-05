/**
 * Exercises the real NodejsFunction bundling path (local esbuild, ESM, banner shim) end to end.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { BUNDLE_EXTERNALS, ESM_REQUIRE_SHIM, PlatformFunction } from '../src/constructs/platform-function.js';
import { environmentNames, LAMBDA_CONTRACT, LAMBDA_CONTRACT_FILE } from '../src/lib/lambda-contract.js';
import {
  ensureLocalEsbuildOnPath,
  HANDLER_NAMES,
  INFRA_ROOT,
  realHandlerEntry,
  REPO_ROOT,
} from '../src/paths.js';

/** Synthesizes one PlatformFunction per entry and returns the bundle directory of each. */
function bundle(entries: Record<string, string>): Record<string, string> {
  ensureLocalEsbuildOnPath();
  const outdir = mkdtempSync(join(tmpdir(), 'foundry-bundle-test-'));
  const app = new App({ outdir });
  const stack = new Stack(app, 'BundleTest', { env: { region: 'us-east-1' } });
  for (const [name, entry] of Object.entries(entries)) {
    new PlatformFunction(stack, name, {
      functionName: `BundleTest-${name}`,
      description: 'bundling test',
      entry,
      depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
      projectRoot: REPO_ROOT,
      memorySize: 128,
      timeout: Duration.seconds(3),
      logRetention: RetentionDays.ONE_DAY,
      environment: {},
    });
  }
  const functions = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Function')) as {
    Properties: { FunctionName?: string; Code: { S3Key: string } };
  }[];
  const result: Record<string, string> = {};
  for (const name of Object.keys(entries)) {
    const key =
      functions.find((r) => r.Properties.FunctionName === `BundleTest-${name}`)?.Properties.Code.S3Key ?? '';
    const dir = join(outdir, `asset.${key.replace(/\.zip$/, '')}`);
    expect(existsSync(join(dir, 'index.mjs')), `${name} bundle`).toBe(true);
    result[name] = dir;
  }
  return result;
}

describe('ESM bundle shim', () => {
  it('lets bundled CommonJS code use require, __filename and __dirname', () => {
    const fixtureDir = join(INFRA_ROOT, 'node_modules', '.cache', 'foundry-cdk-test-fixtures', 'esm-shim');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, 'legacy.cjs'),
      [
        "const path = require('node:path');",
        'module.exports = { file: path.basename(__filename), dirIsString: typeof __dirname === "string" };',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(fixtureDir, 'entry.ts'),
      [
        "import legacy from './legacy.cjs';",
        'export const handler = async (): Promise<unknown> => legacy;',
        '',
      ].join('\n'),
      'utf8',
    );

    const { shim } = bundle({ shim: join(fixtureDir, 'entry.ts') });
    const bundlePath = join(shim ?? '', 'index.mjs');
    const source = readFileSync(bundlePath, 'utf8');
    expect(source.startsWith("import { createRequire as __faCreateRequire } from 'node:module';")).toBe(true);
    expect(existsSync(`${bundlePath}.map`)).toBe(true);

    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(pathToFileURL(bundlePath).href)}); console.log(JSON.stringify(await m.handler()));`,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output.trim())).toEqual({ file: 'index.mjs', dirIsString: true });
  });
});

describe('bundling settings come from apps/api/lambda-contract.json (shared with the API bundle check)', () => {
  it('uses the contract banner, externals, target and main fields', () => {
    const raw = JSON.parse(readFileSync(LAMBDA_CONTRACT_FILE, 'utf8')) as {
      bundling: { banner: string[]; externalModules: string[]; target: string };
    };
    expect(ESM_REQUIRE_SHIM).toBe(raw.bundling.banner.join(' '));
    expect(BUNDLE_EXTERNALS).toEqual(raw.bundling.externalModules);
    expect(BUNDLE_EXTERNALS).toContain('pg-native');
    expect(LAMBDA_CONTRACT.bundling.target).toBe('node24');
  });
});

/** Fake but well-formed runtime-contract values (nothing is contacted at import time). */
const FAKE_ENV: Readonly<Record<string, string>> = {
  APP_ENV: 'production',
  APP_VERSION: 'infra-bundle-test',
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

/** Mirrors the Lambda runtime's `awslambda` global, which the streaming API handler needs at import. */
const AWSLAMBDA_SHIM = `globalThis.awslambda = {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (stream) => stream },
};`;

const realHandlersPresent = HANDLER_NAMES.every((name) => existsSync(realHandlerEntry(name)));

describe.skipIf(!realHandlersPresent)('real apps/api handlers', () => {
  const dirs = realHandlersPresent
    ? bundle(Object.fromEntries(HANDLER_NAMES.map((name) => [name, realHandlerEntry(name)])))
    : {};

  it('bundle with local esbuild into ESM for Node 24', () => {
    for (const [name, dir] of Object.entries(dirs)) {
      const files = readdirSync(dir);
      expect(files, name).toContain('index.mjs');
      const size = statSync(join(dir, 'index.mjs')).size;
      // Lambda's unzipped limit is 250 MB; anything near 50 MB means something leaked into the bundle.
      expect(size, `${name} bundle size`).toBeLessThan(50 * 1024 * 1024);
      expect(readFileSync(join(dir, 'index.mjs'), 'utf8').startsWith(ESM_REQUIRE_SHIM), name).toBe(true);
    }
  });

  it.each(HANDLER_NAMES)('%s imports with exactly its deployed environment', (name) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', AWS_REGION: 'us-east-1' };
    for (const key of environmentNames(name)) {
      const value = FAKE_ENV[key];
      if (value === undefined) throw new Error(`no test value for ${key}`);
      env[key] = value;
    }
    const href = pathToFileURL(join(dirs[name] ?? '', 'index.mjs')).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${AWSLAMBDA_SHIM}\nconst m = await import(${JSON.stringify(href)}); console.log(typeof m.handler);`,
      ],
      { encoding: 'utf8', env },
    );
    expect(output.trim()).toBe('function');
  });
});
