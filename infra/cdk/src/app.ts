/**
 * Builds the Foundry Ascent CDK app. Shared by `src/bin/app.ts` (cdk CLI) and the tests, so both
 * synthesize exactly the same stacks.
 */
import { App, type Environment, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig, type PlatformConfig } from './config.js';
import { DEFAULT_UPLOAD_CORS_ORIGINS, ENVIRONMENT_NAME, PROJECT_TAG, STACK_PREFIX } from './lib/constants.js';
import { ensureLocalEsbuildOnPath, resolveAssets, type AppAssets } from './paths.js';
import { AppStack, type SiteDomain } from './stacks/app-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { FoundationStack } from './stacks/foundation-stack.js';

export interface FoundryApp {
  readonly app: App;
  readonly config: PlatformConfig;
  readonly assets: AppAssets;
  readonly foundation: FoundationStack;
  readonly data: DataStack;
  readonly appStack: AppStack;
}

export interface BuildOptions {
  /** Pre-built App (tests pass one with an outdir and context); otherwise a new App reads CDK context. */
  readonly app?: App;
  readonly config?: PlatformConfig;
  /** Use synth-only stub handlers/SPA (see paths.ts). Defaults to FA_SYNTH_STUB_ASSETS. */
  readonly stubAssets?: boolean;
}

const APP_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOMAIN_NAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACM_CERTIFICATE_ARN = /^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]{36}$/;
const OIDC_PROVIDER_ARN = /^arn:aws:iam::\d{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/;

function optionalContext(app: App, key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`Context "${key}" must be a string`);
  return value;
}

function validated(key: string, value: string | undefined, pattern: RegExp): string | undefined {
  if (value !== undefined && !pattern.test(value)) throw new Error(`Context "${key}" is invalid: ${value}`);
  return value;
}

export function readSiteDomain(app: App): SiteDomain | undefined {
  const domainName = validated('siteDomainName', optionalContext(app, 'siteDomainName'), DOMAIN_NAME);
  const certificateArn = validated(
    'siteCertificateArn',
    optionalContext(app, 'siteCertificateArn'),
    ACM_CERTIFICATE_ARN,
  );
  if (!domainName && !certificateArn) return undefined;
  if (!domainName || !certificateArn) {
    throw new Error('Context "siteDomainName" and "siteCertificateArn" must be set together');
  }
  return { domainName, certificateArn };
}

export function buildApp(options: BuildOptions = {}): FoundryApp {
  ensureLocalEsbuildOnPath();
  const app = options.app ?? new App();
  const config = options.config ?? loadConfig();
  const assets = resolveAssets(options.stubAssets === undefined ? {} : { stub: options.stubAssets });

  const appVersion = optionalContext(app, 'appVersion') ?? 'dev';
  if (!APP_VERSION.test(appVersion)) throw new Error(`Context "appVersion" is invalid: ${appVersion}`);
  const siteDomain = readSiteDomain(app);
  const existingOidcProviderArn = validated(
    'githubOidcProviderArn',
    optionalContext(app, 'githubOidcProviderArn'),
    OIDC_PROVIDER_ARN,
  );

  // Region pinned, account left to the deploying credentials: synthesis needs no AWS access and no
  // context lookups (availability zones resolve with Fn::GetAZs at deploy time).
  const env: Environment = { region: config.region };
  const tags = { project: PROJECT_TAG, environment: ENVIRONMENT_NAME };

  const foundation = new FoundationStack(app, `${STACK_PREFIX}-Foundation`, {
    env,
    tags,
    description: 'Foundry Ascent: GitHub OIDC provider and deploy role',
    terminationProtection: true,
    githubRepository: config.githubRepository,
    githubBranch: config.githubBranch,
    githubEnvironment: ENVIRONMENT_NAME,
    ...(existingOidcProviderArn ? { existingOidcProviderArn } : {}),
  });

  const data = new DataStack(app, `${STACK_PREFIX}-Data`, {
    env,
    tags,
    description: 'Foundry Ascent: VPC (isolated), Aurora Serverless v2, documents bucket, jobs queue',
    terminationProtection: true,
    config,
    uploadCorsOrigins: siteDomain
      ? [...DEFAULT_UPLOAD_CORS_ORIGINS, `https://${siteDomain.domainName}`]
      : DEFAULT_UPLOAD_CORS_ORIGINS,
  });

  const appStack = new AppStack(app, `${STACK_PREFIX}-App`, {
    env,
    tags,
    description: 'Foundry Ascent: API/worker/migrate Lambdas, CloudFront, SPA, alarms',
    config,
    appVersion,
    assets,
    cluster: data.cluster,
    clusterSecret: data.clusterSecret,
    documentsBucket: data.documentsBucket,
    databaseAccessPolicy: data.databaseAccessPolicy,
    documentsAccessPolicy: data.documentsAccessPolicy,
    jobsQueue: data.jobsQueue,
    jobsDeadLetterQueue: data.jobsDeadLetterQueue,
    ...(siteDomain ? { siteDomain } : {}),
  });

  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

  return { app, config, assets, foundation, data, appStack };
}
