/**
 * FoundryAscent-Data (termination protected): everything that holds state.
 *
 *  - VPC with isolated subnets only (no IGW, no NAT, no endpoints): Aurora needs a subnet group, nothing in
 *    the VPC needs the internet, and Lambdas reach the database through the RDS Data API, not the VPC.
 *  - Aurora Serverless v2 PostgreSQL (scales to 0 ACU, auto-pause), Data API on, AWS-managed encryption.
 *  - Documents bucket (presigned uploads), access-log bucket, jobs queue + DLQ.
 */
import { CfnResource, Duration, RemovalPolicy, Resource, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config.js';
import {
  DEFAULT_UPLOAD_CORS_ORIGINS,
  DOCUMENTS_PREFIX,
  JOBS_MAX_RECEIVE_COUNT,
  JOBS_VISIBILITY_TIMEOUT_SECONDS,
  NAMES,
} from '../lib/constants.js';
import { retentionDays } from '../lib/logs.js';
import { acknowledge, wildcardResource } from '../lib/nag.js';

/** Engine versions this app has been verified against (config `aurora.engineVersion`). */
const AURORA_POSTGRES_VERSIONS: Readonly<Record<string, rds.AuroraPostgresEngineVersion>> = {
  '16.13': rds.AuroraPostgresEngineVersion.VER_16_13,
};

export function auroraEngineVersion(version: string): rds.AuroraPostgresEngineVersion {
  const engineVersion = AURORA_POSTGRES_VERSIONS[version];
  if (!engineVersion) {
    throw new Error(
      `Unsupported Aurora PostgreSQL version "${version}" (supported: ${Object.keys(AURORA_POSTGRES_VERSIONS).join(', ')})`,
    );
  }
  return engineVersion;
}

export interface DataStackProps extends StackProps {
  readonly config: PlatformConfig;
  /**
   * Browser origins allowed to PUT presigned uploads to the documents bucket. Defaults to
   * `https://*.cloudfront.net` (see DEFAULT_UPLOAD_CORS_ORIGINS for why the exact distribution origin is
   * not used); a custom site domain is added by the app when configured.
   */
  readonly uploadCorsOrigins?: readonly string[];
}

export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly cluster: rds.DatabaseCluster;
  readonly clusterSecret: secretsmanager.ISecret;
  readonly documentsBucket: s3.Bucket;
  readonly accessLogsBucket: s3.Bucket;
  readonly jobsQueue: sqs.Queue;
  readonly jobsDeadLetterQueue: sqs.Queue;
  /** Attach to roles that query the database through the Data API. */
  readonly databaseAccessPolicy: iam.ManagedPolicy;
  /** Attach to roles that read/write venture documents. */
  readonly documentsAccessPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const retention = retentionDays(config.logRetentionDays);

    // ---- Access logs (S3 server access logs, VPC flow logs) ----------------------------------------
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          expiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    // ---- Network: isolated subnets only ------------------------------------------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      createInternetGateway: false,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    this.vpc.addFlowLog('RejectedTrafficFlowLog', {
      destination: ec2.FlowLogDestination.toS3(this.accessLogsBucket, 'vpc-flow-logs/'),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });
    this.manageRestrictDefaultSgLogs(retention);

    // ---- Aurora Serverless v2 PostgreSQL ------------------------------------------------------------
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc: this.vpc,
      description: 'Aurora cluster: no ingress; applications use the RDS Data API',
      allowAllOutbound: false,
    });

    // Created explicitly (instead of cloudwatchLogsRetention, which deploys a log-retention Lambda) and
    // before the cluster, so RDS exports into a group that already has the configured retention.
    const postgresqlLogs = new logs.LogGroup(this, 'AuroraPostgresqlLogs', {
      logGroupName: `/aws/rds/cluster/${NAMES.auroraCluster}/postgresql`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.cluster = new rds.DatabaseCluster(this, 'Aurora', {
      clusterIdentifier: NAMES.auroraCluster,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: auroraEngineVersion(config.aurora.engineVersion),
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        publiclyAccessible: false,
        autoMinorVersionUpgrade: true,
      }),
      serverlessV2MinCapacity: config.aurora.minCapacityAcu,
      serverlessV2MaxCapacity: config.aurora.maxCapacityAcu,
      serverlessV2AutoPauseDuration: Duration.minutes(config.aurora.autoPauseMinutes),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret(NAMES.auroraUser, { secretName: NAMES.auroraSecret }),
      defaultDatabaseName: NAMES.databaseName,
      enableDataApi: true,
      iamAuthentication: false,
      // AWS-managed key (aws/rds): no storageEncryptionKey, customer KMS keys are denied by the boundary.
      storageEncrypted: true,
      backup: { retention: Duration.days(7), preferredWindow: '07:00-08:00' },
      preferredMaintenanceWindow: 'sun:08:30-sun:09:30',
      copyTagsToSnapshot: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
    });
    this.cluster.node.addDependency(postgresqlLogs);

    const secret = this.cluster.secret;
    if (!secret) throw new Error('Aurora cluster secret was not generated');
    this.clusterSecret = secret;

    acknowledge(this.cluster, {
      id: 'AwsSolutions-RDS6',
      reason:
        'Applications connect only through the RDS Data API, which authenticates with IAM (rds-data:*) and the Secrets Manager secret. There is no network path for IAM database tokens: subnets are isolated and the security group has no ingress.',
    });
    // `cluster.secret` is the attachment; the generated DatabaseSecret is the cluster's `Secret` child.
    // Keep it when the cluster is deleted (restoring the final snapshot needs these credentials), except
    // when it was created by a first deploy that is rolling back.
    const generatedSecret = this.cluster.node.findChild('Secret');
    if (!(generatedSecret instanceof Resource)) throw new Error('Aurora generated secret not found');
    generatedSecret.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);
    acknowledge(generatedSecret, {
      id: 'AwsSolutions-SMG4',
      reason:
        'Hosted rotation needs a Lambda in the VPC with a route to Secrets Manager (VPC endpoint or NAT), both denied by FoundryAscent-Boundary. Only the platform Lambda roles are granted read access; rotation is a manual runbook step.',
    });

    // ---- Documents bucket ------------------------------------------------------------------------------
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'documents/',
      lifecycleRules: [
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      cors: [
        {
          // Browsers upload directly with a presigned PUT; nothing else is allowed cross-origin.
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [...(props.uploadCorsOrigins ?? DEFAULT_UPLOAD_CORS_ORIGINS)],
          allowedHeaders: ['content-type', 'content-md5', 'x-amz-*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    // ---- Access policies (attached to roles by the App stack) ----------------------------------------
    this.databaseAccessPolicy = new iam.ManagedPolicy(this, 'DatabaseAccessPolicy', {
      description: 'Foundry Ascent: query Aurora through the RDS Data API',
      statements: [
        new iam.PolicyStatement({
          sid: 'AuroraDataApi',
          actions: [
            'rds-data:ExecuteStatement',
            'rds-data:BatchExecuteStatement',
            'rds-data:BeginTransaction',
            'rds-data:CommitTransaction',
            'rds-data:RollbackTransaction',
          ],
          resources: [this.cluster.clusterArn],
        }),
        new iam.PolicyStatement({
          // The Data API reads the credentials with the caller's permissions.
          sid: 'AuroraSecret',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [secret.secretArn],
        }),
      ],
    });

    const documentObjects = this.documentsBucket.arnForObjects(`${DOCUMENTS_PREFIX}*`);
    this.documentsAccessPolicy = new iam.ManagedPolicy(this, 'DocumentsAccessPolicy', {
      description: 'Foundry Ascent: read/write venture documents (tenants/ prefix)',
      statements: [
        new iam.PolicyStatement({
          sid: 'DocumentObjects',
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [documentObjects],
        }),
        new iam.PolicyStatement({
          // Lets HeadObject on a missing key return 404 instead of 403, within the tenants/ prefix only.
          sid: 'DocumentListing',
          actions: ['s3:ListBucket'],
          resources: [this.documentsBucket.bucketArn],
          conditions: { StringLike: { 's3:prefix': [`${DOCUMENTS_PREFIX}*`] } },
        }),
      ],
    });
    acknowledge(this.documentsAccessPolicy, {
      id: wildcardResource(this, documentObjects),
      reason:
        'Venture documents are keyed tenants/{tenant}/ventures/{venture}/documents/{id}/{file}; per-object authorization happens in the API (authz + RLS) before any presigned URL is issued or object read.',
    });

    // ---- Jobs queue + DLQ (SSE-SQS) --------------------------------------------------------------------
    this.jobsDeadLetterQueue = new sqs.Queue(this, 'JobsDeadLetterQueue', {
      queueName: NAMES.jobsDlq,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    this.jobsQueue = new sqs.Queue(this, 'JobsQueue', {
      queueName: NAMES.jobsQueue,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(JOBS_VISIBILITY_TIMEOUT_SECONDS),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.jobsDeadLetterQueue, maxReceiveCount: JOBS_MAX_RECEIVE_COUNT },
    });
  }

  /**
   * `restrictDefaultSecurityGroup` deploys a CDK-managed custom resource Lambda that would otherwise log
   * to a log group Lambda creates on first run, without retention. Point it at a managed log group.
   */
  private manageRestrictDefaultSgLogs(retention: logs.RetentionDays): void {
    const provider = this.node.tryFindChild('Custom::VpcRestrictDefaultSGCustomResourceProvider');
    const handler = provider?.node.tryFindChild('Handler');
    if (!CfnResource.isCfnResource(handler)) {
      throw new Error(
        'VPC default security group restriction handler not found (aws-cdk-lib internals changed)',
      );
    }
    const logGroup = new logs.LogGroup(this, 'RestrictDefaultSgLogs', {
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    handler.addPropertyOverride('LoggingConfig', { LogGroup: logGroup.logGroupName });
  }
}
