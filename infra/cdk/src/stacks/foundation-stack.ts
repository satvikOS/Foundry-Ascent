/**
 * FoundryAscent-Foundation: GitHub Actions OIDC federation (stage 1 of infra/iam/README.md).
 *
 * The deploy role can do almost nothing by itself: it assumes the CDK bootstrap roles
 * (`cdk-hnb659fds-*`), whose CloudFormation execution role is capped by FoundryAscent-Boundary, and it
 * can read stack status, the platform's Lambda logs and Cost Explorer for post-deploy checks.
 */
import { ArnFormat, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { NAMES, STACK_PREFIX } from '../lib/constants.js';
import { acknowledge, wildcardResource } from '../lib/nag.js';

export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';
const CDK_QUALIFIER = 'hnb659fds';
/** The bootstrap roles the CDK CLI assumes (never the CloudFormation execution role). */
export const CDK_CLI_ROLES = [
  'deploy-role',
  'file-publishing-role',
  'image-publishing-role',
  'lookup-role',
] as const;

export interface FoundationStackProps extends StackProps {
  /** `owner/repo`, e.g. `satvikOS/Foundry-Ascent`. */
  readonly githubRepository: string;
  /** Immutable numeric id of the repository owner (GitHub user or organization). */
  readonly githubOwnerId: string;
  /** Immutable numeric id of the repository. */
  readonly githubRepositoryId: string;
  /**
   * Branch that deploys (`main`). Informational: the trust policy pins the GitHub environment, whose
   * deployment-branch rule (repository settings) limits it to this branch.
   */
  readonly githubBranch: string;
  /** GitHub environment allowed to deploy (`production`): the only subject the deploy role trusts. */
  readonly githubEnvironment: string;
  /**
   * ARN of an existing `token.actions.githubusercontent.com` provider. An account can hold only one
   * provider per URL; pass this instead of creating a second one when it already exists.
   */
  readonly existingOidcProviderArn?: string;
}

/**
 * The one `sub` claim allowed to assume the deploy role: a job of this repository that runs in the deploy
 * environment. GitHub issues `repo:<owner>@<ownerId>/<repo>@<repoId>:environment:<name>` to every job that
 * declares `environment:` (observed on this repository; the ids are immutable, so a repository later created
 * under the same name cannot match), and the environment's protection rules (required reviewers, deployment
 * branches) gate AWS access. A branch subject (`ref:refs/heads/main`) is deliberately NOT trusted: any workflow on that branch
 * without the environment, including one added by a later commit, could otherwise assume the role.
 *
 * `job_workflow_ref` (pinning the role to `.github/workflows/deploy.yml`) is not added: IAM's support for
 * that claim as a condition key could not be verified for this change, and an unsupported key in a
 * StringEquals condition would lock every deploy out.
 */
export function githubSubject(
  props: Pick<
    FoundationStackProps,
    'githubRepository' | 'githubOwnerId' | 'githubRepositoryId' | 'githubEnvironment'
  >,
): string {
  const [owner, repo] = props.githubRepository.split('/');
  if (!owner || !repo) throw new Error(`githubRepository must be owner/repo: ${props.githubRepository}`);
  return `repo:${owner}@${props.githubOwnerId}/${repo}@${props.githubRepositoryId}:environment:${props.githubEnvironment}`;
}

export class FoundationStack extends Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const provider: iam.IOidcProvider = props.existingOidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHubOidcProvider', props.existingOidcProviderArn)
      : new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
          url: `https://${GITHUB_OIDC_HOST}`,
          clientIds: [GITHUB_OIDC_AUDIENCE],
          // No thumbprints: IAM validates GitHub's certificate chain against its own trusted CA store.
        });

    this.deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: NAMES.githubDeployRole,
      description: `GitHub Actions deploys for ${props.githubRepository} (OIDC; ${props.githubEnvironment} environment only)`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: githubSubject(props),
        },
      }),
    });

    const cdkRoles = CDK_CLI_ROLES.map((kind) =>
      this.formatArn({
        service: 'iam',
        region: '',
        resource: 'role',
        resourceName: `cdk-${CDK_QUALIFIER}-${kind}-${this.account}-${this.region}`,
      }),
    );
    const platformStacks = [`${STACK_PREFIX}-*`, 'CDKToolkit'].map((name) =>
      this.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${name}/*` }),
    );
    const lambdaLogGroups = this.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: `/aws/lambda/${STACK_PREFIX}*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const policy = new iam.Policy(this, 'GitHubDeployPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          // TagSession: the CDK CLI may pass session tags when it assumes the bootstrap roles.
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: cdkRoles,
        }),
        new iam.PolicyStatement({
          sid: 'ReadPlatformStacks',
          actions: [
            'cloudformation:DescribeStacks',
            'cloudformation:DescribeStackEvents',
            'cloudformation:DescribeStackResource',
            'cloudformation:DescribeStackResources',
            'cloudformation:DescribeChangeSet',
            'cloudformation:ListStackResources',
            'cloudformation:GetTemplate',
          ],
          resources: platformStacks,
        }),
        new iam.PolicyStatement({
          sid: 'ListStacks',
          // ListStacks has no resource-level permissions.
          actions: ['cloudformation:ListStacks'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'ReadPlatformLambdaLogs',
          actions: ['logs:FilterLogEvents', 'logs:GetLogEvents'],
          // The trailing * also matches `:log-stream:<name>`, which logs:GetLogEvents is authorized on.
          resources: [lambdaLogGroups],
        }),
        new iam.PolicyStatement({
          sid: 'CostExplorerRead',
          // Cost Explorer has no resource-level permissions.
          actions: ['ce:GetCostAndUsage'],
          resources: ['*'],
        }),
      ],
    });
    policy.attachToRole(this.deployRole);

    acknowledge(
      policy,
      ...platformStacks.map((stackArn) => ({
        id: wildcardResource(this, stackArn),
        reason:
          'Read-only CloudFormation access. The trailing /* is the stack id CloudFormation appends to every stack ARN; the name is pinned to the platform stacks or CDKToolkit.',
      })),
      {
        id: wildcardResource(this, '*'),
        reason:
          'cloudformation:ListStacks and ce:GetCostAndUsage do not support resource-level permissions; both are read-only.',
      },
      {
        id: wildcardResource(this, lambdaLogGroups),
        reason:
          'Read-only access to the log groups (and their streams) of the platform Lambda functions, all named FoundryAscent-*, for post-deploy smoke checks.',
      },
    );

    new CfnOutput(this, 'GitHubDeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Role assumed by GitHub Actions (aws-actions/configure-aws-credentials role-to-assume)',
    });
    if (!props.existingOidcProviderArn) {
      new CfnOutput(this, 'GitHubOidcProviderArn', { value: provider.oidcProviderArn });
    }
  }
}
