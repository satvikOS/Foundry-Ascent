import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { githubSubject } from '../src/stacks/foundation-stack.js';
import { defaultSynth, resourcesOfType, synthesize } from './helpers.js';

describe('FoundryAscent-Foundation', () => {
  const { templates } = defaultSynth();
  const template = templates.foundation;

  it('creates the GitHub OIDC provider with the STS audience', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
  });

  const roleNamed = (name: string): Record<string, unknown> => {
    const found = resourcesOfType(template, 'AWS::IAM::Role').find(([, r]) => r.RoleName === name);
    if (!found) throw new Error(`role ${name} not found`);
    return found[1];
  };

  it('has exactly three roles: the deploy role, the ops-insights role and the conversation-lab role', () => {
    const names = resourcesOfType(template, 'AWS::IAM::Role').map(([, r]) => r.RoleName);
    expect(names.sort()).toEqual([
      'FoundryAscent-ConversationLab',
      'FoundryAscent-GitHubDeploy',
      'FoundryAscent-OpsInsights',
    ]);
  });

  it('trusts only the production environment of satvikOS/Foundry-Ascent (exact sub and aud), for one hour', () => {
    const role = roleNamed('FoundryAscent-GitHubDeploy');
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: { Ref: expect.stringMatching(/^GitHubOidcProvider/) as unknown } },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:production',
            },
          },
        },
      ],
    });
  });

  it('can only assume CDK bootstrap roles and read stacks, platform logs and costs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Sid: 'AssumeCdkBootstrapRoles',
            Effect: 'Allow',
            Action: ['sts:AssumeRole', 'sts:TagSession'],
            Resource: ['deploy-role', 'file-publishing-role', 'image-publishing-role', 'lookup-role'].map(
              (kind) => ({
                'Fn::Join': [
                  '',
                  [
                    'arn:aws:iam::',
                    { Ref: 'AWS::AccountId' },
                    `:role/cdk-hnb659fds-${kind}-`,
                    { Ref: 'AWS::AccountId' },
                    '-us-east-1',
                  ],
                ],
              }),
            ),
          },
          Match.objectLike({
            Sid: 'ReadPlatformStacks',
            Action: Match.arrayWith(['cloudformation:DescribeStackEvents', 'cloudformation:DescribeStacks']),
          }),
          { Sid: 'ListStacks', Effect: 'Allow', Action: 'cloudformation:ListStacks', Resource: '*' },
          {
            Sid: 'ReadPlatformLambdaLogs',
            Effect: 'Allow',
            Action: ['logs:FilterLogEvents', 'logs:GetLogEvents'],
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:aws:logs:us-east-1:',
                  { Ref: 'AWS::AccountId' },
                  ':log-group:/aws/lambda/FoundryAscent*',
                ],
              ],
            },
          },
          { Sid: 'CostExplorerRead', Effect: 'Allow', Action: 'ce:GetCostAndUsage', Resource: '*' },
        ],
      },
    });
    // Nothing that writes: no iam:*, cloudformation:Create*/Update*/Delete*, s3:*, cloudfront:* (its one write, the
    // face vendor key, is a policy of its own: see below).
    const statements = JSON.stringify(template.toJSON());
    expect(statements).not.toMatch(/"(iam|s3|cloudfront):|cloudformation:(Create|Update|Delete|Execute)/);
  });

  it('lets the deploy role write only the face vendor key, and never read it back', () => {
    const policies = resourcesOfType(template, 'AWS::IAM::Policy');
    const media = policies.filter(([id]) => id.startsWith('GitHubDeployMediaKeyPolicy'));
    expect(media).toHaveLength(1);
    const [, props] = media[0] ?? ['', {}];
    expect(props.Roles).toEqual([{ Ref: expect.stringMatching(/^GitHubDeployRole/) as unknown }]);
    expect(props.PolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'CreateFaceVendorKey',
          Effect: 'Allow',
          Action: 'secretsmanager:CreateSecret',
          Resource: {
            'Fn::Join': [
              '',
              [
                'arn:aws:secretsmanager:us-east-1:',
                { Ref: 'AWS::AccountId' },
                ':secret:foundry-ascent/media/heygen*',
              ],
            ],
          },
          // The ARN does not exist before CreateSecret; the exact name in the request is what is pinned.
          Condition: { StringEquals: { 'secretsmanager:Name': 'foundry-ascent/media/heygen' } },
        },
        {
          Sid: 'WriteFaceVendorKey',
          Effect: 'Allow',
          Action: 'secretsmanager:PutSecretValue',
          Resource: {
            'Fn::Join': [
              '',
              [
                'arn:aws:secretsmanager:us-east-1:',
                { Ref: 'AWS::AccountId' },
                ':secret:foundry-ascent/media/heygen-??????',
              ],
            ],
          },
        },
      ],
    });
    // No other policy in the stack touches Secrets Manager, and none can read, delete, tag, share, replicate or
    // rotate a secret, or reach the ElevenLabs key or the database secret.
    const all = JSON.stringify(policies);
    expect(
      all
        .match(/"secretsmanager:[A-Za-z]+"/g)
        ?.map((a) => a.slice(1, -1))
        .sort(),
    ).toEqual(['secretsmanager:CreateSecret', 'secretsmanager:Name', 'secretsmanager:PutSecretValue']);
    expect(all).not.toContain('elevenlabs');
    expect(all).not.toContain('aurora');
    // The read-only deploy policy stays read-only.
    const deploy = policies.filter(([id]) => id.startsWith('GitHubDeployPolicy'));
    expect(JSON.stringify(deploy)).not.toContain('secretsmanager');
  });

  it('lets only the ops-insights environment assume the insights role, for one hour', () => {
    const role = roleNamed('FoundryAscent-OpsInsights');
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: { Ref: expect.stringMatching(/^GitHubOidcProvider/) as unknown } },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:ops-insights',
            },
          },
        },
      ],
    });
  });

  it('lets the insights role invoke only the insights function and read platform logs', () => {
    const policies = resourcesOfType(template, 'AWS::IAM::Policy').filter(([id]) =>
      id.startsWith('OpsInsightsPolicy'),
    );
    expect(policies).toHaveLength(1);
    const [, policy] = policies[0] ?? ['', {}];
    expect(policy.Roles).toEqual([{ Ref: expect.stringMatching(/^OpsInsightsRole/) as unknown }]);
    expect(policy.PolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'InvokeInsightsFunction',
          Effect: 'Allow',
          Action: 'lambda:InvokeFunction',
          Resource: {
            'Fn::Join': [
              '',
              ['arn:aws:lambda:us-east-1:', { Ref: 'AWS::AccountId' }, ':function:FoundryAscent-Insights'],
            ],
          },
        },
        {
          Sid: 'ReadPlatformLambdaLogs',
          Effect: 'Allow',
          Action: 'logs:FilterLogEvents',
          Resource: {
            'Fn::Join': [
              '',
              ['arn:aws:logs:us-east-1:', { Ref: 'AWS::AccountId' }, ':log-group:/aws/lambda/FoundryAscent*'],
            ],
          },
        },
      ],
    });
    // The deploy role's policy does not mention the insights function: it is not widened.
    const deploy = resourcesOfType(template, 'AWS::IAM::Policy').filter(([id]) =>
      id.startsWith('GitHubDeployPolicy'),
    );
    expect(JSON.stringify(deploy)).not.toContain('lambda:');
  });

  it('lets only the conversation-lab environment assume the lab role, for one hour', () => {
    const role = roleNamed('FoundryAscent-ConversationLab');
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: { Ref: expect.stringMatching(/^GitHubOidcProvider/) as unknown } },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:conversation-lab',
            },
          },
        },
      ],
    });
  });

  it('lets the lab role invoke exactly the app and lab models, Polly speech and Transcribe streaming', () => {
    const policies = resourcesOfType(template, 'AWS::IAM::Policy').filter(([id]) =>
      id.startsWith('ConversationLabPolicy'),
    );
    expect(policies).toHaveLength(1);
    const [, policy] = policies[0] ?? ['', {}];
    expect(policy.Roles).toEqual([{ Ref: expect.stringMatching(/^ConversationLabRole/) as unknown }]);
    const profile = (id: string): unknown => ({
      'Fn::Join': ['', ['arn:aws:bedrock:us-east-1:', { Ref: 'AWS::AccountId' }, `:inference-profile/${id}`]],
    });
    const inRegion = { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } };
    expect(policy.PolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'InvokeLabModels',
          Effect: 'Allow',
          Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          Resource: [
            // The app's models (infra/cdk/config/production.json: Nova 2 Lite primary + fallback, Titan embeddings)
            'arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0',
            // The lab's simulator and judge (ops/lab/models.json).
            'arn:aws:bedrock:*::foundation-model/amazon.nova-premier-v1:0',
            'arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1:0',
            'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0',
            // The global. fallback profile is authorized against the region-less foundation-model ARN.
            'arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0',
            profile('global.amazon.nova-2-lite-v1:0'),
            profile('us.amazon.nova-2-lite-v1:0'),
            profile('us.amazon.nova-premier-v1:0'),
            profile('us.amazon.nova-pro-v1:0'),
          ],
        },
        {
          Sid: 'SynthesizeSpeech',
          Effect: 'Allow',
          Action: ['polly:DescribeVoices', 'polly:SynthesizeSpeech'],
          Resource: '*',
          Condition: inRegion,
        },
        {
          Sid: 'TranscribeStreaming',
          Effect: 'Allow',
          Action: 'transcribe:StartStreamTranscriptionWebSocket',
          Resource: '*',
          Condition: inRegion,
        },
      ],
    });
    // No platform resource: no database, secret, bucket, queue, function or log access, and no other role.
    const text = JSON.stringify(policy);
    expect(text).not.toMatch(/rds|secretsmanager|s3:|sqs:|lambda:|logs:|sts:|iam:|bedrock-mantle|kms:/);
    // Neither existing role is widened for the lab.
    const others = resourcesOfType(template, 'AWS::IAM::Policy').filter(
      ([id]) => !id.startsWith('ConversationLabPolicy'),
    );
    expect(JSON.stringify(others)).not.toMatch(/bedrock|polly|transcribe/);
  });

  it('outputs the deploy role ARN', () => {
    template.hasOutput('GitHubDeployRoleArn', { Value: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] } });
  });

  it('derives the only trusted subject from the repository and the environment (never a branch)', () => {
    expect(
      githubSubject({
        githubRepository: 'acme/repo',
        githubOwnerId: '42',
        githubRepositoryId: '7',
        githubEnvironment: 'prod',
      }),
    ).toBe('repo:acme@42/repo@7:environment:prod');
    // Regression: a branch subject (any workflow on main, with or without the environment) is not trusted.
    expect(JSON.stringify(template.toJSON())).not.toContain(':ref:refs/heads/');
    expect(JSON.stringify(template.toJSON())).not.toContain('StringLike');
  });
});

describe('FoundryAscent-Foundation with an existing OIDC provider', () => {
  it('imports the provider instead of creating a second one', () => {
    const arn = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
    const { templates } = synthesize({ githubOidcProviderArn: arn });
    templates.foundation.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    templates.foundation.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'FoundryAscent-GitHubDeploy',
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Federated: arn } })] },
    });
    templates.foundation.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'FoundryAscent-OpsInsights',
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Federated: arn } })] },
    });
    templates.foundation.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'FoundryAscent-ConversationLab',
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Federated: arn } })] },
    });
  });
});
