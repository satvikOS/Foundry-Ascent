import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { auroraEngineVersion } from '../src/stacks/data-stack.js';
import { defaultSynth, resources, resourcesOfType } from './helpers.js';

describe('FoundryAscent-Data', () => {
  const { templates } = defaultSynth();
  const template = templates.data;

  describe('network', () => {
    it('has two isolated subnets and no route to the internet', () => {
      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.resourceCountIs('AWS::EC2::Subnet', 2);
      for (const [, subnet] of resourcesOfType(template, 'AWS::EC2::Subnet')) {
        expect(subnet.MapPublicIpOnLaunch).toBe(false);
      }
      template.resourceCountIs('AWS::EC2::Route', 0);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    });

    it('logs rejected VPC traffic to the access-log bucket', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        ResourceType: 'VPC',
        TrafficType: 'REJECT',
        LogDestinationType: 's3',
      });
    });

    it('gives Aurora a security group without ingress or egress', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: Match.stringLikeRegexp('no ingress'),
        SecurityGroupIngress: Match.absent(),
        // CDK's placeholder rule for allowAllOutbound: false (matches no traffic).
        SecurityGroupEgress: [Match.objectLike({ CidrIp: '255.255.255.255/32' })],
      });
    });
  });

  describe('Aurora Serverless v2', () => {
    it('scales to zero, auto-pauses after 10 minutes and exposes the Data API', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        Engine: 'aurora-postgresql',
        EngineVersion: '16.13',
        DBClusterIdentifier: 'foundry-ascent',
        DatabaseName: 'foundry',
        MasterUsername: 'foundry_admin',
        ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 600 },
        EnableHttpEndpoint: true,
        EnableIAMDatabaseAuthentication: false,
        StorageEncrypted: true,
        KmsKeyId: Match.absent(),
        BackupRetentionPeriod: 7,
        DeletionProtection: true,
        EnableCloudwatchLogsExports: ['postgresql'],
      });
      template.hasResource('AWS::RDS::DBCluster', {
        DeletionPolicy: 'Snapshot',
        UpdateReplacePolicy: 'Snapshot',
      });
    });

    it('runs a single private serverless writer', () => {
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBInstanceClass: 'db.serverless',
        PubliclyAccessible: false,
      });
    });

    it('generates the admin secret under its fixed name and retains it with the snapshot', () => {
      template.hasResource('AWS::SecretsManager::Secret', {
        Properties: {
          Name: 'foundry-ascent/aurora-admin',
          GenerateSecretString: Match.objectLike({ SecretStringTemplate: '{"username":"foundry_admin"}' }),
          KmsKeyId: Match.absent(),
        },
        DeletionPolicy: 'RetainExceptOnCreate',
        UpdateReplacePolicy: 'Retain',
      });
    });

    it('exports postgresql logs into a log group with the configured retention, created first', () => {
      const all = resources(template);
      const [logGroupId] =
        Object.entries(all).find(
          ([, r]) =>
            r.Type === 'AWS::Logs::LogGroup' &&
            r.Properties?.LogGroupName === '/aws/rds/cluster/foundry-ascent/postgresql',
        ) ?? [];
      expect(logGroupId).toBeDefined();
      expect(all[logGroupId ?? '']?.Properties?.RetentionInDays).toBe(30);
      const [, cluster] = Object.entries(all).find(([, r]) => r.Type === 'AWS::RDS::DBCluster') ?? [];
      expect(cluster?.DependsOn).toContain(logGroupId);
    });

    it('maps only verified engine versions', () => {
      expect(auroraEngineVersion('16.13').auroraPostgresFullVersion).toBe('16.13');
      expect(() => auroraEngineVersion('15.4')).toThrow(/Unsupported Aurora PostgreSQL version/);
    });
  });

  describe('documents bucket', () => {
    it('is private, SSE-S3, unversioned, retained and logs access', () => {
      template.hasResource('AWS::S3::Bucket', {
        Properties: Match.objectLike({
          CorsConfiguration: Match.anyValue(),
          VersioningConfiguration: Match.absent(),
          LoggingConfiguration: Match.objectLike({ LogFilePrefix: 'documents/' }),
          OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        }),
        DeletionPolicy: 'RetainExceptOnCreate',
        UpdateReplacePolicy: 'Retain',
      });
    });

    it('aborts incomplete multipart uploads after one day', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        CorsConfiguration: Match.anyValue(),
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'abort-incomplete-uploads',
              Status: 'Enabled',
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        },
      });
    });

    it('allows only presigned PUT uploads from CloudFront origins', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        CorsConfiguration: {
          CorsRules: [
            {
              AllowedMethods: ['PUT'],
              AllowedOrigins: ['https://*.cloudfront.net'],
              AllowedHeaders: ['content-type', 'content-md5', 'x-amz-*'],
              ExposedHeaders: ['ETag'],
              MaxAge: 3000,
            },
          ],
        },
      });
    });

    it('rejects TLS below 1.2', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Effect: 'Deny', Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } } }),
          ]),
        },
      });
    });

    it('defines document access on tenants/* only', () => {
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        PolicyDocument: {
          Statement: [
            {
              Sid: 'DocumentObjects',
              Effect: 'Allow',
              Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
              Resource: {
                'Fn::Join': [
                  '',
                  [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^DocumentsBucket'), 'Arn'] }, '/tenants/*'],
                ],
              },
            },
            Match.objectLike({
              Sid: 'DocumentListing',
              Condition: { StringLike: { 's3:prefix': ['tenants/*'] } },
            }),
          ],
        },
      });
    });

    it('defines database access as Data API on the cluster plus the secret', () => {
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        PolicyDocument: {
          Statement: [
            {
              Sid: 'AuroraDataApi',
              Effect: 'Allow',
              Action: [
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:ExecuteStatement',
                'rds-data:RollbackTransaction',
              ],
              Resource: Match.anyValue(),
            },
            {
              Sid: 'AuroraSecret',
              Effect: 'Allow',
              Action: 'secretsmanager:GetSecretValue',
              Resource: { Ref: Match.anyValue() },
            },
          ],
        },
      });
    });
  });

  describe('jobs queue', () => {
    it('uses SSE-SQS, a 6x worker-timeout visibility and a 3-strike DLQ', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'FoundryAscent-Jobs',
        SqsManagedSseEnabled: true,
        VisibilityTimeout: 720,
        RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 3 },
      });
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'FoundryAscent-Jobs-DLQ',
        SqsManagedSseEnabled: true,
        MessageRetentionPeriod: 14 * 24 * 3600,
      });
    });
  });
});
