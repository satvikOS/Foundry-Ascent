# AWS identity and access

Foundry Ascent deploys from GitHub Actions. Access is staged so that long-lived
credentials exist only for the short bootstrap window
([ADR-0016](../../docs/architecture/adr/0016-staged-iam-github-oidc.md)).

| Stage               | Principal                             | Credentials                                                 | Permissions                                                                      |
| ------------------- | ------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0 — Bootstrap (now) | IAM user `Foundry-Ascent`             | Access key in GitHub secrets                                | `FoundryAscent-BootstrapOperator` (post-bootstrap, read-only + assume CDK roles) |
| 1 — Steady state    | IAM role `FoundryAscent-GitHubDeploy` | GitHub OIDC, 1-hour sessions, `production` environment only | Assume the four CDK bootstrap roles; read-only operations                        |
| Every platform role | CDK and application roles             | Short-lived (STS)                                           | Capped by `FoundryAscent-Boundary`                                               |
| Account owner       | Administrator (console / CloudShell)  | Console sign-in                                             | Publishes the policies and the boundary, bootstraps CDK, creates the budget      |

## Where it stands (2026-10-05)

Stage 0 is in use. The boundary is published, `CDKToolkit` is bootstrapped and `FoundryAscent-Data`
is deployed. The first full **Deploy** creates `FoundryAscent-Foundation` (the GitHub OIDC provider and
the deploy role) and `FoundryAscent-App`. Stage 1 follows from there
([Moving to stage 1](#moving-to-stage-1-github-oidc)).

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
deploy access (the stage-0 key now, the OIDC role later) can deploy CloudFormation within the boundary.

## Account owner: apply the policies (CloudShell)

Sign in to the AWS console as an administrator, open **CloudShell** (terminal icon in the top bar,
region `us-east-1`) and run:

```bash
git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/apply-bootstrap-access.sh
```

[`apply-bootstrap-access.sh`](apply-bootstrap-access.sh) is idempotent. It publishes
`FoundryAscent-Boundary` (from [`policies/permissions-boundary.json`](policies/permissions-boundary.json)),
publishes and attaches `FoundryAscent-BootstrapOperator`, puts the inline policy
`FoundryAscent-SelfRetirement` ([`policies/self-retirement.json`](policies/self-retirement.json)) on the
user, publishes the tightened `FoundryAscent-LegacyCleanup` if it exists and **detaches** it (pass
`--with-legacy-cleanup` only while a legacy cleanup is still running), then prints what is attached.

Run it again whenever one of the policy files changes in `main`; the CI user cannot publish them. Then
run **Ops - verify AWS access**: it simulates every entry of
[`required-actions.json`](required-actions.json) — what the CI user must be able to do **and** what it
must not (`"expect": "denied"`: IAM changes, assuming other roles, direct CloudFormation changes to
`CDKToolkit` or the platform stacks, deleting platform data) — and probes the Bedrock models: Nova 2 Lite
and Titan must pass; the GPT-6 Luna probes only warn while `models.luna.enabled` is `false`
(see [Models](#models-used-amazon-bedrock-us-east-1)).

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
check prevents that. The stage-0 user lists providers with
`iam:ListOpenIDConnectProviders` (read-only, kept in the post-bootstrap policy). The stage-1
role has no IAM read permissions; under OIDC the workflow uses the provider's fixed ARN
(`arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`), which must
exist because the role was just assumed through it. The provider itself is created by
CloudFormation through the CDK execution role, never by the CI user.

### Deploy role trust

`FoundryAscent-GitHubDeploy` trusts exactly one subject, with `StringEquals` on both claims:
`token.actions.githubusercontent.com:sub` = `repo:satvikOS/Foundry-Ascent:environment:production` and
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
3. Retire stage 0 with **Ops - retire stage-0 AWS access**
   ([`ops-aws-retire-stage0.yml`](../../.github/workflows/ops-aws-retire-stage0.yml)):
   1. `mode = plan` (read-only): lists the user's policies, access keys (last four characters) and
      whether it has a console password.
   2. `mode = detach-legacy-cleanup` once the legacy cleanup is closed (if the policy is still attached).
   3. `mode = retire`, `confirm = RETIRE-STAGE-0`: refused unless `AWS_DEPLOY_ROLE_ARN` is set and names
      an existing `FoundryAscent-GitHubDeploy` role. It deletes every other access key, detaches
      `FoundryAscent-LegacyCleanup` and `FoundryAscent-BootstrapOperator`, and deletes its own key last
      (allowed by the inline `FoundryAscent-SelfRetirement` policy, which only lets the user detach its
      own policies and delete its own keys).
4. Delete the repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The IAM user
   (now without keys or managed policies) can then be deleted from the console.

The same can be done by the account owner in CloudShell:

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
for key in $(aws iam list-access-keys --user-name Foundry-Ascent --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name Foundry-Ascent --access-key-id "${key}"
done
for policy in FoundryAscent-BootstrapOperator FoundryAscent-LegacyCleanup; do
  aws iam detach-user-policy --user-name Foundry-Ascent --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${policy}" || true
done
```

After stage 0 is retired, the workflows that run as the IAM user (**Ops - …**,
**Platform - deploy data stack**) stop working by design; **Deploy** updates every stack,
and `ops/aws/inventory.py` can run locally with read-only credentials.

## Policies

| File                                 | Attached to                                                                  | Purpose                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies/bootstrap-operator.json`   | IAM user (stage 0)                                                           | Post-bootstrap: caller identity; read CloudFormation, the CDK bootstrap version, the platform roles and policies, the GitHub OIDC provider; assume the CDK deploy, file-publishing, image-publishing and lookup roles; Bedrock smoke tests; Cost Explorer and budget reads; self-retirement. Explicit `Deny` on IAM writes                          |
| `policies/self-retirement.json`      | IAM user (stage 0), inline `FoundryAscent-SelfRetirement`                    | List the user's policies and keys, detach its policies, delete its keys — on the user itself only. Survives the managed policies so the last key can be deleted                                                                                                                                                                                     |
| `policies/legacy-cleanup.json`       | Nobody by default (historical; attach only for a legacy cleanup run)         | Inventory and deletion of resources that predate Foundry Ascent. Explicit `Deny` statements protect `CDKToolkit`, `FoundryAscent*` stacks, the `cdk-*`/`FoundryAscent*` roles and policies, the OIDC provider, platform buckets, Aurora, its secret, functions, queues, topics, logs, parameters and every resource tagged `project=foundry-ascent` |
| `policies/permissions-boundary.json` | Every role the platform creates, including the CloudFormation execution role | Blocks privilege escalation (no role or user without this boundary, no edits or removal of the boundary or of the stage-0 policies, no policies or groups for IAM users, no long-lived credentials) and cost blowups (customer KMS keys, EC2, NAT, VPC endpoints, provisioned throughput, non-serverless databases, …)                              |

The boundary allows every other action, so deployments do not fail on a missing
permission, while the guardrails hold even if a pipeline is compromised.

The policy files are applied verbatim (`file://` in `apply-bootstrap-access.sh`); IAM ignores
whitespace, so formatting changes never change a policy. Keep each managed policy under IAM's
6,144-character limit (whitespace excluded) and the inline policy under 2,048. `ops/aws/test_policies.py`
(CI) checks the sizes, evaluates every `required-actions.json` entry against the files (including the
must-be-denied ones, with and without the legacy policy attached), and checks that every `aws` CLI call
in `.github/workflows` is listed and allowed.

## Models used (Amazon Bedrock, `us-east-1`)

| Role               | Model ID                                             | Endpoint                        | IAM action (platform roles)                                    |
| ------------------ | ---------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Primary reasoning  | `us.amazon.nova-2-lite-v1:0` (inference profile)     | `bedrock-runtime` (Converse)    | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` |
| Fallback reasoning | `global.amazon.nova-2-lite-v1:0` (inference profile) | `bedrock-runtime` (Converse)    | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` |
| Embeddings         | `amazon.titan-embed-text-v2:0`                       | `bedrock-runtime`               | `bedrock:InvokeModel`                                          |
| Disabled (gated)   | `openai.gpt-6-luna`                                  | `bedrock-mantle` (`/openai/v1`) | `bedrock-mantle:CreateInference`, granted only when enabled    |

AWS lists GPT-6 Luna for this account but answers 401 "not available for this account",
so `infra/cdk/config/production.json` sets `models.luna.enabled = false` and the platform
roles get no `bedrock-mantle` permission. To enable it later, follow
[ADR-0014](../../docs/architecture/adr/0014-bedrock-models-luna-nova-titan.md#enabling-luna-later):
verify access (both Luna probes PASS), record an evals baseline, flip the flag in a PR,
deploy, and compare. With the flag on, Luna becomes primary and the `us.` Nova profile the
fallback. The stage-0 policy still allows the Mantle smoke tests.
