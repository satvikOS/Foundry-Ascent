# Foundry Ascent infrastructure (AWS CDK v2)

TypeScript CDK app implementing [system design §10](../../docs/architecture/system-design.md#10-infrastructure-cdk-infracdk).
Region `us-east-1`, account taken from the deploying credentials. Every IAM role is created with the
`FoundryAscent-Boundary` permissions boundary (`@aws-cdk/core:permissionsBoundary` in `cdk.json`).

| Path                     | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `config/production.json` | Deployment configuration (validated at synth by `src/config.ts`)                     |
| `src/bin/app.ts`         | CDK CLI entry (`cdk.json` → `npx tsx src/bin/app.ts`)                                |
| `src/app.ts`             | Builds the three stacks, reads context, registers cdk-nag `AwsSolutionsChecks`       |
| `src/stacks/*.ts`        | Foundation, Data and App stacks                                                      |
| `src/constructs/`        | Platform Lambda (esbuild ESM bundling), CloudFront functions and security headers    |
| `test/`                  | Vitest + `aws-cdk-lib/assertions` (no AWS credentials needed) and template snapshots |

## Stacks

### `FoundryAscent-Foundation` (termination protected)

- GitHub OIDC provider `token.actions.githubusercontent.com` (`iam.OidcProviderNative`, audience
  `sts.amazonaws.com`). If the account already has one, pass `-c githubOidcProviderArn=<arn>` to import it.
- Role `FoundryAscent-GitHubDeploy` (1 h sessions). Trust: `aud = sts.amazonaws.com` and `sub` like
  `repo:satvikOS/Foundry-Ascent:ref:refs/heads/main` or `repo:satvikOS/Foundry-Ascent:environment:production`.
  Permissions: `sts:AssumeRole`/`sts:TagSession` on `cdk-hnb659fds-*` roles, read-only CloudFormation on
  `FoundryAscent-*` and `CDKToolkit`, `logs:FilterLogEvents`/`GetLogEvents` on `/aws/lambda/FoundryAscent*`,
  `ce:GetCostAndUsage`. Everything else happens through the CDK bootstrap roles.
- Outputs: `GitHubDeployRoleArn`, `GitHubOidcProviderArn`.

### `FoundryAscent-Data` (termination protected)

- VPC `10.40.0.0/16`, 2 AZs, **isolated subnets only** (no IGW, NAT, EIP or endpoints). The default security
  group is stripped of rules; rejected traffic is flow-logged to the access-log bucket.
- Aurora Serverless v2 PostgreSQL 16.13 (`foundry-ascent`): one `db.serverless` writer, 0–2 ACU,
  auto-pause after 10 min, Data API on, storage encrypted with the AWS-managed key, 7-day backups,
  deletion protection, `SNAPSHOT` on delete, `postgresql` log export (30-day log group created before the
  cluster), security group with no ingress/egress. Secret `foundry-ascent/aurora-admin` (user `foundry_admin`).
- Documents bucket: private, SSE-S3, TLS ≥ 1.2 only, unversioned, incomplete multipart uploads aborted
  after 1 day, server access logs, CORS for presigned `PUT` (see [Design notes](#design-notes)).
- Access-log bucket (90-day expiry) for S3 server access logs and VPC flow logs.
- Jobs queue `FoundryAscent-Jobs` (SSE-SQS, visibility 720 s = 6 × worker timeout) and DLQ
  `FoundryAscent-Jobs-DLQ` (3 receives, 14-day retention), both TLS-only.
- Managed policies attached by the App stack: `DatabaseAccessPolicy` (`rds-data:*Statement`/`*Transaction`
  on the cluster, `secretsmanager:GetSecretValue` on the secret) and `DocumentsAccessPolicy`
  (`s3:Get/Put/DeleteObject` on `tenants/*`, `s3:ListBucket` limited to `tenants/`).

### `FoundryAscent-App`

- Lambdas (Node 24, ARM64, ESM bundles with source maps, log groups with 30-day retention, roles without
  AWS managed policies):
  - `FoundryAscent-Api` (`apps/api/src/handlers/api.ts`): 1024 MB, 60 s, reserved concurrency 10, Function URL
    `AWS_IAM` + `RESPONSE_STREAM`. Database + documents policies, `sqs:SendMessage`, Bedrock.
  - `FoundryAscent-Worker` (`worker.ts`): 1024 MB, 120 s, SQS event source (batch 5, partial batch
    failures, max 2 concurrent pollers). Database + documents policies, Bedrock.
  - `FoundryAscent-Migrate` (`migrate.ts`): 1024 MB, 10 min, `onEvent` handler of a custom-resource
    `Provider`. Database policy, Titan embeddings only.
  - Bedrock access follows the effective models (see [Models](#models)): `bedrock:InvokeModel` and
    `InvokeModelWithResponseStream` on the foundation models (every region, which also covers the
    region-less ARN of `global.` profiles) and on the inference profiles (`us-east-1`);
    `bedrock-mantle:CreateInference` on `*` only while GPT-6 Luna is enabled.
- `Custom::FoundryMigrations` with properties `{ version: appVersion, migrationsChecksum }`, so it runs on
  every deploy. **The API, worker and site deployments depend on it**: new code goes live only after its migrations applied,
  and a failed migration rolls the stack back before any function changes.
- Site bucket (private) and two `BucketDeployment`s of `apps/web/dist`: `assets/*` with
  `Cache-Control: public, max-age=31536000, immutable`, then everything else (incl. `index.html`) with
  `public, max-age=0, must-revalidate` and a `/*` invalidation. Both prune only their own files.
- CloudFront (price class 100, HTTP/2+3, IPv6):
  - default: S3 origin via OAC, HTTPS redirect, compression, `CachingOptimized`, viewer-request function
    that rewrites extension-less paths (not `/api`) to `/index.html`; no custom error pages, so API 4xx
    are never rewritten.
  - `/api/*`: Function URL origin via OAC, HTTPS only, `CachingDisabled`, `AllViewerExceptHostHeader`,
    all methods, no compression (keeps SSE unbuffered), 60 s origin read timeout, viewer-request
    function that sets `x-fa-viewer-host`.
  - Response headers policy on both: HSTS 2 years with subdomains and preload, `nosniff`,
    `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
    `Permissions-Policy: camera=(), microphone=(), geolocation=()` and the CSP
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`.
  - Lambda permissions for the distribution: `lambda:InvokeFunctionUrl` and (required since October 2025)
    `lambda:InvokeFunction` with `InvokedViaFunctionUrl: true`.
- Alarms to SNS topic `FoundryAscent-Alarms` (no subscriptions; subscribe in the console or add one later):
  API errors ≥ 1 and throttles ≥ 1 (5 min), worker errors ≥ 1, DLQ visible messages > 0, CloudFront
  `5xxErrorRate` > 5 % in 2 of 3 five-minute periods.
- Outputs: `SiteUrl`, `DistributionId`, `ApiFunctionName`, `ClusterArn`, `SecretArn`, `DocumentsBucket`,
  `JobsQueueUrl`, `AlarmTopicArn`.

Runtime environment of every function (runtime contract): `APP_ENV=production`, `APP_VERSION`, `LOG_LEVEL=info`,
`DB_DRIVER=dataapi`, `DB_CLUSTER_ARN`, `DB_SECRET_ARN`, `DB_NAME=foundry`, `DOCUMENTS_BUCKET`, `JOBS_QUEUE_URL`,
`MODEL_PROVIDER=bedrock`, `MODEL_PRIMARY_ID`, `MODEL_FALLBACK_ID`, `MODEL_EMBEDDINGS_ID`, `BEDROCK_REGION`,
`OWNER_ACCESS_CODE_PREFIX`, `OWNER_ACCESS_CODE_HASH`, `OWNER_DISPLAY_NAME`, `HOME_TENANT_SLUG`,
`HOME_TENANT_NAME`, `NODE_OPTIONS=--enable-source-maps`; the API also gets `SITE_ORIGIN` when a custom domain
is configured.

### Models

`config/production.json` → `models` is mapped to the runtime contract by `src/lib/models.ts`:

| `models.luna.enabled`                             | `MODEL_PRIMARY_ID`                              | `MODEL_FALLBACK_ID`                                  | Mantle permission                |
| ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| `false` (current: AWS gates Luna for the account) | `models.primary` (`us.amazon.nova-2-lite-v1:0`) | `models.fallback` (`global.amazon.nova-2-lite-v1:0`) | none                             |
| `true`                                            | `models.luna.modelId` (`openai.gpt-6-luna`)     | `models.primary` (in-geography Nova profile)         | `bedrock-mantle:CreateInference` |

`MODEL_EMBEDDINGS_ID` is always `models.embeddings` (`amazon.titan-embed-text-v2:0`). Flipping the flag is a
config change plus a normal deploy.

## Prerequisites

1. **Bootstrap** (once, account administrator → stage 0): run the **Platform - bootstrap** workflow
   (`.github/workflows/platform-bootstrap.yml`). It publishes `FoundryAscent-Boundary` and bootstraps
   `CDKToolkit` in `us-east-1` with the boundary on the CloudFormation execution role and the AWS-managed
   S3 key. Without the boundary policy every role creation is denied.
2. Node ≥ 22 (Lambdas run Node 24), pnpm 10, dependencies installed at the repository root. No Docker:
   bundling runs the workspace's esbuild locally.
3. Build inputs for a deployable synth: `apps/api/src/handlers/{api,worker,migrate}.ts` and
   `pnpm --filter @foundry/web build` (`apps/web/dist/index.html`). Missing inputs fail the synth.

## Commands

```bash
pnpm --filter @foundry/infra typecheck
pnpm --filter @foundry/infra test                 # synth + assertions + cdk-nag + snapshots
pnpm --filter @foundry/infra test -- -u           # accept reviewed template snapshot changes
pnpm --filter @foundry/infra synth:stub           # synth without built assets (FA_SYNTH_STUB_ASSETS=1)

# Deployable synth / diff / deploy (credentials for the target account; CI uses the OIDC role)
pnpm --filter @foundry/infra exec cdk synth --quiet -c appVersion=$(git rev-parse --short HEAD)
pnpm --filter @foundry/infra exec cdk diff --all -c appVersion=$(git rev-parse --short HEAD)
pnpm --filter @foundry/infra exec cdk deploy --all --require-approval never -c appVersion=$(git rev-parse --short HEAD)
```

Context keys: `appVersion` (default `dev`; CI passes the commit SHA), `siteDomainName` +
`siteCertificateArn` (optional custom domain, ACM certificate in `us-east-1`), `githubOidcProviderArn`
(import an existing provider).

`FA_SYNTH_STUB_ASSETS=1` swaps the handlers and SPA for stubs under `node_modules/.cache`. A stub assembly
is **not deployable**: every stub handler throws, so the migrate custom resource fails and CloudFormation
rolls the App stack back before stub code serves traffic.

First deploy order (handled by `--all`): Foundation → Data (~10 min, Aurora) → App (~10 min, CloudFront).
After the Foundation stack exists, set the `GitHubDeployRoleArn` output as the role for the deploy workflow
and retire the stage-0 access key (see `infra/iam/README.md`).

## Design notes

- **No stack cycles.** The CloudFront domain is generated, so nothing created before the distribution
  can reference it:
  - _Upload CORS._ The documents bucket (Data stack, deployed first) allows `PUT` from
    `https://*.cloudfront.net` (plus the custom domain when configured), headers `content-type`,
    `content-md5`, `x-amz-*`. A presigned URL (one key, short-lived, signed by the API role) is the
    authorization; CORS only decides which pages may use one from a browser.
  - _`SITE_ORIGIN`._ Distribution → Function URL → API function, so the function's environment cannot
    contain the distribution domain. Without a custom domain `SITE_ORIGIN` is not set; the `/api/*`
    viewer-request function sets `x-fa-viewer-host` to the Host the browser addressed (CloudFront only
    routes Hosts that belong to the distribution, the client value is overwritten, and the Function URL
    only accepts SigV4 requests from this distribution), so the API uses `https://<x-fa-viewer-host>`.
    With `siteDomainName` the origin is static and passed as `SITE_ORIGIN`.
- **Cross-stack references are weak** (`@aws-cdk/core:defaultCrossStackReferences: "weak"`, the 2.272
  recommendation): the App stack reads Data outputs with `Fn::GetStackOutput`, so changing an output never
  deadlocks on an export. Termination protection on Data replaces the coupling strong references gave.
- **Access policies live with the data.** The Data stack owns the IAM policies for its cluster, secret and
  bucket; the App stack only decides which role gets which.
- **TLS 1.2 minimum needs a custom domain.** With the default `*.cloudfront.net` certificate CloudFront fixes
  the viewer security policy at TLSv1; `siteDomainName` + `siteCertificateArn` switch to `TLSv1.2_2021`.
  HSTS is sent either way.
- **Retention.** The cluster snapshots on delete; the secret and buckets use `RetainExceptOnCreate`
  (kept on delete/replace, but not orphaned by a failed first deploy). Because of deletion protection,
  a failed _first_ Data deploy that already created the cluster ends in `ROLLBACK_FAILED`: disable
  deletion protection on `foundry-ascent` and continue the rollback.

### Permissions-boundary conflicts avoided

| Boundary denies                                                        | How the app stays clear                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ec2:CreateNatGateway`, `ec2:AllocateAddress`, `ec2:CreateVpcEndpoint` | Isolated subnets only; Lambdas run outside the VPC and use the Data API                                                                      |
| `ec2:RunInstances`                                                     | No instances (asserted in tests)                                                                                                             |
| `kms:CreateKey`                                                        | AWS-managed keys only (RDS, Secrets Manager, S3 SSE-S3, SQS SSE-SQS); unencrypted SNS (alarm metadata only, CloudWatch cannot use `aws/sns`) |
| `rds:CreateDBInstance` unless `db.serverless`                          | Single `db.serverless` writer                                                                                                                |
| `rds:CreateDBProxy`                                                    | Data API instead of a proxy                                                                                                                  |
| `lambda:PutProvisionedConcurrencyConfig`                               | Reserved concurrency only                                                                                                                    |
| `wafv2:CreateWebACL`                                                   | No WAF (cdk-nag CFR2 acknowledged); abuse controls live in the API                                                                           |
| Roles without the boundary                                             | Boundary injected into every role, CDK-internal ones included (asserted in tests)                                                            |

### cdk-nag

`AwsSolutionsChecks` (cdk-nag 3, CDK policy-validation plugin) runs on every synth; any unacknowledged finding
fails synthesis. cdk-nag 3 replaced `NagSuppressions` with `Validations.of(construct).acknowledge()`; all
acknowledgments go through `src/lib/nag.ts`, which requires a rule-specific id and a written reason and
derives IAM5 finding ids from the policy values themselves. They are attached to the narrowest construct:

| Finding                | Where                                                              | Why                                                                                                             |
| ---------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| IAM5                   | GitHub deploy policy                                               | bootstrap role prefix, stack-id suffix, `ListStacks`/`ce` without resource scoping, platform log groups         |
| IAM5                   | api/worker/migrate roles, documents policy                         | foundation models in all regions (cross-region/global profiles), Mantle on `*` (Luna only), `tenants/*` objects |
| IAM4, IAM5, L1         | BucketDeployment handler, provider framework (aws-cdk-lib managed) | generated by the construct library                                                                              |
| RDS6                   | Aurora                                                             | Data API only, no network path for IAM DB auth                                                                  |
| SMG4                   | Aurora secret                                                      | rotation Lambda needs VPC endpoint/NAT (denied)                                                                 |
| S1                     | site bucket                                                        | public build output, read only via OAC                                                                          |
| CFR1, CFR2, CFR3, CFR4 | distribution                                                       | no geo policy, WAF denied, logging v1 needs ACLs, default certificate (CFR4 only without custom domain)         |

## Cost notes (idle ≈ $1–3/month)

- Aurora: $0 compute while paused (0 ACU); storage ~$0.10/GB-month; first request after a pause waits
  ~15 s. Max 2 ACU caps the bill under load. Backups within the retention window of the cluster size are free.
- No NAT gateway, EIP, VPC endpoint, customer KMS key, WAF, provisioned concurrency or Performance Insights.
- Secrets Manager: one secret ($0.40/month). S3/CloudFront/SQS/SNS/CloudWatch alarms: cents at V1 traffic
  (5 standard alarms ≈ $0.50/month). Log groups expire after 30 days; access logs after 90.
- Reserved concurrency is a budget cap, not a cost. New accounts can have a total concurrency quota of 10,
  which leaves no room to reserve 10 for the API; request a quota increase before the first deploy if
  `PutFunctionConcurrency` fails.
- Bedrock spend is capped per day in the database (`platform_settings`), outside this stack.
