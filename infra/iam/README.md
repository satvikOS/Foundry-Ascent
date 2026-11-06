# AWS identity and access

Foundry Ascent deploys from GitHub Actions. Access is staged so that long-lived
credentials exist only for the short bootstrap window
([ADR-0016](../../docs/architecture/adr/0016-staged-iam-github-oidc.md)).

| Stage                              | Principal                             | Credentials                                                 | Permissions                                                                 |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0 — Bootstrap (retired 2026-10-06) | IAM user `Foundry-Ascent`             | Access key deleted                                          | `FoundryAscent-BootstrapOperator` (no credentials left to use it)           |
| 1 — Steady state (now)             | IAM role `FoundryAscent-GitHubDeploy` | GitHub OIDC, 1-hour sessions, `production` environment only | Assume the four CDK bootstrap roles; read-only operations                   |
| Every platform role                | CDK and application roles             | Short-lived (STS)                                           | Capped by `FoundryAscent-Boundary`                                          |
| Account owner                      | Administrator (console / CloudShell)  | Console sign-in                                             | Publishes the policies and the boundary, bootstraps CDK, creates the budget |

## Where it stands (2026-10-06)

Stage 1 is in use: every deploy assumes `FoundryAscent-GitHubDeploy` through GitHub OIDC (repository
secret `AWS_DEPLOY_ROLE_ARN`). The role trusts exactly
`repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:production`: GitHub issues this
repository's `sub` claim with the owner and repository pinned by immutable ids, and the name-only form
(`repo:satvikOS/Foundry-Ascent:…`) is refused. Stage 0 is retired: the `Foundry-Ascent` access key was
deleted and `FoundryAscent-LegacyCleanup` was detached. The workflows and scripts that needed the stage-0
key (data-stack deploy, legacy cleanup, inventory, access check, Bedrock probe, retirement) are removed;
`ops/aws/inventory.py` stays for a local run with read-only credentials. They were not moved to OIDC on
purpose: the deploy role has no Bedrock, Polly, S3 or Data API permissions, and widening a role every
`production` job can assume is not justified for manual ops tasks. A probe that needs model access gets
its own narrowly scoped role (see
[deploy and rollback](../../docs/runbooks/deploy-and-rollback.md#probing-bedrock-and-polly)).

**Security hardening (2026-10):** the stage-0 policy used to let the CI user create and change
`cdk-*` and `FoundryAscent*` roles and publish `FoundryAscent*` policies, including the permissions
boundary. Any of those lets a holder of the access key grant itself administrator access (for example: a
new `cdk-x` role trusting the user, with `AdministratorAccess` attached, then `sts:AssumeRole`). The
bootstrap is done, so [`policies/bootstrap-operator.json`](policies/bootstrap-operator.json) is now the
**post-bootstrap** policy: no IAM writes at all (an explicit `Deny` backs this up), no CloudFormation,
S3, ECR or SSM writes of its own, and `sts:AssumeRole` only on the four CDK bootstrap roles the CLI uses.
Everything that changes IAM is an **account-owner action in AWS CloudShell**. The boundary on the CDK
execution role also stops a template deployed with the key from granting the CI user more (no policies,
groups or credentials for IAM users; no new versions of `FoundryAscent-Boundary`,
`FoundryAscent-BootstrapOperator` or `FoundryAscent-LegacyCleanup`). What remains by design: whoever holds
deploy access (the OIDC deploy role, the only path since the stage-0 key was deleted) can deploy
CloudFormation within the boundary.

### Leftovers

Left for the account owner (optional hygiene): delete the IAM user `Foundry-Ascent` (it still has
`FoundryAscent-BootstrapOperator` and `IAMUserChangePassword` attached and possibly a console
password, but no access keys), and delete the repository secrets `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. The user's inline `FoundryAscent-SelfRetirement` policy and the detached managed policy
`FoundryAscent-LegacyCleanup` have no use left (their documents were removed from the repository; they are in git
history): delete them in CloudShell, or delete the user, which takes the inline policy with it.

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws iam delete-user-policy --user-name Foundry-Ascent --policy-name FoundryAscent-SelfRetirement || true
legacy="arn:aws:iam::${ACCOUNT_ID}:policy/FoundryAscent-LegacyCleanup"
for version in $(aws iam list-policy-versions --policy-arn "${legacy}" \
  --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text 2>/dev/null); do
  aws iam delete-policy-version --policy-arn "${legacy}" --version-id "${version}"
done
aws iam delete-policy --policy-arn "${legacy}" || true
```

The permissions boundary keeps denying changes to `FoundryAscent-LegacyCleanup` while it may still exist.

## Account owner: apply the policies (CloudShell)

Sign in to the AWS console as an administrator, open **CloudShell** (terminal icon in the top bar,
region `us-east-1`) and run:

```bash
git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/apply-bootstrap-access.sh
```

[`apply-bootstrap-access.sh`](apply-bootstrap-access.sh) is idempotent. It publishes
`FoundryAscent-Boundary` (from [`policies/permissions-boundary.json`](policies/permissions-boundary.json)),
publishes and attaches `FoundryAscent-BootstrapOperator`, then prints what is attached. It no longer touches the
retired inline `FoundryAscent-SelfRetirement` or `FoundryAscent-LegacyCleanup` (see [Leftovers](#leftovers)).

Run it again whenever one of the policy files changes in `main`; the CI user cannot publish them.
[`required-actions.json`](required-actions.json) lists what the stage-0 user must be able to do **and**
what it must not (`"expect": "denied"`: IAM changes, assuming other roles, direct CloudFormation changes
to `CDKToolkit` or the platform stacks, deleting platform data); CI checks the policy files against it
offline (see [Policies](#policies)).

### CDK bootstrap (account owner)

Creating or upgrading `CDKToolkit` creates and changes the `cdk-hnb659fds-*` roles, so it is also an
owner action. It is needed again only when a newer aws-cdk requires a newer bootstrap template (the deploy
fails with a bootstrap version error, or its CDKToolkit check fails):

```bash
git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/cdk-bootstrap.sh
```

[`cdk-bootstrap.sh`](cdk-bootstrap.sh) runs `cdk bootstrap` with the flags documented in
[cdk-bootstrap-permissions](../../docs/ops/cdk-bootstrap-permissions.md) (execution role capped by
`FoundryAscent-Boundary`, AWS-managed bucket key, termination protection). The former
**Platform - bootstrap** workflow is removed: the CI user can no longer bootstrap.

### Permissions boundary (account owner)

`FoundryAscent-Boundary` is published only by `apply-bootstrap-access.sh`. To permit a denied service later
(for example WAF), change [`policies/permissions-boundary.json`](policies/permissions-boundary.json) in a
reviewed commit, then the owner re-runs the script. `ops/aws/upsert_policy.py` can publish a single policy
for an administrator; no workflow runs it.

## The GitHub OIDC provider

An account holds one OIDC provider per URL. `FoundryAscent-Foundation` creates the
provider for `token.actions.githubusercontent.com` (`AWS::IAM::OIDCProvider`) unless the
CDK context `githubOidcProviderArn` imports an existing one. The **Deploy** workflow
decides on every run, before `cdk deploy`:

| Provider in the account | Managed by `FoundryAscent-Foundation` | Deploy passes `githubOidcProviderArn` | Result               |
| ----------------------- | ------------------------------------- | ------------------------------------- | -------------------- |
| no                      | —                                     | no                                    | the stack creates it |
| yes                     | yes                                   | no                                    | the stack keeps it   |
| yes                     | no (stack absent, or imported mode)   | yes                                   | the stack imports it |

Passing the ARN while the stack manages the provider would remove the resource from the
template, and CloudFormation would delete the provider every OIDC deploy depends on; the
check prevents that. The workflow first tries `iam:ListOpenIDConnectProviders`; the OIDC deploy
role has no IAM read permissions, so on AccessDenied it uses the provider's fixed ARN
(`arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`), which must
exist because the role was just assumed through it. The provider itself is created by
CloudFormation through the CDK execution role, never by the CI user.

### Deploy role trust

`FoundryAscent-GitHubDeploy` trusts exactly one subject, with `StringEquals` on both claims:
`token.actions.githubusercontent.com:sub` = `repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:production` and
`:aud` = `sts.amazonaws.com`. A job only gets that subject when it declares `environment: production`, so
the environment's protection rules gate AWS access. Set them (repository owner, Settings → Environments →
`production`): **Deployment branches and tags** → _Selected branches_ → `main` only, and optionally
required reviewers. The branch subject `ref:refs/heads/main` is no longer trusted: any workflow on `main`
without the environment could otherwise assume the role. Pinning `job_workflow_ref` was considered and
not added, because IAM support for that claim as a condition key could not be verified for this change.

## Moving to stage 1 (GitHub OIDC)

1. After the first full deploy, read the `GitHubDeployRoleArn` output of
   `FoundryAscent-Foundation` and set it as the repository **variable**
   `AWS_DEPLOY_ROLE_ARN` (Settings → Secrets and variables → Actions → Secrets; a variable also works, but a secret keeps the account id masked in the public logs).
2. Run **Deploy** manually. The job summary must show _AWS access: GitHub OIDC (stage 1)_.
3. Retire stage 0 (done 2026-10-06). The account owner does it in CloudShell: delete the user's access
   keys and detach its managed policies.

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
for key in $(aws iam list-access-keys --user-name Foundry-Ascent --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name Foundry-Ascent --access-key-id "${key}"
done
for policy in FoundryAscent-BootstrapOperator FoundryAscent-LegacyCleanup; do
  aws iam detach-user-policy --user-name Foundry-Ascent --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${policy}" || true
done
```

4. Delete the repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The IAM user
   (now without keys or managed policies) can then be deleted from the console.

**Deploy** updates every stack, and `ops/aws/inventory.py` can run locally with read-only credentials.

## Policies

| File                                 | Attached to                                                                  | Purpose                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies/bootstrap-operator.json`   | IAM user (stage 0)                                                           | Post-bootstrap: caller identity; read CloudFormation, the CDK bootstrap version, the platform roles and policies, the GitHub OIDC provider; assume the CDK deploy, file-publishing, image-publishing and lookup roles; Bedrock smoke tests; Cost Explorer and budget reads; self-retirement. Explicit `Deny` on IAM writes |
| `policies/permissions-boundary.json` | Every role the platform creates, including the CloudFormation execution role | Blocks privilege escalation (no role or user without this boundary, no edits or removal of the boundary or of the stage-0 policies, no policies or groups for IAM users, no long-lived credentials) and cost blowups (customer KMS keys, EC2, NAT, VPC endpoints, provisioned throughput, non-serverless databases, …)     |

The boundary allows every other action, so deployments do not fail on a missing
permission, while the guardrails hold even if a pipeline is compromised.

The policy files are applied verbatim (`file://` in `apply-bootstrap-access.sh`); IAM ignores
whitespace, so formatting changes never change a policy. Keep each managed policy under IAM's
6,144-character limit (whitespace excluded) and the inline policy under 2,048. `ops/aws/test_policies.py`
(CI) checks the sizes, evaluates every `required-actions.json` entry against the files (including the
must-be-denied ones, with and without the legacy policy attached), and checks that every `aws` CLI call
in `.github/workflows` is listed and allowed.

## Models used (Amazon Bedrock, `us-east-1`)

| Role                               | Model ID                                                          | Endpoint                        | IAM action (platform roles)                                    |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Coach (primary reasoning)          | `us.anthropic.claude-haiku-4-5-20251001-v1:0` (inference profile) | `bedrock-runtime` (Converse)    | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` |
| Coach fallback, background primary | `us.amazon.nova-2-lite-v1:0` (inference profile)                  | `bedrock-runtime` (Converse)    | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` |
| Background fallback                | `global.amazon.nova-2-lite-v1:0` (inference profile)              | `bedrock-runtime` (Converse)    | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` |
| Embeddings                         | `amazon.titan-embed-text-v2:0`                                    | `bedrock-runtime`               | `bedrock:InvokeModel`                                          |
| Disabled (gated)                   | `openai.gpt-6-luna`                                               | `bedrock-mantle` (`/openai/v1`) | `bedrock-mantle:CreateInference`, granted only when enabled    |

The coach (ADR-0022) serves every purpose a founder reads; the background route (`models.background`) the safety
screen, evaluations, ingestion and seeding. The app roles get each inference profile in `us-east-1` and the foundation
model behind it where the profile routes: Claude Haiku 4.5 only in `us-east-1`, `us-east-2` and `us-west-2` (its US
profile's destination regions from `us-east-1`, per its Bedrock model card); Nova 2 Lite in every region and
region-less, because its `global.` profile routes anywhere (`infra/cdk/src/lib/models.ts`). Claude is an AWS
Marketplace model: the account's one-time subscription to it is in place (the conversation lab has invoked it since
2026-11-05), so the app roles need no `aws-marketplace` action.

AWS lists GPT-6 Luna for this account but answers 401 "not available for this account",
so `infra/cdk/config/production.json` sets `models.luna.enabled = false` and the platform
roles get no `bedrock-mantle` permission. To enable it later, follow
[ADR-0014](../../docs/architecture/adr/0014-bedrock-models-luna-nova-titan.md#enabling-luna-later):
verify access (both Luna probes PASS), record an evals baseline, flip the flag in a PR,
deploy, and compare. With the flag on, Luna becomes primary and the `us.` Nova profile the
fallback. The stage-0 policy still allows the Mantle smoke tests.
