/**
 * The API side of `apps/api/lambda-contract.json`: values the Lambda bundles and the CDK app
 * (infra/cdk/src/lib/lambda-contract.ts reads the same file) must agree on — how handlers are bundled
 * (the ESM `createRequire` banner, externals), the headers the CloudFront viewer-request function sets,
 * and the API's timing budget behind CloudFront.
 */
import { z } from 'zod';

import raw from '../lambda-contract.json' with { type: 'json' };

const HeaderName = z.string().regex(/^x-fa-[a-z-]+$/);
const EnvNames = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/));

export const LambdaContract = z.object({
  bundling: z.object({
    platform: z.literal('node'),
    format: z.literal('esm'),
    target: z.string().regex(/^node\d+$/),
    mainFields: z.array(z.string().min(1)).min(1),
    externalModules: z.array(z.string().min(1)),
    banner: z.array(z.string().min(1)).min(1),
  }),
  /** Environment variable names per function (common to all three, plus each role's own). */
  environment: z.object({ common: EnvNames, api: EnvNames, worker: EnvNames, migrate: EnvNames }),
  edgeHeaders: z.object({ viewerIp: HeaderName, viewerHost: HeaderName }),
  api: z.object({
    /** How long one database call of the API waits for Aurora to resume before 503 `database_resuming`. */
    dbResumeBudgetSeconds: z.number().int().min(1).max(50),
    /** SSE keep-alive comment interval (keeps CloudFront's origin read timeout from firing). */
    sseKeepAliveSeconds: z.number().int().min(1).max(30),
  }),
});
export type LambdaContract = z.infer<typeof LambdaContract>;

export const LAMBDA_CONTRACT: LambdaContract = LambdaContract.parse(raw);

/** Prepended to every handler bundle (single line, as esbuild and CDK `NodejsFunction` take it). */
export const ESM_REQUIRE_SHIM = LAMBDA_CONTRACT.bundling.banner.join(' ');

/** Set by the /api/* CloudFront viewer-request function from `event.viewer.ip` (client value overwritten). */
export const VIEWER_IP_HEADER = LAMBDA_CONTRACT.edgeHeaders.viewerIp;

/** Set by the same function to the Host the browser addressed. */
export const VIEWER_HOST_HEADER = LAMBDA_CONTRACT.edgeHeaders.viewerHost;

/** The API's per-call Aurora resume budget (DB_RESUME_BUDGET_MS default for the api role). */
export const API_DB_RESUME_BUDGET_MS = LAMBDA_CONTRACT.api.dbResumeBudgetSeconds * 1000;

export const SSE_KEEP_ALIVE_MS = LAMBDA_CONTRACT.api.sseKeepAliveSeconds * 1000;

export type LambdaRole = 'api' | 'worker' | 'migrate';

/** Every variable the deployed `role` function receives (CDK adds NODE_OPTIONS; Lambda adds AWS_*). */
export function environmentNames(role: LambdaRole): readonly string[] {
  return [...LAMBDA_CONTRACT.environment.common, ...LAMBDA_CONTRACT.environment[role]];
}
