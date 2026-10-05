# AWS identity and access

Foundry Ascent deploys from GitHub Actions. Access is staged so that long-lived
credentials exist only for the short bootstrap window
([ADR-0016](../../docs/architecture/adr/0016-staged-iam-github-oidc.md)).

| Stage               | Principal                             | Credentials                                                     | Permissions                                                       |
| ------------------- | ------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0 — Bootstrap (now) | IAM user `Foundry-Ascent`             | Access key in GitHub secrets                                    | `FoundryAscent-BootstrapOperator` + `FoundryAscent-LegacyCleanup` |
| 1 — Steady state    | IAM role `FoundryAscent-GitHubDeploy` | GitHub OIDC, 1-hour sessions, `main` branch or `production` env | Assume CDK deploy roles; read-only operations                     |
| Every platform role | CDK and application roles             | Short-lived (STS)                                               | Capped by `FoundryAscent-Boundary`                                |

## Where it stands (2026-10-05)

Stage 0 is in use. With it, the **Platform - bootstrap** workflow published the boundary and bootstrapped
`CDKToolkit`, and **Platform - deploy data stack** deployed `FoundryAscent-Data` first, on its own. The
first full **Deploy** creates `FoundryAscent-Foundation` (the GitHub OIDC provider and the deploy role)
and `FoundryAscent-App`. Stage 1 follows from there ([Moving to stage 1](#moving-to-stage-1-github-oidc)).

## One-time setup (account administrator)

### Option A — AWS CloudShell (one command)

Sign in to the AWS console as an administrator, open **CloudShell** (terminal icon in
the top bar, region `us-east-1`) and run:

```bash
git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/apply-bootstrap-access.sh
```

The script is idempotent and prints the policies attached to `Foundry-Ascent`.

### Option B — Console only

1. IAM → **Policies** → **Create policy** → **JSON**, paste
   [`policies/bootstrap-operator.json`](policies/bootstrap-operator.json), name it
   `FoundryAscent-BootstrapOperator`.
2. Repeat with [`policies/legacy-cleanup.json`](policies/legacy-cleanup.json), name it
   `FoundryAscent-LegacyCleanup`.
3. IAM → **Users** → `Foundry-Ascent` → **Add permissions** → **Attach policies
   directly** → select both → **Add permissions**.

Then run the **Ops - verify AWS access** workflow; it simulates every action in
[`required-actions.json`](required-actions.json) and probes the Bedrock models: Nova 2 Lite
and Titan must pass; the GPT-6 Luna probes only warn while `models.luna.enabled` is `false`
(see [Models](#models-used-amazon-bedrock-us-east-1)).

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
`iam:ListOpenIDConnectProviders`. The stage-1 role has no IAM read permissions; under
OIDC the workflow uses the provider's fixed ARN
(`arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`), which must
exist because the role was just assumed through it.

## Moving to stage 1 (GitHub OIDC)

1. After the first full deploy, read the `GitHubDeployRoleArn` output of
   `FoundryAscent-Foundation` and set it as the repository **variable**
   `AWS_DEPLOY_ROLE_ARN` (Settings → Secrets and variables → Actions → Variables).
2. Run **Deploy** manually. The job summary must show _AWS access: GitHub OIDC (stage 1)_.
3. Retire stage 0 (account administrator, CloudShell). Nothing does this automatically:

   ```bash
   ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
   for key in $(aws iam list-access-keys --user-name Foundry-Ascent --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
     aws iam delete-access-key --user-name Foundry-Ascent --access-key-id "${key}"
   done
   for policy in FoundryAscent-BootstrapOperator FoundryAscent-LegacyCleanup; do
     aws iam detach-user-policy --user-name Foundry-Ascent --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${policy}" || true
   done
   ```

4. Delete the repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The
   IAM user can then be deleted from the console.

After stage 0 is retired, the workflows that run as the IAM user (**Ops - …**,
**Platform - bootstrap**, **Platform - deploy data stack**) stop working by design;
**Deploy** updates every stack, and `ops/aws/inventory.py` can run locally with read-only
credentials.

## Policies

| File                                 | Attached to                                                                  | Purpose                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies/bootstrap-operator.json`   | IAM user (stage 0)                                                           | CDK bootstrap (`CDKToolkit`), `FoundryAscent*` stacks, roles and policies, GitHub OIDC provider (create and list), Bedrock smoke tests, Cost Explorer read and budgets, self-retirement                                                         |
| `policies/legacy-cleanup.json`       | IAM user (stage 0)                                                           | Inventory and deletion of resources that predate Foundry Ascent. Detach after the cleanup is closed                                                                                                                                             |
| `policies/permissions-boundary.json` | Every role the platform creates, including the CloudFormation execution role | Blocks privilege escalation (no role or user without this boundary, no boundary edits or removal, no long-lived credentials) and cost blowups (customer KMS keys, EC2, NAT, VPC endpoints, provisioned throughput, non-serverless databases, …) |

The boundary allows every other action, so deployments do not fail on a missing
permission, while the guardrails hold even if a pipeline is compromised. To permit a
denied service later (for example WAF), change the boundary in a reviewed commit.

The policy files are applied verbatim (`file://` in `apply-bootstrap-access.sh`, and
`ops/aws/upsert_policy.py` for the boundary); IAM ignores whitespace, so formatting
changes never change a policy. Keep each document under IAM's 6,144-character limit
(whitespace excluded).

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
fallback. The stage-0 policy already allows the Mantle smoke tests.
