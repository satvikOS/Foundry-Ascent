/**
 * Platform-wide guardrails: anything here failing means a deploy would be blocked by
 * FoundryAscent-Boundary, cost money while idle, or bypass a security control.
 */
import { Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { defaultSynth, readCdkJson, resources, resourcesOfType } from './helpers.js';

const BOUNDARY_ARN = {
  'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':policy/FoundryAscent-Boundary']],
};

describe('guardrails (all stacks)', () => {
  const synth = defaultSynth();

  it('declares the permissions boundary and recommended flags in cdk.json', () => {
    const { app, context } = readCdkJson();
    expect(app).toBe('npx tsx src/bin/app.ts');
    expect(context['@aws-cdk/core:permissionsBoundary']).toEqual({ name: 'FoundryAscent-Boundary' });
    expect(context['@aws-cdk/aws-iam:minimizePolicies']).toBe(true);
    expect(context['@aws-cdk/core:validateAgainstDefaultRules']).toBe(true);
  });

  it.each([
    'AWS::EC2::NatGateway',
    'AWS::EC2::InternetGateway',
    'AWS::EC2::EgressOnlyInternetGateway',
    'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::EIP',
    'AWS::EC2::VPCEndpoint',
    'AWS::EC2::Instance',
    'AWS::KMS::Key',
    'AWS::KMS::Alias',
    'AWS::RDS::DBProxy',
    'AWS::WAFv2::WebACL',
    'AWS::IAM::User',
    'AWS::IAM::AccessKey',
    'AWS::Logs::LogRetention',
  ])('creates no %s', (type) => {
    for (const template of synth.all) template.resourceCountIs(type, 0);
  });

  it('only creates db.serverless database instances', () => {
    for (const template of synth.all) {
      for (const [, props] of resourcesOfType(template, 'AWS::RDS::DBInstance')) {
        expect(props.DBInstanceClass).toBe('db.serverless');
      }
    }
  });

  it('uses no provisioned concurrency and keeps every Lambda outside the VPC', () => {
    for (const template of synth.all) {
      for (const [id, props] of resourcesOfType(template, 'AWS::Lambda::Function')) {
        expect(props.VpcConfig, id).toBeUndefined();
      }
      for (const type of ['AWS::Lambda::Alias', 'AWS::Lambda::Version']) {
        for (const [, props] of resourcesOfType(template, type)) {
          expect(props.ProvisionedConcurrencyConfig).toBeUndefined();
        }
      }
    }
  });

  it('attaches FoundryAscent-Boundary to every IAM role, including CDK-internal ones', () => {
    let roles = 0;
    for (const template of synth.all) {
      for (const [id, props] of resourcesOfType(template, 'AWS::IAM::Role')) {
        roles += 1;
        expect(props.PermissionsBoundary, id).toEqual(BOUNDARY_ARN);
      }
    }
    // GitHub deploy; VPC default-SG restriction; api, worker, migrate, provider framework, site deployment.
    expect(roles).toBeGreaterThanOrEqual(7);
  });

  it('gives every Lambda function a managed log group with the configured retention', () => {
    for (const template of synth.all) {
      const logGroups = resources(template);
      for (const [id, props] of resourcesOfType(template, 'AWS::Lambda::Function')) {
        const loggingConfig = props.LoggingConfig as { LogGroup?: { Ref?: string } } | undefined;
        const ref = loggingConfig?.LogGroup?.Ref;
        expect(ref, `${id} LoggingConfig.LogGroup`).toBeTypeOf('string');
        const logGroup = logGroups[ref ?? ''];
        expect(logGroup?.Type).toBe('AWS::Logs::LogGroup');
        expect(logGroup?.Properties?.RetentionInDays).toBe(synth.config.logRetentionDays);
      }
    }
  });

  it('enforces TLS on every bucket, queue and topic', () => {
    const denyInsecure = Match.objectLike({
      Effect: 'Deny',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    });
    for (const template of synth.all) {
      for (const [id, props] of resourcesOfType(template, 'AWS::S3::Bucket')) {
        expect(props.PublicAccessBlockConfiguration, id).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
        expect(props.BucketEncryption, id).toEqual({
          ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        });
      }
      const buckets = resourcesOfType(template, 'AWS::S3::Bucket').length;
      template.resourcePropertiesCountIs(
        'AWS::S3::BucketPolicy',
        { PolicyDocument: { Statement: Match.arrayWith([denyInsecure]) } },
        buckets,
      );
      const queues = resourcesOfType(template, 'AWS::SQS::Queue').length;
      template.resourcePropertiesCountIs(
        'AWS::SQS::QueuePolicy',
        { PolicyDocument: { Statement: Match.arrayWith([denyInsecure]) } },
        queues,
      );
      const topics = resourcesOfType(template, 'AWS::SNS::Topic').length;
      template.resourcePropertiesCountIs(
        'AWS::SNS::TopicPolicy',
        { PolicyDocument: { Statement: Match.arrayWith([denyInsecure]) } },
        topics,
      );
    }
  });

  it('has no unacknowledged cdk-nag AwsSolutions findings (errors or warnings)', () => {
    const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(synth.app);
    const findings = report.violations.map(
      (v) => `${v.severity} ${v.ruleName}: ${v.violatingResources.map((r) => r.constructPath).join(', ')}`,
    );
    expect(findings).toEqual([]);
    expect(report.success).toBe(true);
  });

  it('tags every stack and protects the stateful and identity stacks from deletion', () => {
    for (const stack of [synth.foundation, synth.data, synth.appStack]) {
      expect(stack.tags.tagValues()).toEqual({ project: 'foundry-ascent', environment: 'production' });
      expect(stack.region).toBe('us-east-1');
    }
    expect(synth.foundation.terminationProtection).toBe(true);
    expect(synth.data.terminationProtection).toBe(true);
    expect(synth.appStack.terminationProtection).toBe(false);
    expect(synth.appStack.dependencies.map((s) => s.stackName)).toContain('FoundryAscent-Data');
  });
});
