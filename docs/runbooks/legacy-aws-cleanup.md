# Runbook: legacy AWS cleanup

**Who:** platform owner with the stage-0 IAM user · **Workflow:** `.github/workflows/ops-aws-cleanup.yml`
(**Ops - AWS legacy cleanup**) · **Code:** `ops/aws/cleanup.py`, tests `ops/aws/test_cleanup.py` ·
**Policy:** `infra/iam/policies/legacy-cleanup.json`

The AWS account predates Foundry Ascent and contained billable resources from earlier projects. This
one-time tool removes them so the account bill reflects only Foundry Ascent (target $1–3/month idle,
[cost controls](cost-controls.md)). It is designed to be safe to run repeatedly: **plan** is read-only,
**apply** deletes only what the plan lists, and everything belonging to Foundry Ascent or the CDK
bootstrap is protected twice.

## How it works

1. **Identity and masking:** calls `sts:GetCallerIdentity`, masks the account id in the GitHub log, and
   redacts any run of 6+ digits from AWS error messages (the repository and its logs are public).
2. **Protected set:** before touching anything, it lists the protected CloudFormation stacks
   (`CDKToolkit`, `FoundryAscent*`) in every region and collects their physical resources, plus
   Route 53 zones and certificates that serve kept mail domains. If a region's protected stacks cannot be
   listed, **nothing in that region is changed**, and no global resource (IAM, CloudFront, Route 53, S3)
   is changed either.
3. **Order:** legacy CloudFormation stacks first (stacks in `DELETE_FAILED` are retried while retaining
   only the resources CloudFormation could not delete), then per region: KMS, Secrets Manager, Lambda,
   API Gateway, DynamoDB, EC2 (instances, NAT gateways, Elastic IPs, volumes, snapshots, AMIs, and
   non-default VPCs with their endpoints, gateways, subnets and security groups), load balancers, RDS, ECR, ECS, logs and alarms, messaging, other regional services; then global:
   CloudFront, Route 53, S3, IAM.
4. **Every mutating call goes through one guard** (`Mutator.call`) that refuses unless the mode is
   `apply`, and re-checks the target against protected names and markers (`foundryascent`,
   `foundry-ascent`, `cdk-hnb659fds`, `cdktoolkit`, `/cdk-bootstrap/`, the GitHub OIDC provider, the
   platform's log groups such as `/aws/rds/cluster/foundry-ascent/postgresql`,
   `OrganizationAccountAccessRole`, AWS-reserved and service-linked roles). The IAM policy allows deletes
   on `*`, so this guard — not IAM — is the safety net; it is covered by unit tests.
5. **Never touched:** IAM users and groups, AWS-managed KMS keys, service-linked roles, the default VPC,
   registered domains, AWS-owned backup vaults. Route 53 zones with MX records are skipped unless
   `include_mail_zones` is set.
6. **Reversible where AWS allows:** KMS keys and Secrets Manager secrets are _scheduled_ for deletion with a
   7-day window (billing stops at once; restorable for 7 days). CloudFront distributions are disabled
   first and deleted on a later run once disabled. Large S3 buckets get an expiry lifecycle rule and are
   deleted by a re-run after ~48 hours.
7. **One failure never aborts the run.** Every outcome is recorded — `planned` (plan mode), `done`,
   `skipped` (with the refusal or skip reason) and `failed` (AWS error code) — summarised in the job summary
   and saved as artifact `cleanup-report-<mode>` (`cleanup-report.json`, 7 days).

## Procedure

1. **Plan** — Actions → **Ops - AWS legacy cleanup** → _Run workflow_: `mode = plan`, `regions = all`.
   Read the job summary: every row is a resource that apply would change. Check that nothing you need
   (for example a kept domain's DNS zone) is listed; if it is, stop and add a protection in
   `cleanup.py` with a test.
2. **Apply** — run again with `mode = apply` and `confirm = DELETE-LEGACY-RESOURCES`. Without the exact
   phrase the job fails before any AWS call.
3. **Re-run apply after ~48 hours** for CloudFront distributions (disabled on the first run) and large
   buckets (emptied by lifecycle rules).
4. **Verify** with **Ops - AWS inventory (read-only)**: only Foundry Ascent, CDK bootstrap and the kept
   domains remain; the next month's bill confirms it.
5. **Close out:** detach `FoundryAscent-LegacyCleanup` from the IAM user `Foundry-Ascent`
   (`infra/iam/README.md`). After that, the workflow fails with AccessDenied by design.

## Recovering something deleted by mistake

| Resource                                | Recovery                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| KMS key, Secrets Manager secret         | Within 7 days: `aws kms cancel-key-deletion --key-id …` / `aws secretsmanager restore-secret --secret-id …` |
| RDS instance or cluster                 | From the final or automated snapshot, if one existed (`aws rds restore-db-instance-from-db-snapshot …`)     |
| CloudFront distribution                 | Disabled first: re-enable it before the next apply run                                                      |
| Route 53 zone                           | Recreate and re-enter records (name servers change; update the registrar)                                   |
| S3 objects, Lambda functions, IAM roles | Not recoverable; redeploy from source                                                                       |

## Extending the tool

Add the resource type to a step in `cleanup.py`, route every delete through `self.m.call(...)` with a
`reason`, add a unit test in `test_cleanup.py` (including a protected-name refusal), run
`pip install -r requirements-dev.txt && ruff check . && python -m pytest` in `ops/aws` (the CI-pinned
toolchain), and run **plan** before any apply.
