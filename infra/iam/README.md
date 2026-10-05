# AWS identity and access

Foundry Ascent deploys from GitHub Actions. Access is staged so that long-lived
credentials exist only for the short bootstrap window.

| Stage | Principal | Credentials | Permissions |
| --- | --- | --- | --- |
| 0 — Bootstrap (now) | IAM user `Foundry-Ascent` | Access key in GitHub secrets | `FoundryAscent-BootstrapOperator` + `FoundryAscent-LegacyCleanup` |
| 1 — Steady state | IAM role `FoundryAscent-GitHubDeploy` | GitHub OIDC, 1-hour sessions, `main` branch only | Assume CDK deploy roles; read-only operations |
| Every platform role | CDK and application roles | Short-lived (STS) | Capped by `FoundryAscent-Boundary` |

After stage 1 is verified, the bootstrap workflow detaches both stage-0 policies and
deletes the access key. The IAM user can then be deleted from the console.

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

Then run the **Ops - verify AWS access** workflow; it simulates every action the
platform needs and probes the three Bedrock models.

## Policies

| File | Attached to | Purpose |
| --- | --- | --- |
| `policies/bootstrap-operator.json` | IAM user (stage 0) | CDK bootstrap (`CDKToolkit`), `FoundryAscent*` stacks, roles and policies, GitHub OIDC provider, Bedrock smoke tests, Cost Explorer read, self-retirement |
| `policies/legacy-cleanup.json` | IAM user (stage 0) | Inventory and deletion of resources that predate Foundry Ascent. Detached after cleanup |
| `policies/permissions-boundary.json` | Every role the platform creates, including the CloudFormation execution role | Blocks privilege escalation (no role or user without this boundary, no boundary edits or removal, no long-lived credentials) and cost blowups (customer KMS keys, EC2, NAT, VPC endpoints, provisioned throughput, non-serverless databases, …) |

The boundary allows every other action, so deployments do not fail on a missing
permission, while the guardrails hold even if a pipeline is compromised. To permit a
denied service later (for example WAF), change the boundary in a reviewed commit.

## Models used (Amazon Bedrock, `us-east-1`)

| Role | Model ID | Endpoint | IAM action |
| --- | --- | --- | --- |
| Primary reasoning | `openai.gpt-6-luna` | `bedrock-mantle` (`/openai/v1`) | `bedrock-mantle:CreateInference` |
| Fallback reasoning | `amazon.nova-2-lite-v1:0` | `bedrock-runtime` | `bedrock:InvokeModel*` |
| Embeddings | `amazon.titan-embed-text-v2:0` | `bedrock-runtime` | `bedrock:InvokeModel` |
