/**
 * A platform Lambda: Node 24 on ARM64, bundled locally by esbuild as ESM, with its own role (logs scoped to
 * its own log group, no AWS managed policies) and a log group with the configured retention.
 */
import { type Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {
  Charset,
  LogLevel,
  NodejsFunction,
  OutputFormat,
  SourceMapMode,
} from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { LAMBDA_CONTRACT } from '../lib/lambda-contract.js';

/**
 * Prepended to every bundle. CommonJS dependencies bundled into ESM call `require` (esbuild's `__require`
 * shim) and may read `__filename`/`__dirname`, none of which exist in an ES module. The values are set on
 * globalThis rather than declared with `const`, so they cannot collide with a top-level binding of the
 * same name inside a bundled module. Single source of truth: `apps/api/lambda-contract.json`, which the
 * API's own bundle check (`pnpm --filter @foundry/api check:bundles`) uses too.
 */
export const ESM_REQUIRE_SHIM = LAMBDA_CONTRACT.bundling.banner.join(' ');

/**
 * Modules left out of the bundle (lambda-contract.json). `pg-native` is an optional peer of `pg` that is
 * never installed (the pure-JS client is used). The AWS SDK v3 is bundled on purpose so the deployed code
 * runs the exact versions in pnpm-lock.yaml rather than whatever the Lambda runtime ships.
 */
export const BUNDLE_EXTERNALS: readonly string[] = LAMBDA_CONTRACT.bundling.externalModules;

export interface PlatformFunctionProps {
  readonly functionName: string;
  readonly description: string;
  readonly entry: string;
  readonly depsLockFilePath: string;
  readonly projectRoot: string;
  readonly memorySize: number;
  readonly timeout: Duration;
  readonly logRetention: logs.RetentionDays;
  readonly environment: Readonly<Record<string, string>>;
  /** Omitted (or null): the function shares the account's unreserved concurrency pool. */
  readonly reservedConcurrentExecutions?: number | null;
}

export class PlatformFunction extends Construct {
  readonly function: NodejsFunction;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: PlatformFunctionProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for ${props.functionName}`,
    });
    // CreateLogStream + PutLogEvents on this function's log group only (replaces AWSLambdaBasicExecutionRole).
    this.logGroup.grantWrite(this.role);

    this.function = new NodejsFunction(this, 'Function', {
      functionName: props.functionName,
      description: props.description,
      entry: props.entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize,
      timeout: props.timeout,
      role: this.role,
      logGroup: this.logGroup,
      ...(props.reservedConcurrentExecutions === undefined || props.reservedConcurrentExecutions === null
        ? {}
        : { reservedConcurrentExecutions: props.reservedConcurrentExecutions }),
      recursiveLoop: lambda.RecursiveLoop.TERMINATE,
      depsLockFilePath: props.depsLockFilePath,
      projectRoot: props.projectRoot,
      environment: { ...props.environment, NODE_OPTIONS: '--enable-source-maps' },
      bundling: {
        forceDockerBundling: false,
        format: OutputFormat.ESM,
        target: LAMBDA_CONTRACT.bundling.target,
        mainFields: [...LAMBDA_CONTRACT.bundling.mainFields],
        banner: ESM_REQUIRE_SHIM,
        externalModules: [...BUNDLE_EXTERNALS],
        minify: true,
        keepNames: true,
        sourceMap: true,
        sourceMapMode: SourceMapMode.DEFAULT,
        sourcesContent: false,
        charset: Charset.UTF8,
        logLevel: LogLevel.WARNING,
      },
    });
  }
}
