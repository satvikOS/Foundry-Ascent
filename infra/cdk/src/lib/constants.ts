/** Values shared by more than one stack; keep them here so the stacks cannot drift apart. */

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
export const VIEWER_HOST_HEADER = 'x-fa-viewer-host';
