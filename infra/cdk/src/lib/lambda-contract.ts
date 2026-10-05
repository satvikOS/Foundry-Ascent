/**
 * The infra side of `apps/api/lambda-contract.json`: values the Lambda bundles and this CDK app must
 * agree on (apps/api/src/lambda-contract.ts reads the same file). Validated at synth time, so a malformed
 * contract fails `cdk synth` instead of producing functions that cannot start.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.js';

export type LambdaRole = 'api' | 'worker' | 'migrate';

export interface LambdaContract {
  readonly bundling: {
    readonly platform: 'node';
    readonly format: 'esm';
    readonly target: string;
    readonly mainFields: readonly string[];
    readonly externalModules: readonly string[];
    readonly banner: readonly string[];
  };
  readonly environment: Readonly<Record<'common' | LambdaRole, readonly string[]>>;
  readonly edgeHeaders: { readonly viewerIp: string; readonly viewerHost: string };
  readonly api: { readonly dbResumeBudgetSeconds: number; readonly sseKeepAliveSeconds: number };
}

export const LAMBDA_CONTRACT_FILE = join(REPO_ROOT, 'apps', 'api', 'lambda-contract.json');

type Json = Record<string, unknown>;

function fail(path: string, problem: string): never {
  throw new Error(`${LAMBDA_CONTRACT_FILE}: ${path} ${problem}`);
}

function obj(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as Json;
}

function strings(value: unknown, path: string, pattern: RegExp, min = 0): string[] {
  if (!Array.isArray(value) || value.length < min) fail(path, `must be an array of at least ${String(min)}`);
  return value.map((item, i) =>
    typeof item === 'string' && pattern.test(item)
      ? item
      : fail(`${path}[${String(i)}]`, `must match ${String(pattern)}`),
  );
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    fail(path, `must be an integer in [${String(min)}, ${String(max)}]`);
  return value;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const HEADER = /^x-fa-[a-z-]+$/;

export function parseLambdaContract(raw: unknown): LambdaContract {
  const root = obj(raw, '$');
  const bundling = obj(root.bundling, '$.bundling');
  const environment = obj(root.environment, '$.environment');
  const edgeHeaders = obj(root.edgeHeaders, '$.edgeHeaders');
  const api = obj(root.api, '$.api');
  if (bundling.platform !== 'node') fail('$.bundling.platform', 'must be "node"');
  if (bundling.format !== 'esm') fail('$.bundling.format', 'must be "esm"');
  const [target] = strings([bundling.target], '$.bundling.target', /^node\d+$/, 1);
  const env = (key: 'common' | LambdaRole): string[] =>
    strings(environment[key], `$.environment.${key}`, ENV_NAME);
  const [viewerIp] = strings([edgeHeaders.viewerIp], '$.edgeHeaders.viewerIp', HEADER, 1);
  const [viewerHost] = strings([edgeHeaders.viewerHost], '$.edgeHeaders.viewerHost', HEADER, 1);
  return {
    bundling: {
      platform: 'node',
      format: 'esm',
      target: target ?? fail('$.bundling.target', 'is missing'),
      mainFields: strings(bundling.mainFields, '$.bundling.mainFields', /^[a-z]+$/, 1),
      externalModules: strings(bundling.externalModules, '$.bundling.externalModules', /^[@a-z0-9./_-]+$/),
      banner: strings(bundling.banner, '$.bundling.banner', /^.+$/, 1),
    },
    environment: { common: env('common'), api: env('api'), worker: env('worker'), migrate: env('migrate') },
    edgeHeaders: {
      viewerIp: viewerIp ?? fail('$.edgeHeaders.viewerIp', 'is missing'),
      viewerHost: viewerHost ?? fail('$.edgeHeaders.viewerHost', 'is missing'),
    },
    api: {
      dbResumeBudgetSeconds: int(api.dbResumeBudgetSeconds, '$.api.dbResumeBudgetSeconds', 1, 50),
      sseKeepAliveSeconds: int(api.sseKeepAliveSeconds, '$.api.sseKeepAliveSeconds', 1, 30),
    },
  };
}

export function loadLambdaContract(file: string = LAMBDA_CONTRACT_FILE): LambdaContract {
  return parseLambdaContract(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

/** Loaded once per synth. */
export const LAMBDA_CONTRACT: LambdaContract = loadLambdaContract();

/** Every variable the `role` function must receive (CDK adds NODE_OPTIONS, Lambda adds AWS_*). */
export function environmentNames(role: LambdaRole): readonly string[] {
  return [...LAMBDA_CONTRACT.environment.common, ...LAMBDA_CONTRACT.environment[role]];
}
