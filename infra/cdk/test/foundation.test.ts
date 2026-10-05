import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { githubSubjects } from '../src/stacks/foundation-stack.js';
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

  it('trusts only main and the production environment of satvikOS/Foundry-Ascent, for one hour', () => {
    const roles = resourcesOfType(template, 'AWS::IAM::Role');
    expect(roles).toHaveLength(1);
    const [, role] = roles[0] ?? ['', {}];
    expect(role.RoleName).toBe('FoundryAscent-GitHubDeploy');
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: { Ref: expect.stringMatching(/^GitHubOidcProvider/) as unknown } },
          Condition: {
            StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            StringLike: {
              'token.actions.githubusercontent.com:sub': [
                'repo:satvikOS/Foundry-Ascent:ref:refs/heads/main',
                'repo:satvikOS/Foundry-Ascent:environment:production',
              ],
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
            Resource: {
              'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/cdk-hnb659fds-*']],
            },
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
    // Nothing that writes: no iam:*, cloudformation:Create*/Update*/Delete*, s3:*, cloudfront:*.
    const statements = JSON.stringify(template.toJSON());
    expect(statements).not.toMatch(/"(iam|s3|cloudfront):|cloudformation:(Create|Update|Delete|Execute)/);
  });

  it('outputs the deploy role ARN', () => {
    template.hasOutput('GitHubDeployRoleArn', { Value: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] } });
  });

  it('derives the subjects from the configured repository and branch', () => {
    expect(
      githubSubjects({ githubRepository: 'acme/repo', githubBranch: 'release', githubEnvironment: 'prod' }),
    ).toEqual(['repo:acme/repo:ref:refs/heads/release', 'repo:acme/repo:environment:prod']);
  });
});

describe('FoundryAscent-Foundation with an existing OIDC provider', () => {
  it('imports the provider instead of creating a second one', () => {
    const arn = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
    const { templates } = synthesize({ githubOidcProviderArn: arn });
    templates.foundation.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    templates.foundation.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Federated: arn } })] },
    });
  });
});
