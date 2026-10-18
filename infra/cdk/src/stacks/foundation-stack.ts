/**
 * FoundryAscent-Foundation: GitHub Actions OIDC federation (stage 1 of infra/iam/README.md).
 *
 * The deploy role can do almost nothing by itself: it assumes the CDK bootstrap roles
 * (`cdk-hnb659fds-*`), whose CloudFormation execution role is capped by FoundryAscent-Boundary, and it
 * can read stack status, the platform's Lambda logs and Cost Explorer for post-deploy checks.
 *
 * The ops-insights role is separate and narrower (docs/runbooks/insights.md): trusted only from the
 * `ops-insights` GitHub environment, it may invoke the read-only insights function and read the platform's
 * Lambda logs, nothing else. The deploy role is not widened for it.
 *
 * The conversation-lab role (docs/runbooks/conversation-lab.md) is separate too: trusted only from the
 * `conversation-lab` GitHub environment, it may invoke the app's Bedrock models and the lab's own simulator and
 * judge models, synthesize speech with Amazon Polly and presign Amazon Transcribe streaming, all for a local copy
 * of the app with synthetic data on the runner. It reaches no platform resource (no database, bucket, queue,
 * function, log or secret).
 */
import { ArnFormat, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import {
  CONVERSATION_LAB_ENVIRONMENT,
  NAMES,
  OPS_INSIGHTS_ENVIRONMENT,
  STACK_PREFIX,
} from '../lib/constants.js';
import type { BedrockRuntimeAccess } from '../lib/models.js';
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
   * GitHub environment of the ops-insights workflow (default `ops-insights`): the only subject the insights role
   * trusts. Its deployment-branch rule must allow `main` only, like `production`'s.
   */
  readonly insightsEnvironment?: string;
  /**
   * GitHub environment of the conversation-lab workflow (default `conversation-lab`): the only subject the lab
   * role trusts. Its deployment-branch rule must allow `main` only, like `production`'s.
   */
  readonly conversationLabEnvironment?: string;
  /**
   * Bedrock models the conversation lab may invoke: the app's effective models and the lab's simulator and judge
   * (lib/lab-models.ts `conversationLabAccess`).
   */
  readonly conversationLabModels: BedrockRuntimeAccess;
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
  readonly insightsRole: iam.Role;
  readonly conversationLabRole: iam.Role;

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

    // ---- Ops insights (read-only) ---------------------------------------------------------------------------
    // Its own role and GitHub environment, as docs/runbooks/deploy-and-rollback.md asks of any ops task that
    // needs more than the deploy role: invoke the one insights function (which reads the database in read-only
    // transactions and seals content to the operator's key) and read the platform's Lambda logs (ids, counts,
    // codes and timings by the logging contract). No database, secret, model or bucket access of its own.
    const insightsEnvironment = props.insightsEnvironment ?? OPS_INSIGHTS_ENVIRONMENT;
    this.insightsRole = new iam.Role(this, 'OpsInsightsRole', {
      roleName: NAMES.opsInsightsRole,
      description: `Read-only platform insights for ${props.githubRepository} (OIDC; ${insightsEnvironment} environment only)`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: githubSubject({ ...props, githubEnvironment: insightsEnvironment }),
        },
      }),
    });
    const insightsFunction = this.formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: NAMES.insightsFunction,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const insightsPolicy = new iam.Policy(this, 'OpsInsightsPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeInsightsFunction',
          actions: ['lambda:InvokeFunction'],
          resources: [insightsFunction],
        }),
        new iam.PolicyStatement({
          sid: 'ReadPlatformLambdaLogs',
          actions: ['logs:FilterLogEvents'],
          resources: [lambdaLogGroups],
        }),
      ],
    });
    insightsPolicy.attachToRole(this.insightsRole);
    acknowledge(insightsPolicy, {
      id: wildcardResource(this, lambdaLogGroups),
      reason:
        'Read-only access to the log groups of the platform Lambda functions, all named FoundryAscent-*: the insights workflow counts distillation, call and request events (ids, codes and timings only by the logging contract).',
    });

    // ---- Conversation lab ---------------------------------------------------------------------------------------
    // Its own role and GitHub environment (main only). The lab runs the app on the runner (local PostgreSQL,
    // synthetic seed, the production model configuration) and talks to it headless, so it needs exactly what
    // the app's API role uses to think and speak, plus the lab's simulator and judge models: Bedrock
    // InvokeModel / InvokeModelWithResponseStream (Converse and ConverseStream authorize through them) on the
    // listed models, Polly SynthesizeSpeech, and Transcribe StartStreamTranscriptionWebSocket (the app presigns
    // the browser's streaming URL with the role's credentials, as the API role does in production; the app
    // never calls the HTTP/2 StartStreamTranscription, so it is not granted). No platform resource.
    const labEnvironment = props.conversationLabEnvironment ?? CONVERSATION_LAB_ENVIRONMENT;
    this.conversationLabRole = new iam.Role(this, 'ConversationLabRole', {
      roleName: NAMES.conversationLabRole,
      description: `Headless conversation lab for ${props.githubRepository} (OIDC; ${labEnvironment} environment only)`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: githubSubject({ ...props, githubEnvironment: labEnvironment }),
        },
      }),
    });
    const models = props.conversationLabModels;
    // Profiles in the invoking region; the foundation models behind them in every region (cross-region `us.`
    // profiles route to other US regions), plus the region-less ARN `global.` profiles are authorized against.
    const foundationModelArns = models.foundationModels.map((id) =>
      this.formatArn({
        service: 'bedrock',
        region: '*',
        account: '',
        resource: 'foundation-model',
        resourceName: id,
      }),
    );
    const labModelArns = [
      ...foundationModelArns,
      ...models.globalFoundationModels.map((id) =>
        this.formatArn({
          service: 'bedrock',
          region: '',
          account: '',
          resource: 'foundation-model',
          resourceName: id,
        }),
      ),
      ...models.inferenceProfiles.map((id) =>
        this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: id }),
      ),
    ];
    const inLabRegion = { StringEquals: { 'aws:RequestedRegion': this.region } };
    const labPolicy = new iam.Policy(this, 'ConversationLabPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeLabModels',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: labModelArns,
        }),
        new iam.PolicyStatement({
          sid: 'SynthesizeSpeech',
          // DescribeVoices: the app's free connection warm-up at a call's start (polly-speech.ts prewarm, LAB-P2),
          // as on the API role.
          actions: ['polly:SynthesizeSpeech', 'polly:DescribeVoices'],
          resources: ['*'],
          conditions: inLabRegion,
        }),
        new iam.PolicyStatement({
          sid: 'TranscribeStreaming',
          actions: ['transcribe:StartStreamTranscriptionWebSocket'],
          resources: ['*'],
          conditions: inLabRegion,
        }),
      ],
    });
    labPolicy.attachToRole(this.conversationLabRole);
    acknowledge(
      labPolicy,
      ...foundationModelArns.map((arn) => ({
        id: wildcardResource(this, arn),
        reason:
          'Foundation-model ARNs carry no account; the region is a wildcard because cross-region (us.) and global inference profiles route to other regions. The model id itself is pinned.',
      })),
      {
        id: wildcardResource(this, '*'),
        reason:
          'polly:SynthesizeSpeech and polly:DescribeVoices have no resource-level permissions without a lexicon (none is used) and transcribe:StartStreamTranscriptionWebSocket has no resource types; all are limited to the platform region by aws:RequestedRegion and create nothing that persists.',
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
