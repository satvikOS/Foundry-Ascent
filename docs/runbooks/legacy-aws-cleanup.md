# Runbook: legacy AWS cleanup (archived)

> **Archived: one-time, closed.** On 2026-10-06 `FoundryAscent-LegacyCleanup` was detached and the
> stage-0 access key deleted ([`infra/iam/README.md`](../../infra/iam/README.md)). The tool, its workflow
> (**Ops - AWS legacy cleanup**) and its tests were then removed from the repository; they remain in git
> history (last present at commit `fa71764`, `ops/aws/cleanup.py`). This page is kept as the record of
> what the tool did and how to recover from it. Another cleanup would need its own reviewed credentials
> ([ADR-0016](../architecture/adr/0016-staged-iam-github-oidc.md)).

**Who:** platform owner with the stage-0 IAM user (retired) · **Policy:**
`infra/iam/policies/legacy-cleanup.json` (kept, detached)

The AWS account predates Foundry Ascent and contained billable resources from earlier projects. This
one-time tool removed them so the account bill reflects only Foundry Ascent (about $1–3/month idle plus
usage, [cost controls](cost-controls.md)). It was designed to be safe to run repeatedly: **plan** is read-only,
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
   `OrganizationAccountAccessRole`, AWS-reserved and service-linked roles); it is covered by unit tests.
   IAM backs it up: `legacy-cleanup.json` allows deletes on `*` but explicitly **denies** them on
   `CDKToolkit` and `FoundryAscent*` stacks, `cdk-*`/`FoundryAscent*` roles and policies, the GitHub OIDC
   provider, `cdk-*`/`foundryascent*`/`foundry-ascent*` buckets, the `foundry-ascent` Aurora cluster and
   its secret, `FoundryAscent*` functions, queues, topics, rules and log groups, `/cdk-bootstrap/`
   parameters, and every resource tagged `project=foundry-ascent` (`ops/aws/test_policies.py`).
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

## How it was run

The procedure was: **plan** (read-only; every row of the job summary is a resource apply would change),
then **apply** with the confirmation phrase `DELETE-LEGACY-RESOURCES`, apply again after about 48 hours
for disabled CloudFront distributions and buckets emptied by lifecycle rules, a check with the read-only
inventory, and a close-out that detached `FoundryAscent-LegacyCleanup` from the IAM user. The
account owner's `infra/iam/apply-bootstrap-access.sh` still publishes the policy if it exists and keeps
it detached unless `--with-legacy-cleanup` is given.

## Recovering something deleted by mistake

| Resource                                | Recovery                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| KMS key, Secrets Manager secret         | Within 7 days: `aws kms cancel-key-deletion --key-id …` / `aws secretsmanager restore-secret --secret-id …` |
| RDS instance or cluster                 | From the final or automated snapshot, if one existed (`aws rds restore-db-instance-from-db-snapshot …`)     |
| CloudFront distribution                 | Disabled first: re-enable it before the next apply run                                                      |
| Route 53 zone                           | Recreate and re-enter records (name servers change; update the registrar)                                   |
| S3 objects, Lambda functions, IAM roles | Not recoverable; redeploy from source                                                                       |
