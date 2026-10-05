/**
 * FoundryAscent-App: Lambdas (api, worker, migrate), the SPA bucket, CloudFront and alarms.
 *
 *   CloudFront ──/*──────► S3 site bucket (OAC; SPA rewrite function; long-cache hashed assets)
 *              └─/api/*──► Lambda Function URL (OAC + AWS_IAM, RESPONSE_STREAM, uncached)
 *
 * Deploy ordering: the migrate custom resource runs first; the api and worker functions and the site
 * deployments depend on it, so new application code only goes live after its migrations have been
 * applied, and a failed migration rolls the stack back before any function or page changes.
 */
import { Aws, CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config.js';
import {
  API_VIEWER_HOST_CODE,
  createSecurityHeadersPolicy,
  createViewerRequestFunction,
  SPA_REWRITE_CODE,
} from '../constructs/edge.js';
import { PlatformFunction } from '../constructs/platform-function.js';
import {
  ENVIRONMENT_NAME,
  MIGRATE_TIMEOUT_MINUTES,
  NAMES,
  WORKER_TIMEOUT_SECONDS,
} from '../lib/constants.js';
import { migrationsChecksum } from '../lib/migrations.js';
import { retentionDays } from '../lib/logs.js';
import {
  type BedrockRuntimeAccess,
  effectiveModels,
  embeddingsAccess,
  reasoningAccess,
  usesMantle,
} from '../lib/models.js';
import {
  acknowledge,
  managedPolicy,
  type NagAcknowledgment,
  wildcardAction,
  wildcardResource,
} from '../lib/nag.js';
import type { AppAssets } from '../paths.js';

/** Optional custom domain (alternate domain name + ACM certificate in us-east-1). */
export interface SiteDomain {
  readonly domainName: string;
  readonly certificateArn: string;
}

export interface AppStackProps extends StackProps {
  readonly config: PlatformConfig;
  /** Release identifier (git SHA in CI); passed to the API and forces the migrate resource to re-run. */
  readonly appVersion: string;
  readonly assets: AppAssets;
  readonly cluster: rds.IDatabaseCluster;
  readonly clusterSecret: secretsmanager.ISecret;
  readonly documentsBucket: s3.IBucket;
  /** rds-data:* on the cluster + secretsmanager:GetSecretValue on its secret (Data stack). */
  readonly databaseAccessPolicy: iam.IManagedPolicy;
  /** Read/write on `tenants/*` of the documents bucket (Data stack). */
  readonly documentsAccessPolicy: iam.IManagedPolicy;
  readonly jobsQueue: sqs.IQueue;
  readonly jobsDeadLetterQueue: sqs.IQueue;
  readonly siteDomain?: SiteDomain;
}

/** Cache-Control for content-hashed build output under /assets/. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** Cache-Control for everything else (index.html, favicon, ...): always revalidate. */
const REVALIDATE_CACHE = 'public, max-age=0, must-revalidate';

export class AppStack extends Stack {
  readonly api: PlatformFunction;
  readonly worker: PlatformFunction;
  readonly migrate: PlatformFunction;
  readonly functionUrl: lambda.FunctionUrl;
  readonly distribution: cloudfront.Distribution;
  readonly siteBucket: s3.Bucket;
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, assets } = props;
    const logRetention = retentionDays(config.logRetentionDays);
    const siteOrigin = props.siteDomain ? `https://${props.siteDomain.domainName}` : undefined;
    const models = effectiveModels(config.models);

    // ---- Runtime contract environment ----------------------------------------------------------------
    const baseEnvironment: Record<string, string> = {
      APP_ENV: ENVIRONMENT_NAME,
      APP_VERSION: props.appVersion,
      LOG_LEVEL: 'info',
      DB_DRIVER: 'dataapi',
      DB_CLUSTER_ARN: props.cluster.clusterArn,
      DB_SECRET_ARN: props.clusterSecret.secretArn,
      DB_NAME: NAMES.databaseName,
      DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
      JOBS_QUEUE_URL: props.jobsQueue.queueUrl,
      MODEL_PROVIDER: 'bedrock',
      MODEL_PRIMARY_ID: models.primary,
      MODEL_FALLBACK_ID: models.fallback,
      MODEL_EMBEDDINGS_ID: models.embeddings,
      BEDROCK_REGION: config.region,
      OWNER_ACCESS_CODE_PREFIX: config.owner.accessCodePrefix,
      OWNER_ACCESS_CODE_HASH: config.owner.accessCodeHash,
      OWNER_DISPLAY_NAME: config.owner.displayName,
      HOME_TENANT_SLUG: config.homeTenant.slug,
      HOME_TENANT_NAME: config.homeTenant.name,
    };
    // SITE_ORIGIN is only known up front with a custom domain. Otherwise the distribution domain is
    // generated by CloudFront and referencing it here would create a cycle (distribution -> Function URL
    // -> function -> distribution); the API then derives its origin from VIEWER_HOST_HEADER.
    const apiEnvironment = siteOrigin ? { ...baseEnvironment, SITE_ORIGIN: siteOrigin } : baseEnvironment;

    const functionDefaults = {
      depsLockFilePath: assets.depsLockFilePath,
      projectRoot: assets.projectRoot,
      logRetention,
    };

    // ---- Functions ---------------------------------------------------------------------------------------
    this.migrate = new PlatformFunction(this, 'Migrate', {
      ...functionDefaults,
      functionName: NAMES.migrateFunction,
      description: 'CloudFormation custom resource: database migrations, synthetic seed, seed embeddings',
      entry: assets.handlers.migrate,
      memorySize: 1024,
      timeout: Duration.minutes(MIGRATE_TIMEOUT_MINUTES),
      environment: baseEnvironment,
    });

    this.api = new PlatformFunction(this, 'Api', {
      ...functionDefaults,
      functionName: NAMES.apiFunction,
      description: 'Foundry Ascent HTTP API (Hono, response streaming) behind CloudFront',
      entry: assets.handlers.api,
      memorySize: config.api.memoryMb,
      timeout: Duration.seconds(config.api.timeoutSeconds),
      reservedConcurrentExecutions: config.api.reservedConcurrency,
      environment: apiEnvironment,
    });

    this.worker = new PlatformFunction(this, 'Worker', {
      ...functionDefaults,
      functionName: NAMES.workerFunction,
      description: 'Foundry Ascent jobs worker (document ingestion, recaps, memory consolidation)',
      entry: assets.handlers.worker,
      memorySize: 1024,
      timeout: Duration.seconds(WORKER_TIMEOUT_SECONDS),
      environment: baseEnvironment,
    });

    // ---- Permissions -------------------------------------------------------------------------------------
    // Database and document access are managed policies owned by the Data stack (next to the resources
    // they cover); this stack decides which function gets which.
    for (const fn of [this.api, this.worker]) {
      fn.role.addManagedPolicy(props.databaseAccessPolicy);
      fn.role.addManagedPolicy(props.documentsAccessPolicy);
    }
    this.migrate.role.addManagedPolicy(props.databaseAccessPolicy);
    props.jobsQueue.grantSendMessages(this.api.role);

    // Bedrock: only the effective models (lib/models.ts). Foundation models are granted in every region
    // (`*` also matches the region-less ARN global profiles use), profiles in the invoking region.
    const foundationModelArn = (modelId: string): string =>
      `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${modelId}`;
    const profileArn = (profileId: string): string =>
      `arn:${Aws.PARTITION}:bedrock:${config.region}:${Aws.ACCOUNT_ID}:inference-profile/${profileId}`;
    const runtimeResources = (access: BedrockRuntimeAccess): string[] => [
      ...access.foundationModels.map(foundationModelArn),
      ...access.inferenceProfiles.map(profileArn),
    ];
    const reasoningResources = [
      ...runtimeResources(reasoningAccess(models)),
      ...runtimeResources(embeddingsAccess(models)),
    ];
    const embeddingResources = runtimeResources(embeddingsAccess(models));

    const reasoningStatements = [
      new iam.PolicyStatement({
        sid: 'BedrockRuntimeModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: reasoningResources,
      }),
    ];
    if (usesMantle(models)) {
      reasoningStatements.push(
        new iam.PolicyStatement({
          sid: 'BedrockMantleInference',
          actions: ['bedrock-mantle:CreateInference'],
          resources: ['*'],
        }),
      );
    }
    for (const fn of [this.api, this.worker]) {
      for (const statement of reasoningStatements) fn.role.addToPolicy(statement);
    }
    // Seeding computes embeddings only.
    this.migrate.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockEmbeddings',
        actions: ['bedrock:InvokeModel'],
        resources: embeddingResources,
      }),
    );

    const foundationModelAcks = (resourceArns: readonly string[]): NagAcknowledgment[] =>
      resourceArns
        .filter((arn) => arn.includes(':bedrock:*::foundation-model/'))
        .map((arn) => ({
          id: wildcardResource(this, arn),
          reason:
            'Foundation-model ARNs carry no account; the region is a wildcard because cross-region (us.) and global inference profiles route to other regions. The model id itself is pinned.',
        }));
    for (const fn of [this.api, this.worker]) {
      acknowledge(fn.role, ...foundationModelAcks(reasoningResources));
      if (usesMantle(models)) {
        acknowledge(fn.role, {
          id: wildcardResource(this, '*'),
          reason:
            'bedrock-mantle:CreateInference (GPT-6 Luna on the OpenAI-compatible Mantle endpoint) does not support resource-level permissions; it is the only action granted on *.',
        });
      }
    }
    acknowledge(this.migrate.role, ...foundationModelAcks(embeddingResources));

    // ---- Worker: SQS event source --------------------------------------------------------------------------
    this.worker.function.addEventSource(
      new SqsEventSource(props.jobsQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        // Caps concurrent pollers so ingestion bursts cannot exhaust Aurora (2 ACU) or the AI budget.
        maxConcurrency: 2,
      }),
    );

    // ---- Migrations custom resource -----------------------------------------------------------------------
    const providerLogGroup = new logs.LogGroup(this, 'MigrateProviderLogs', {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const migrateProvider = new cr.Provider(this, 'MigrateProvider', {
      onEventHandler: this.migrate.function,
      logGroup: providerLogGroup,
    });
    const migrations = new CustomResource(this, 'Migrations', {
      serviceToken: migrateProvider.serviceToken,
      resourceType: 'Custom::FoundryMigrations',
      properties: {
        version: props.appVersion,
        migrationsChecksum: migrationsChecksum(assets.migrationsDir),
      },
    });
    this.api.node.addDependency(migrations);
    this.worker.node.addDependency(migrations);
    acknowledge(
      migrateProvider.node.findChild('framework-onEvent'),
      {
        id: managedPolicy('service-role/AWSLambdaBasicExecutionRole'),
        reason:
          'CDK custom-resource provider framework function (aws-cdk-lib managed); it only relays CloudFormation events to FoundryAscent-Migrate and writes its own logs.',
      },
      {
        id: wildcardResource(this, `${this.migrate.function.functionArn}:*`),
        reason:
          'Generated by the provider framework so it can invoke any version/alias of the single migrate function; the function itself is pinned.',
      },
    );

    // ---- API Function URL ------------------------------------------------------------------------------------
    this.functionUrl = this.api.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ---- Site bucket ------------------------------------------------------------------------------------------
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    acknowledge(this.siteBucket, {
      id: 'AwsSolutions-S1',
      reason:
        'Holds only the public SPA build. Reads come solely from CloudFront (OAC) and writes solely from the BucketDeployment; logging into the Data stack bucket would need a cross-stack bucket-policy cycle.',
    });

    // ---- CloudFront -------------------------------------------------------------------------------------------
    const securityHeaders = createSecurityHeadersPolicy(this, 'SecurityHeaders');
    const spaRewrite = createViewerRequestFunction(
      this,
      'SpaRewriteFunction',
      SPA_REWRITE_CODE,
      'SPA routing: extension-less paths -> /index.html',
    );
    const apiViewerHost = createViewerRequestFunction(
      this,
      'ApiViewerHostFunction',
      API_VIEWER_HOST_CODE,
      'Pass the viewer Host to the API',
    );

    const certificate = props.siteDomain
      ? acm.Certificate.fromCertificateArn(this, 'SiteCertificate', props.siteDomain.certificateArn)
      : undefined;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Foundry Ascent',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      ...(props.siteDomain && certificate
        ? {
            domainNames: [props.siteDomain.domainName],
            certificate,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.functionUrl, {
            // Matches the API timeout so long streamed turns are not cut at the 30 s default.
            readTimeout: Duration.seconds(config.api.timeoutSeconds),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Compression would buffer text/event-stream turn streams.
          compress: false,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          functionAssociations: [
            { function: apiViewerHost, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
    });

    // Since October 2025 a Function URL call also needs lambda:InvokeFunction. FunctionUrlOrigin only
    // grants lambda:InvokeFunctionUrl, so add the second permission, limited to Function URL invocations
    // from this distribution.
    this.api.function.addPermission('CloudFrontInvokeViaFunctionUrl', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    acknowledge(
      this.distribution,
      {
        id: 'AwsSolutions-CFR1',
        reason:
          'The platform serves partner universities in several countries; no geography is excluded by policy.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'wafv2:CreateWebACL is denied by FoundryAscent-Boundary (cost guardrail). Abuse controls live in the API: per-IP sign-in lockout, per-principal turn rate limits, daily AI spend caps, reserved concurrency.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason:
          'Standard logging v1 needs an ACL-enabled bucket, which conflicts with BucketOwnerEnforced everywhere. Requests are traced in the API logs (request id per line) and the 5xx-rate alarm covers availability.',
      },
      ...(props.siteDomain
        ? []
        : [
            {
              id: 'AwsSolutions-CFR4',
              reason:
                'Without a custom domain the distribution uses the *.cloudfront.net certificate, whose security policy CloudFront fixes at TLSv1. Passing siteDomainName + siteCertificateArn enforces TLSv1.2_2021.',
            },
          ]),
    );

    // ---- Site deployment ---------------------------------------------------------------------------------------
    // Two passes over the same build: content-hashed assets first (immutable), then everything else
    // (index.html last, always revalidated). `include`/`exclude` keep each pass's prune to its own files.
    const deploymentLogs = new logs.LogGroup(this, 'SiteDeploymentLogs', {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const siteSource = s3deploy.Source.asset(assets.webDist);
    const deployAssets = new s3deploy.BucketDeployment(this, 'DeploySiteAssets', {
      sources: [siteSource],
      destinationBucket: this.siteBucket,
      exclude: ['*'],
      include: ['assets/*'],
      prune: true,
      cacheControl: [s3deploy.CacheControl.fromString(IMMUTABLE_CACHE)],
      memoryLimit: 512,
      logGroup: deploymentLogs,
      outputObjectKeys: false,
    });
    const deployShell = new s3deploy.BucketDeployment(this, 'DeploySiteShell', {
      sources: [siteSource],
      destinationBucket: this.siteBucket,
      exclude: ['assets/*'],
      prune: true,
      cacheControl: [s3deploy.CacheControl.fromString(REVALIDATE_CACHE)],
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
      logGroup: deploymentLogs,
      outputObjectKeys: false,
    });
    // Publish the new SPA only after migrations succeeded, like the functions; shell after assets.
    deployAssets.node.addDependency(migrations);
    deployShell.node.addDependency(deployAssets);

    // Both deployments share one singleton handler (aws-cdk-lib managed); acknowledge its findings once.
    const deploymentRole = deployShell.handlerRole;
    const deploymentHandler = deploymentRole.node.scope;
    if (!deploymentHandler) throw new Error('BucketDeployment handler role has no parent construct');
    const stagingBucketObjects = `arn:${this.partition}:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`;
    acknowledge(
      deploymentRole,
      {
        id: managedPolicy('service-role/AWSLambdaBasicExecutionRole'),
        reason:
          'BucketDeployment handler (aws-cdk-lib managed singleton); the managed policy only lets it write its own logs.',
      },
      ...['s3:GetBucket*', 's3:GetObject*', 's3:List*', 's3:Abort*', 's3:DeleteObject*'].map((action) => ({
        id: wildcardAction(action),
        reason:
          'Generated by BucketDeployment (aws s3 sync with prune) and scoped to the CDK asset staging bucket and the site bucket only.',
      })),
      {
        id: wildcardResource(this, stagingBucketObjects),
        reason:
          'Reads the zipped SPA build from the CDK bootstrap asset bucket (object keys are content hashes).',
      },
      {
        id: wildcardResource(this, `${this.siteBucket.bucketArn}/*`),
        reason: 'Syncs (writes and prunes) every object of the site bucket, which holds only the SPA build.',
      },
      {
        id: wildcardResource(this, '*'),
        reason:
          'cloudfront:CreateInvalidation/GetInvalidation are granted on * by BucketDeployment; invalidating the cache is the only effect.',
      },
    );
    acknowledge(deploymentHandler, {
      id: 'AwsSolutions-L1',
      reason:
        'The BucketDeployment handler runtime (Python, AWS CLI layer) is chosen and upgraded by aws-cdk-lib together with its bundled AWS CLI; it is not application code.',
    });

    // ---- Alarms -------------------------------------------------------------------------------------------------
    // No KMS key: CloudWatch alarm actions cannot publish to a topic encrypted with the AWS-managed aws/sns
    // key, and customer keys are denied by the boundary. The topic carries alarm metadata only.
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: NAMES.alarmTopic,
      displayName: 'Foundry Ascent alarms',
      enforceSSL: true,
    });
    this.alarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarms',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alarmTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': `arn:${Aws.PARTITION}:cloudwatch:${Aws.REGION}:${Aws.ACCOUNT_ID}:alarm:*`,
          },
        },
      }),
    );
    const alarmAction = new cwActions.SnsAction(this.alarmTopic);
    const fiveMinutes = Duration.minutes(5);
    const alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, 'ApiErrorsAlarm', {
        alarmName: 'FoundryAscent-Api-Errors',
        alarmDescription: 'API Lambda invocations failed (unhandled errors or timeouts)',
        metric: this.api.function.metricErrors({ period: fiveMinutes, statistic: cloudwatch.Stats.SUM }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'ApiThrottlesAlarm', {
        alarmName: 'FoundryAscent-Api-Throttles',
        alarmDescription: 'API Lambda throttled (reserved concurrency exhausted)',
        metric: this.api.function.metricThrottles({ period: fiveMinutes, statistic: cloudwatch.Stats.SUM }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
        alarmName: 'FoundryAscent-Worker-Errors',
        alarmDescription: 'Worker Lambda invocations failed',
        metric: this.worker.function.metricErrors({ period: fiveMinutes, statistic: cloudwatch.Stats.SUM }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'JobsDlqAlarm', {
        alarmName: 'FoundryAscent-Jobs-DLQ-NotEmpty',
        alarmDescription: 'Jobs failed 3 times and were moved to the dead-letter queue',
        metric: props.jobsDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: fiveMinutes,
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'CloudFront5xxAlarm', {
        alarmName: 'FoundryAscent-CloudFront-5xxRate',
        alarmDescription:
          'More than 5% of viewer requests returned 5xx in 2 of the last 3 five-minute periods',
        // CloudFront publishes with dimensions DistributionId + Region=Global; Distribution.metric5xxErrorRate()
        // only sets DistributionId, which matches no data, so the metric is spelled out.
        metric: new cloudwatch.Metric({
          namespace: 'AWS/CloudFront',
          metricName: '5xxErrorRate',
          dimensionsMap: { DistributionId: this.distribution.distributionId, Region: 'Global' },
          period: fiveMinutes,
          statistic: cloudwatch.Stats.AVERAGE,
        }),
        threshold: 5,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(alarmAction);

    // ---- Outputs -----------------------------------------------------------------------------------------------
    new CfnOutput(this, 'SiteUrl', {
      value: siteOrigin ?? `https://${this.distribution.distributionDomainName}`,
      description: 'Public URL of the web app',
    });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'ApiFunctionName', { value: this.api.function.functionName });
    new CfnOutput(this, 'ClusterArn', { value: props.cluster.clusterArn });
    new CfnOutput(this, 'SecretArn', { value: props.clusterSecret.secretArn });
    new CfnOutput(this, 'DocumentsBucket', { value: props.documentsBucket.bucketName });
    new CfnOutput(this, 'JobsQueueUrl', { value: props.jobsQueue.queueUrl });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
  }
}
