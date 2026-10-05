/** Values shared by more than one stack; keep them here so the stacks cannot drift apart. */
import { LAMBDA_CONTRACT } from './lambda-contract.js';

export const PROJECT_TAG = 'foundry-ascent';
export const ENVIRONMENT_NAME = 'production';
export const STACK_PREFIX = 'FoundryAscent';
export const PERMISSIONS_BOUNDARY_NAME = 'FoundryAscent-Boundary';

/** Physical names (resources referenced by ops tooling, runbooks and the GitHub deploy role). */
export const NAMES = {
  apiFunction: 'FoundryAscent-Api',
  workerFunction: 'FoundryAscent-Worker',
  migrateFunction: 'FoundryAscent-Migrate',
  alarmTopic: 'FoundryAscent-Alarms',
  jobsQueue: 'FoundryAscent-Jobs',
  jobsDlq: 'FoundryAscent-Jobs-DLQ',
  auroraCluster: 'foundry-ascent',
  auroraSecret: 'foundry-ascent/aurora-admin',
  auroraUser: 'foundry_admin',
  databaseName: 'foundry',
  githubDeployRole: 'FoundryAscent-GitHubDeploy',
} as const;

/** Worker Lambda timeout; the jobs queue visibility timeout is 6x this (AWS guidance for SQS event sources). */
export const WORKER_TIMEOUT_SECONDS = 120;
export const JOBS_VISIBILITY_TIMEOUT_SECONDS = 6 * WORKER_TIMEOUT_SECONDS;
export const JOBS_MAX_RECEIVE_COUNT = 3;

/** Migrate custom resource handler timeout (migrations + seed + seed embeddings). */
export const MIGRATE_TIMEOUT_MINUTES = 10;

/** S3 key prefix that every venture document lives under (`tenants/{t}/ventures/{v}/documents/...`). */
export const DOCUMENTS_PREFIX = 'tenants/';

/**
 * Browser origins allowed to PUT to the documents bucket with a presigned URL when no custom domain is
 * configured. The CloudFront domain is only known after the App stack creates the distribution, and the
 * bucket lives in the Data stack, so the exact origin cannot be referenced without a stack cycle. The
 * presigned URL (short-lived, single key, signed by the API role) is the authorization; CORS only
 * decides which pages may use one from a browser.
 */
export const DEFAULT_UPLOAD_CORS_ORIGINS: readonly string[] = ['https://*.cloudfront.net'];

/**
 * Header the /api/* CloudFront function sets to the Host the browser addressed. Without a custom domain
 * the API cannot receive SITE_ORIGIN as an environment variable (distribution -> Function URL -> function
 * -> distribution would be a dependency cycle), so it derives `https://<this header>` instead.
 */
export const VIEWER_HOST_HEADER = LAMBDA_CONTRACT.edgeHeaders.viewerHost;

/**
 * Header the /api/* CloudFront function sets to `event.viewer.ip` (overwriting any client value). The
 * API keys its per-IP sign-in lockout on it; `x-forwarded-for` is client-controlled and only trusted in
 * local development.
 */
export const VIEWER_IP_HEADER = LAMBDA_CONTRACT.edgeHeaders.viewerIp;

// ---- /api/* timing (see README "Timeouts and Aurora resume") -------------------------------------------
/**
 * CloudFront origin read (response) timeout for the Function URL: the longest the edge waits for the
 * first byte and between bytes. 60 s is the most the default quota allows without an increase.
 */
export const API_ORIGIN_READ_TIMEOUT_SECONDS = 60;
/** How long one API database call waits for Aurora to resume before 503 `database_resuming` (40 s). */
export const API_DB_RESUME_BUDGET_SECONDS = LAMBDA_CONTRACT.api.dbResumeBudgetSeconds;
/** SSE keep-alive comment interval of a turn stream (15 s). */
export const API_SSE_KEEP_ALIVE_SECONDS = LAMBDA_CONTRACT.api.sseKeepAliveSeconds;
/**
 * Minimum headroom between the resume budget and both the origin read timeout and the Lambda timeout:
 * after waiting for the database, the request still has to run (and answer 503 if it must).
 */
export const API_TIMING_MARGIN_SECONDS = 15;
