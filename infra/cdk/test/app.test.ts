import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, documentsUploadOrigin } from '../src/constructs/edge.js';
import { ESM_REQUIRE_SHIM } from '../src/constructs/platform-function.js';
import {
  API_DB_RESUME_BUDGET_SECONDS,
  API_ORIGIN_READ_TIMEOUT_SECONDS,
  API_SSE_KEEP_ALIVE_SECONDS,
  JOBS_MAX_RECEIVE_COUNT,
  VIEWER_HOST_HEADER,
  VIEWER_IP_HEADER,
} from '../src/lib/constants.js';
import { environmentNames } from '../src/lib/lambda-contract.js';
import { assertTiming } from '../src/stacks/app-stack.js';
import { loadConfig } from '../src/config.js';
import { effectiveModels } from '../src/lib/models.js';
import { migrationsChecksum } from '../src/lib/migrations.js';
import { MIGRATIONS_DIR } from '../src/paths.js';
import { defaultSynth, functionPolicyStatements, resources, resourcesOfType, synthesize } from './helpers.js';

const FUNCTIONS = [
  ['FoundryAscent-Api', 'api'],
  ['FoundryAscent-Worker', 'worker'],
  ['FoundryAscent-Migrate', 'migrate'],
] as const;

type Props = Record<string, unknown>;

/** Asymmetric matcher for logical ids (typed `unknown` instead of jest's `any`). */
const startsWith = (prefix: string): unknown => expect.stringMatching(new RegExp(`^${prefix}`));

describe('FoundryAscent-App', () => {
  const synth = defaultSynth();
  const template = synth.templates.app;
  const models = effectiveModels(synth.config.models);
  const all = resources(template);

  const fn = (name: string): [string, Props] => {
    const found = resourcesOfType(template, 'AWS::Lambda::Function').find(([, p]) => p.FunctionName === name);
    if (!found) throw new Error(`function ${name} not found`);
    return found;
  };
  const envOf = (name: string): Record<string, unknown> =>
    (fn(name)[1].Environment as { Variables: Record<string, unknown> } | undefined)?.Variables ?? {};
  const rolePolicyStatements = (functionName: string): Props[] =>
    functionPolicyStatements(template, functionName);

  describe('Lambda functions', () => {
    it.each([
      ['FoundryAscent-Api', 1024, 60],
      ['FoundryAscent-Worker', 1024, 120],
      ['FoundryAscent-Migrate', 1024, 600],
    ])('%s runs Node 24 on ARM64 (%i MB, %i s) with source maps', (name, memory, timeout) => {
      const [, props] = fn(name);
      expect(props).toMatchObject({
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
        MemorySize: memory,
        Timeout: timeout,
      });
      expect(envOf(name).NODE_OPTIONS).toBe('--enable-source-maps');
    });

    it('reserves no concurrency by default (production.json: api.reservedConcurrency = null)', () => {
      expect(synth.config.api.reservedConcurrency).toBeNull();
      expect(synth.config.worker.reservedConcurrency).toBeNull();
      expect(fn('FoundryAscent-Api')[1]).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(fn('FoundryAscent-Worker')[1]).not.toHaveProperty('ReservedConcurrentExecutions');
    });

    it('passes exactly the lambda-contract environment of each role', () => {
      for (const [name, role] of FUNCTIONS) {
        const env = envOf(name);
        expect(Object.keys(env).sort(), name).toEqual([...environmentNames(role), 'NODE_OPTIONS'].sort());
        expect(env).toMatchObject({
          APP_ENV: 'production',
          APP_VERSION: 'test-sha',
          DB_DRIVER: 'dataapi',
          DB_NAME: 'foundry',
          MODEL_PROVIDER: 'bedrock',
          MODEL_PRIMARY_ID: models.primary,
          MODEL_FALLBACK_ID: models.fallback,
          MODEL_EMBEDDINGS_ID: models.embeddings,
          BEDROCK_REGION: 'us-east-1',
          HOME_TENANT_SLUG: 'ain',
        });
        // Never the pg driver in Lambda, and no SITE_ORIGIN without a custom domain (see README).
        expect(env).not.toHaveProperty('DATABASE_URL');
        expect(env).not.toHaveProperty('SITE_ORIGIN');
      }
      // Role-specific values: the owner's code hash reaches only the migrate function.
      expect(envOf('FoundryAscent-Migrate')).toMatchObject({
        OWNER_ACCESS_CODE_PREFIX: synth.config.owner.accessCodePrefix,
        OWNER_ACCESS_CODE_HASH: synth.config.owner.accessCodeHash,
        OWNER_DISPLAY_NAME: 'Platform Owner',
        HOME_TENANT_NAME: 'Ain Foundry',
      });
      expect(envOf('FoundryAscent-Api')).not.toHaveProperty('OWNER_ACCESS_CODE_HASH');
      expect(envOf('FoundryAscent-Worker')).not.toHaveProperty('OWNER_ACCESS_CODE_HASH');
      expect(envOf('FoundryAscent-Api').DB_RESUME_BUDGET_MS).toBe(
        String(API_DB_RESUME_BUDGET_SECONDS * 1000),
      );
      expect(envOf('FoundryAscent-Worker').JOBS_MAX_RECEIVE_COUNT).toBe(String(JOBS_MAX_RECEIVE_COUNT));
      expect(envOf('FoundryAscent-Worker')).not.toHaveProperty('JOBS_QUEUE_URL');
    });

    it('reserves concurrency only when configured', () => {
      const config = loadConfig();
      const { templates } = synthesize(
        {},
        {
          ...config,
          api: { ...config.api, reservedConcurrency: 5 },
          worker: { reservedConcurrency: 2 },
        },
      );
      const reserved = (name: string): unknown =>
        resourcesOfType(templates.app, 'AWS::Lambda::Function').find(([, p]) => p.FunctionName === name)?.[1]
          .ReservedConcurrentExecutions;
      expect(reserved('FoundryAscent-Api')).toBe(5);
      expect(reserved('FoundryAscent-Worker')).toBe(2);
      expect(reserved('FoundryAscent-Migrate')).toBeUndefined();
    });

    it('bundles ESM with a require/__dirname shim', () => {
      expect(ESM_REQUIRE_SHIM).toContain('createRequire');
      expect(ESM_REQUIRE_SHIM).not.toMatch(/\b(const|let|var) (require|__dirname|__filename)\b/);
    });
  });

  describe('permissions', () => {
    it('attaches the Data stack access policies (database to all, documents to api and worker)', () => {
      const managed = (name: string): unknown[] => {
        const roleRef = (fn(name)[1].Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
        return (all[roleRef]?.Properties?.ManagedPolicyArns as unknown[] | undefined) ?? [];
      };
      const outputName = (value: unknown): string =>
        (value as { 'Fn::GetStackOutput': { OutputName: string } })['Fn::GetStackOutput'].OutputName;
      expect(managed('FoundryAscent-Api').map(outputName)).toEqual([
        expect.stringMatching(/DatabaseAccessPolicy/),
        expect.stringMatching(/DocumentsAccessPolicy/),
      ]);
      expect(managed('FoundryAscent-Worker').map(outputName)).toEqual([
        expect.stringMatching(/DatabaseAccessPolicy/),
        expect.stringMatching(/DocumentsAccessPolicy/),
      ]);
      expect(managed('FoundryAscent-Migrate').map(outputName)).toEqual([
        expect.stringMatching(/DatabaseAccessPolicy/),
      ]);
    });

    it('lets the API send jobs and the worker consume them; migrate only embeds', () => {
      const actionsOf = (name: string): string[] =>
        rolePolicyStatements(name).flatMap((s) =>
          Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string],
        );
      expect(actionsOf('FoundryAscent-Api')).toContain('sqs:SendMessage');
      expect(actionsOf('FoundryAscent-Api')).not.toContain('sqs:ReceiveMessage');
      expect(actionsOf('FoundryAscent-Worker')).toEqual(
        expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
      );
      expect(actionsOf('FoundryAscent-Worker')).not.toContain('sqs:SendMessage');
      const migrate = actionsOf('FoundryAscent-Migrate');
      expect(migrate).toContain('bedrock:InvokeModel');
      expect(migrate).not.toContain('bedrock-mantle:CreateInference');
      expect(migrate).not.toContain('bedrock:InvokeModelWithResponseStream');
      expect(migrate.some((a) => a.startsWith('sqs:') || a.startsWith('s3:'))).toBe(false);
    });

    it('narrows documents access per role: api puts and deletes, worker only reads', () => {
      const denied = (name: string): string[] =>
        rolePolicyStatements(name)
          .filter((s) => s.Effect === 'Deny')
          .flatMap((s) => (Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string]));
      expect(denied('FoundryAscent-Api')).toEqual(['s3:GetObject']);
      expect(denied('FoundryAscent-Worker').sort()).toEqual(['s3:DeleteObject', 's3:PutObject']);
      expect(denied('FoundryAscent-Migrate')).toEqual([]);
      const deny = rolePolicyStatements('FoundryAscent-Api').find((s) => s.Effect === 'Deny');
      const resource = JSON.stringify(deny?.Resource);
      expect(resource).toContain('/tenants/*');
      expect(resource).toContain('FoundryAscent-Data');
    });

    it('scopes each function role to its own log group (no AWS managed policies)', () => {
      for (const name of ['FoundryAscent-Api', 'FoundryAscent-Worker', 'FoundryAscent-Migrate']) {
        const logs = rolePolicyStatements(name).find(
          (s) => Array.isArray(s.Action) && (s.Action as string[]).includes('logs:PutLogEvents'),
        );
        expect(logs?.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/LogGroup/), 'Arn'] });
      }
    });
  });

  describe('worker event source', () => {
    it('polls the jobs queue in batches of 5 with partial batch failures', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 5,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        ScalingConfig: { MaximumConcurrency: 2 },
        EventSourceArn: { 'Fn::GetStackOutput': Match.objectLike({ StackName: 'FoundryAscent-Data' }) },
      });
    });
  });

  describe('migrations custom resource', () => {
    it('re-runs on every version and migration change', () => {
      template.hasResourceProperties('Custom::FoundryMigrations', {
        ServiceToken: { 'Fn::GetAtt': [Match.stringLikeRegexp('^MigrateProviderframeworkonEvent'), 'Arn'] },
        version: 'test-sha',
        migrationsChecksum: migrationsChecksum(MIGRATIONS_DIR),
      });
    });

    it('runs before the API, worker and site are updated', () => {
      const [migrationsId] =
        Object.entries(all).find(([, r]) => r.Type === 'Custom::FoundryMigrations') ?? [];
      expect(migrationsId).toBeDefined();
      for (const name of ['FoundryAscent-Api', 'FoundryAscent-Worker']) {
        const [id] = fn(name);
        expect(all[id]?.DependsOn, name).toContain(migrationsId);
      }
      const [urlId] = Object.entries(all).find(([, r]) => r.Type === 'AWS::Lambda::Url') ?? [];
      expect(all[urlId ?? '']?.DependsOn).toContain(migrationsId);
      const [assetsDeploymentId] =
        Object.entries(all).find(
          ([id, r]) => r.Type === 'Custom::CDKBucketDeployment' && id.startsWith('DeploySiteAssets'),
        ) ?? [];
      expect(all[assetsDeploymentId ?? '']?.DependsOn).toContain(migrationsId);
    });
  });

  describe('Function URL', () => {
    it('requires IAM auth and streams responses', () => {
      template.resourceCountIs('AWS::Lambda::Url', 1);
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
        InvokeMode: 'RESPONSE_STREAM',
        TargetFunctionArn: { 'Fn::GetAtt': [fn('FoundryAscent-Api')[0], 'Arn'] },
        Cors: Match.absent(),
      });
    });

    it('lets only this distribution invoke it (InvokeFunctionUrl + InvokeFunction via URL)', () => {
      const distributionArn = Match.objectLike({
        'Fn::Join': [
          '',
          Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('^Distribution') })]),
        ],
      });
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunctionUrl',
        Principal: 'cloudfront.amazonaws.com',
        SourceArn: distributionArn,
      });
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: 'cloudfront.amazonaws.com',
        InvokedViaFunctionUrl: true,
        SourceArn: distributionArn,
      });
      for (const [, permission] of resourcesOfType(template, 'AWS::Lambda::Permission')) {
        expect(permission.Principal).toBe('cloudfront.amazonaws.com');
      }
    });
  });

  describe('CloudFront', () => {
    const [, distribution] = resourcesOfType(template, 'AWS::CloudFront::Distribution')[0] ?? ['', {}];
    const config = distribution.DistributionConfig as Props;

    it('uses two origin access controls (S3 and Lambda) that always sign', () => {
      template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
      template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
        OriginAccessControlConfig: Match.objectLike({
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
        }),
      });
      template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
        OriginAccessControlConfig: Match.objectLike({
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'always',
        }),
      });
    });

    it('is HTTP/2+3, IPv6, price class 100, index.html root', () => {
      expect(config).toMatchObject({
        HttpVersion: 'http2and3',
        IPV6Enabled: true,
        PriceClass: 'PriceClass_100',
        DefaultRootObject: 'index.html',
      });
      // SPA routing is done by the viewer-request function, never by error pages (they would also
      // rewrite API 403/404s).
      expect(config.CustomErrorResponses).toBeUndefined();
    });

    it('serves the SPA from S3 with caching, compression, HTTPS redirect and the SPA rewrite', () => {
      expect(config.DefaultCacheBehavior).toMatchObject({
        ViewerProtocolPolicy: 'redirect-to-https',
        Compress: true,
        CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // Managed-CachingOptimized
        AllowedMethods: ['GET', 'HEAD'],
        FunctionAssociations: [
          {
            EventType: 'viewer-request',
            FunctionARN: { 'Fn::GetAtt': [startsWith('SpaRewriteFunction'), 'FunctionARN'] },
          },
        ],
        ResponseHeadersPolicyId: { Ref: startsWith('SecurityHeaders') },
      });
    });

    it('routes /api/* to the Function URL uncached with all viewer headers except Host', () => {
      expect(config.CacheBehaviors).toEqual([
        expect.objectContaining({
          PathPattern: '/api/*',
          ViewerProtocolPolicy: 'https-only',
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
          OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // Managed-AllViewerExceptHostHeader
          AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          Compress: false,
          ResponseHeadersPolicyId: { Ref: startsWith('SecurityHeaders') },
          FunctionAssociations: [
            {
              EventType: 'viewer-request',
              FunctionARN: { 'Fn::GetAtt': [startsWith('ApiViewerRequestFunction'), 'FunctionARN'] },
            },
          ],
        }),
      ]);
      const origins = config.Origins as Props[];
      expect(origins).toContainEqual(
        expect.objectContaining({
          CustomOriginConfig: {
            OriginProtocolPolicy: 'https-only',
            OriginReadTimeout: 60,
            OriginSSLProtocols: ['TLSv1.2'],
          },
        }),
      );
    });

    it('sends strict security headers on every response', () => {
      template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: {
            ContentSecurityPolicy: { ContentSecurityPolicy: Match.anyValue(), Override: true },
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 63_072_000,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            },
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: 'DENY', Override: true },
            ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
          },
          CustomHeadersConfig: {
            Items: [
              {
                Header: 'Permissions-Policy',
                Value: 'camera=(), microphone=(), geolocation=()',
                Override: true,
              },
            ],
          },
        }),
      });
      expect(contentSecurityPolicy(documentsUploadOrigin('docs-bucket', 'us-east-1'))).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
          "font-src 'self' data:; connect-src 'self' https://docs-bucket.s3.us-east-1.amazonaws.com; " +
          "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
      );
    });

    it('pins connect-src to the documents bucket endpoint the presigned uploads use (no S3 wildcard)', () => {
      const [[, policy] = ['', {}]] = resourcesOfType(template, 'AWS::CloudFront::ResponseHeadersPolicy');
      const config = policy.ResponseHeadersPolicyConfig as Props;
      const csp = ((config.SecurityHeadersConfig as Props).ContentSecurityPolicy as Props)
        .ContentSecurityPolicy;
      // The bucket name comes from the Data stack through the existing weak reference (no new export).
      const bucketRef = {
        'Fn::GetStackOutput': {
          OutputName: expect.stringMatching(/^PublishOutputRefDocumentsBucket/) as unknown,
          Region: 'us-east-1',
          StackName: 'FoundryAscent-Data',
        },
      };
      expect(csp).toEqual({ 'Fn::Join': ['', [expect.any(String), bucketRef, expect.any(String)]] });
      const [, parts] = (csp as { 'Fn::Join': [string, [string, unknown, string]] })['Fn::Join'];
      const rendered = `${parts[0]}<bucket>${parts[2]}`;
      expect(rendered).toContain("connect-src 'self' https://<bucket>.s3.us-east-1.amazonaws.com;");
      expect(rendered).not.toContain('*');
    });

    it('runs both edge functions on cloudfront-js-2.0', () => {
      template.resourceCountIs('AWS::CloudFront::Function', 2);
      for (const [, props] of resourcesOfType(template, 'AWS::CloudFront::Function')) {
        expect((props.FunctionConfig as Props).Runtime).toBe('cloudfront-js-2.0');
      }
      const apiFunction = resourcesOfType(template, 'AWS::CloudFront::Function').find(([id]) =>
        id.startsWith('ApiViewerRequest'),
      );
      expect(apiFunction?.[1].FunctionCode).toContain(VIEWER_HOST_HEADER);
      expect(apiFunction?.[1].FunctionCode).toContain(
        `headers['${VIEWER_IP_HEADER}'] = { value: event.viewer.ip }`,
      );
    });
  });

  describe('site deployment', () => {
    it('keeps the site bucket private and retained', () => {
      template.hasResource('AWS::S3::Bucket', {
        DeletionPolicy: 'RetainExceptOnCreate',
        UpdateReplacePolicy: 'Retain',
      });
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
            }),
          ]),
        },
      });
    });

    it('deploys hashed assets as immutable and everything else revalidated, then invalidates /*', () => {
      const deployments = resourcesOfType(template, 'Custom::CDKBucketDeployment').map(([id, p]) => ({
        id,
        ...p,
      }));
      expect(deployments).toHaveLength(2);
      const assets = deployments.find((d) => d.id.startsWith('DeploySiteAssets'));
      const shell = deployments.find((d) => d.id.startsWith('DeploySiteShell'));
      // Older hashed assets stay: a cached index.html may still reference them (regression: R3).
      expect(assets).toMatchObject({
        Prune: false,
        Exclude: ['*'],
        Include: ['assets/*'],
        SystemMetadata: { 'cache-control': 'public, max-age=31536000, immutable' },
        OutputObjectKeys: false,
      });
      expect(assets).not.toHaveProperty('DistributionId');
      expect(shell).toMatchObject({
        Prune: true,
        Exclude: ['assets/*'],
        SystemMetadata: { 'cache-control': 'public, max-age=0, must-revalidate' },
        DistributionId: { Ref: startsWith('Distribution') },
        DistributionPaths: ['/*'],
      });
      expect(all[shell?.id ?? '']?.DependsOn).toEqual(expect.arrayContaining([assets?.id]));
      // Both wait for the distribution (CSP and behaviours) before publishing a new build.
      const distributionId = resourcesOfType(template, 'AWS::CloudFront::Distribution')[0]?.[0];
      expect(distributionId).toBeDefined();
      for (const deployment of [assets, shell]) {
        expect(all[deployment?.id ?? '']?.DependsOn).toEqual(expect.arrayContaining([distributionId]));
      }
    });
  });

  describe('daily maintenance', () => {
    it('sends the maintenance message to the jobs queue once a day through EventBridge Scheduler', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 1);
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'rate(1 day)',
        State: 'ENABLED',
        Target: Match.objectLike({
          Arn: {
            'Fn::GetStackOutput': Match.objectLike({
              OutputName: Match.stringLikeRegexp('^PublishOutputFnGetAttJobsQueue'),
              StackName: 'FoundryAscent-Data',
            }),
          },
          Input: JSON.stringify({ type: 'maintenance', task: 'daily' }),
        }),
      });
    });

    it('grants the schedule role sqs:SendMessage on the jobs queue only, without touching the Data stack', () => {
      const [[roleId, role] = ['', {}]] = resourcesOfType(template, 'AWS::IAM::Role').filter(([id]) =>
        id.startsWith('SchedulerRoleForTarget'),
      );
      expect(JSON.stringify(role.AssumeRolePolicyDocument)).toContain('scheduler.amazonaws.com');
      expect(role.PermissionsBoundary).toBeDefined();
      const policies = resourcesOfType(template, 'AWS::IAM::Policy').filter(([, p]) =>
        JSON.stringify(p.Roles).includes(roleId),
      );
      expect(policies).toHaveLength(1);
      expect((policies[0]?.[1].PolicyDocument as Props).Statement).toEqual([
        expect.objectContaining({ Action: 'sqs:SendMessage', Effect: 'Allow' }),
      ]);
      // A rule's SQS target would need a queue policy statement in the Data stack.
      expect(JSON.stringify(synth.templates.data.toJSON())).not.toContain('scheduler.amazonaws.com');
      expect(JSON.stringify(synth.templates.data.toJSON())).not.toContain('events.amazonaws.com');
    });
  });

  describe('alarms', () => {
    it('creates the alarm topic without subscriptions, TLS-only, publishable by CloudWatch', () => {
      template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'FoundryAscent-Alarms' });
      template.resourceCountIs('AWS::SNS::Subscription', 0);
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCloudWatchAlarms',
              Principal: { Service: 'cloudwatch.amazonaws.com' },
              Action: 'sns:Publish',
            }),
          ]),
        },
      });
    });

    it.each([
      ['FoundryAscent-Api-Errors', 'AWS/Lambda', 'Errors', 'GreaterThanOrEqualToThreshold', 1],
      ['FoundryAscent-Api-Throttles', 'AWS/Lambda', 'Throttles', 'GreaterThanOrEqualToThreshold', 1],
      ['FoundryAscent-Worker-Errors', 'AWS/Lambda', 'Errors', 'GreaterThanOrEqualToThreshold', 1],
      [
        'FoundryAscent-Jobs-DLQ-NotEmpty',
        'AWS/SQS',
        'ApproximateNumberOfMessagesVisible',
        'GreaterThanThreshold',
        0,
      ],
      ['FoundryAscent-CloudFront-5xxRate', 'AWS/CloudFront', '5xxErrorRate', 'GreaterThanThreshold', 5],
    ])('%s watches %s %s', (alarmName, namespace, metricName, comparison, threshold) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        Namespace: namespace,
        MetricName: metricName,
        ComparisonOperator: comparison,
        Threshold: threshold,
        TreatMissingData: 'notBreaching',
        AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlarmTopic') }],
      });
    });

    it('watches CloudFront in the Global region dimension', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'FoundryAscent-CloudFront-5xxRate',
        Dimensions: [
          { Name: 'DistributionId', Value: { Ref: Match.stringLikeRegexp('^Distribution') } },
          { Name: 'Region', Value: 'Global' },
        ],
      });
    });
  });

  it('exports the operational outputs', () => {
    const outputs = Object.keys((template.toJSON() as { Outputs: Record<string, unknown> }).Outputs);
    expect(outputs).toEqual(
      expect.arrayContaining([
        'SiteUrl',
        'DistributionId',
        'ApiFunctionName',
        'ClusterArn',
        'SecretArn',
        'DocumentsBucket',
        'JobsQueueUrl',
        'AlarmTopicArn',
      ]),
    );
    template.hasOutput('SiteUrl', {
      Value: {
        'Fn::Join': [
          '',
          ['https://', { 'Fn::GetAtt': [Match.stringLikeRegexp('^Distribution'), 'DomainName'] }],
        ],
      },
    });
  });
});

describe('/api/* timing (Aurora resume vs CloudFront and Lambda timeouts)', () => {
  const synth = defaultSynth();

  it('waits for a resume (40 s) well inside the 60 s origin read timeout and the 60 s Lambda timeout', () => {
    expect(API_DB_RESUME_BUDGET_SECONDS).toBe(40);
    expect(API_ORIGIN_READ_TIMEOUT_SECONDS).toBe(60);
    expect(API_DB_RESUME_BUDGET_SECONDS + 15).toBeLessThanOrEqual(API_ORIGIN_READ_TIMEOUT_SECONDS);
    expect(API_DB_RESUME_BUDGET_SECONDS + 15).toBeLessThanOrEqual(synth.config.api.timeoutSeconds);
    expect(API_SSE_KEEP_ALIVE_SECONDS * 2).toBeLessThanOrEqual(API_ORIGIN_READ_TIMEOUT_SECONDS);
  });

  it('rejects an API timeout that leaves no room after the resume wait', () => {
    expect(() => {
      assertTiming(50);
    }).toThrow(/API Lambda timeout/);
    expect(() => {
      assertTiming(60);
    }).not.toThrow();
  });
});
