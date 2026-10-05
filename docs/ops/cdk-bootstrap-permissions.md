# CDK bootstrap: IAM coverage for the stage-0 user

The **Platform - bootstrap** workflow (`.github/workflows/platform-bootstrap.yml`) runs
`cdk bootstrap` (aws-cdk 2.1144.0, bootstrap template version 32) as the IAM user
`Foundry-Ascent`. It passes no `--role-arn`, so CloudFormation calls every resource handler with the
caller's own credentials. This page checks every one of those calls against
`infra/iam/policies/bootstrap-operator.json`. `legacy-cleanup.json` is not counted, because it is
detached after the cleanup.

**Result:** the bootstrap is fully covered for create, for idempotent re-runs, and for rollback or
delete. Six actions are not granted. None of them runs in this workflow; see
[Not covered](#not-covered).

Sources:

- Template: `aws-cdk@2.1144.0/lib/api/bootstrap/bootstrap-template.yaml` (line numbers below).
- Handler permissions: the CloudFormation registry schemas
  (`https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip`, fetched
  2026-10-05), `handlers.{create,read,update,delete}.permissions`.
- CLI calls: `aws-cdk@2.1144.0/lib/index.js` (line numbers below).

## Command

```bash
npx --yes aws-cdk@2.1144.0 bootstrap "aws://$ACCOUNT_ID/us-east-1" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --custom-permissions-boundary FoundryAscent-Boundary \
  --bootstrap-kms-key-id AWS_MANAGED_KEY \
  --termination-protection \
  --tags project=foundry-ascent
```

The flags are defined in `lib/cli/parse-command-line-arguments.js`. Lines 264
(`bootstrap-kms-key-id`), 277 (`custom-permissions-boundary`), 305 (`tags`), 339
(`cloudformation-execution-policies`) and 352 (`termination-protection`) sit inside the `bootstrap`
command at line 257. The same flags are listed in `lib/cli/cli-config.js` at lines 129, 131, 136, 141
and 143. Running the command locally with `--show-template` parses all of them without a conflict.

The command resolves to these template parameters (`modernBootstrap`, `lib/index.js` 112476-112567):

| Parameter                         | Value                                         | Effect                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FileAssetsBucketKmsKeyId`        | `AWS_MANAGED_KEY`                             | Condition `CreateNewKey` is false, so no KMS key or alias is created. The bucket uses SSE-KMS with the AWS-managed `aws/s3` key.                                                |
| `UseExamplePermissionsBoundary`   | `false` (default)                             | No `AWS::IAM::ManagedPolicy` is created.                                                                                                                                        |
| `InputPermissionsBoundary`        | `FoundryAscent-Boundary`                      | The CloudFormation execution role is created with this boundary (template 740-744). The CLI only checks the name against a regex (112568-112571, 112655) and makes no IAM call. |
| `CloudFormationExecutionPolicies` | `arn:aws:iam::aws:policy/AdministratorAccess` | Effective permissions of the execution role are AdministratorAccess ∩ FoundryAscent-Boundary.                                                                                   |
| `Qualifier` / `TrustedAccounts`   | `hnb659fds` (default) / empty                 | Physical names below. No cross-account trust.                                                                                                                                   |

Choices:

- **`--bootstrap-kms-key-id AWS_MANAGED_KEY` is passed explicitly.** Without it, the CLI picks
  `AWS_MANAGED_KEY` only when the stack is new (112522).
- **`--no-previous-parameters` is not passed.** With it, any parameter not given on the command line
  falls back to its template default (`ParameterValues`, 96467-96491). For
  `FileAssetsBucketKmsKeyId` that default is `''`, which means "create a customer KMS key". That
  costs $1/month, and `kms:CreateKey` is not granted, so the run would fail.
- **`--termination-protection` is passed.** `legacy-cleanup.json` grants `cloudformation:DeleteStack`
  on `*`, and termination protection stops it from deleting `CDKToolkit` by accident.

## Template resources

`<acct>` stands for the account ID. Names come from the default qualifier `hnb659fds`.

| Logical ID (template line)                                   | Type                                  | Created                                          | Physical name                                                         | IAM actions, as create / update / delete (read and import use the read handler)                                                                                                                                                                                                                                                                                                                                                                                                                                     | Covered by Sid                                                                                               |
| ------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FileAssetsBucketEncryptionKey` (129)                        | `AWS::KMS::Key`                       | **No**: `CreateNewKey` is false                  | n/a                                                                   | kms:CreateKey, PutKeyPolicy, TagResource, EnableKeyRotation, DisableKey / + UpdateKeyDescription, UntagResource / ScheduleKeyDeletion                                                                                                                                                                                                                                                                                                                                                                               | Not granted, and not needed (see [Not covered](#not-covered))                                                |
| `FileAssetsBucketEncryptionKeyAlias` (187)                   | `AWS::KMS::Alias`                     | **No**: `CreateNewKey` is false                  | `alias/cdk-hnb659fds-assets-key`                                      | kms:CreateAlias / UpdateAlias / DeleteAlias                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not granted, and not needed                                                                                  |
| `StagingBucket` (195)                                        | `AWS::S3::Bucket`                     | Yes                                              | `cdk-hnb659fds-assets-<acct>-us-east-1`                               | s3:CreateBucket, PutEncryptionConfiguration, PutBucketPublicAccessBlock, PutBucketVersioning, PutLifecycleConfiguration, PutBucketTagging, TagResource, GetBucketAcl, ListBucket / the same Put* plus Delete* bucket-config actions, PutBucketAcl, UntagResource / none (`DeletionPolicy: Retain`; otherwise DeleteBucket, ListBucket). Read: s3:GetBucket*, GetEncryptionConfiguration, GetLifecycleConfiguration, ListTagsForResource                                                                             | **CdkStagingBucket** (`s3:*` on `arn:aws:s3:::cdk-*`)                                                        |
| `StagingBucketPolicy` (239)                                  | `AWS::S3::BucketPolicy`               | Yes                                              | (on the bucket above)                                                 | s3:PutBucketPolicy, GetBucketPolicy / same / s3:DeleteBucketPolicy                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **CdkStagingBucket**                                                                                         |
| `ContainerAssetsRepository` (256)                            | `AWS::ECR::Repository`                | Yes                                              | `cdk-hnb659fds-container-assets-<acct>-us-east-1`                     | ecr:CreateRepository, PutLifecyclePolicy, SetRepositoryPolicy, TagResource / + PutImageTagMutability, PutImageScanningConfiguration, DeleteLifecyclePolicy, DeleteRepositoryPolicy, UntagResource, DescribeRepositories / ecr:DeleteRepository. Read: DescribeRepositories, GetLifecyclePolicy, GetRepositoryPolicy, ListTagsForResource                                                                                                                                                                            | **CdkContainerRepository** (`ecr:*` on `repository/cdk-*`, us-east-1)                                        |
| `FilePublishingRole` (310)                                   | `AWS::IAM::Role`                      | Yes                                              | `cdk-hnb659fds-file-publishing-role-<acct>-us-east-1`                 | See the IAM role row below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **BootstrapAndPlatformRoles**                                                                                |
| `ImagePublishingRole` (364)                                  | `AWS::IAM::Role`                      | Yes                                              | `cdk-hnb659fds-image-publishing-role-<acct>-us-east-1`                | See the IAM role row below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **BootstrapAndPlatformRoles**                                                                                |
| `LookupRole` (418)                                           | `AWS::IAM::Role`                      | Yes                                              | `cdk-hnb659fds-lookup-role-<acct>-us-east-1`                          | See the IAM role row below, plus iam:AttachRolePolicy for `ReadOnlyAccess` and iam:PutRolePolicy for `LookupRolePolicy`                                                                                                                                                                                                                                                                                                                                                                                             | **BootstrapAndPlatformRoles**                                                                                |
| `DeploymentActionRole` (575)                                 | `AWS::IAM::Role`                      | Yes                                              | `cdk-hnb659fds-deploy-role-<acct>-us-east-1`                          | See the IAM role row below, plus iam:AttachRolePolicy for `AWSCloudFormationReadOnlyAccess` and iam:PutRolePolicy for `default`                                                                                                                                                                                                                                                                                                                                                                                     | **BootstrapAndPlatformRoles**                                                                                |
| `CloudFormationExecutionRole` (718)                          | `AWS::IAM::Role`                      | Yes                                              | `cdk-hnb659fds-cfn-exec-role-<acct>-us-east-1`                        | See the IAM role row below, plus iam:CreateRole with `PermissionsBoundary` (later changes use iam:PutRolePermissionsBoundary) and iam:AttachRolePolicy for `AdministratorAccess`                                                                                                                                                                                                                                                                                                                                    | **BootstrapAndPlatformRoles** (no `iam:PermissionsBoundary` or `iam:PolicyARN` condition in the user policy) |
| _IAM role handler, all five roles_                           | `AWS::IAM::Role`                      |                                                  |                                                                       | iam:CreateRole, GetRole, PutRolePolicy, GetRolePolicy, AttachRolePolicy, TagRole, UntagRole / UpdateRole, UpdateAssumeRolePolicy, PutRolePolicy, DeleteRolePolicy, AttachRolePolicy, DetachRolePolicy, PutRolePermissionsBoundary, TagRole, UntagRole, _UpdateRoleDescription_, _DeleteRolePermissionsBoundary_ / DeleteRole, DeleteRolePolicy, DetachRolePolicy, GetRole, ListAttachedRolePolicies, ListRolePolicies, TagRole, UntagRole. Read: GetRole, GetRolePolicy, ListAttachedRolePolicies, ListRolePolicies | **BootstrapAndPlatformRoles** (`role/cdk-*`), except the two actions in italics                              |
| `FilePublishingRoleDefaultPolicy` (510)                      | `AWS::IAM::Policy` (inline on a role) | Yes                                              | `cdk-hnb659fds-file-publishing-role-default-policy-<acct>-us-east-1`  | iam:PutRolePolicy, GetRolePolicy / + DeleteRolePolicy / iam:DeleteRolePolicy. The handler's User and Group variants are not used.                                                                                                                                                                                                                                                                                                                                                                                   | **BootstrapAndPlatformRoles**                                                                                |
| `ImagePublishingRoleDefaultPolicy` (548)                     | `AWS::IAM::Policy` (inline on a role) | Yes                                              | `cdk-hnb659fds-image-publishing-role-default-policy-<acct>-us-east-1` | Same as the previous row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **BootstrapAndPlatformRoles**                                                                                |
| `CdkBoostrapPermissionsBoundaryPolicy` (745)                 | `AWS::IAM::ManagedPolicy`             | **No**: `UseExamplePermissionsBoundary` is false | `cdk-hnb659fds-permissions-boundary-<acct>-us-east-1`                 | iam:CreatePolicy, AttachRolePolicy / CreatePolicyVersion, DeletePolicyVersion, ... / DeletePolicy                                                                                                                                                                                                                                                                                                                                                                                                                   | Not granted on `policy/cdk-*`, and not needed                                                                |
| `CdkBootstrapVersion` (802)                                  | `AWS::SSM::Parameter`                 | Yes                                              | `/cdk-bootstrap/hnb659fds/version`                                    | ssm:PutParameter, AddTagsToResource, GetParameters / + _RemoveTagsFromResource_ / ssm:DeleteParameter. Read: GetParameters, ListTagsForResource                                                                                                                                                                                                                                                                                                                                                                     | **CdkBootstrapVersionParameter** (`parameter/cdk-bootstrap/*`), except the action in italics                 |
| Output export `CdkBootstrap-hnb659fds-FileAssetKeyArn` (822) | stack output                          | Yes                                              | n/a                                                                   | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | n/a                                                                                                          |

Some actions appear in a handler's list but are not reached, because the template never sets the
property that needs them:

- S3 `iam:PassRole`: only for replication.
- S3 `s3tables:*`: only for metadata table configuration.
- ECR `kms:CreateGrant`, `kms:DescribeKey`, `kms:RetireGrant`: only for a KMS-encrypted repository.
  The template uses the default AES256.

**Tags.** `--tags project=foundry-ascent` sets stack tags, and CloudFormation copies them to every
resource that supports tags. That uses s3:PutBucketTagging and s3:TagResource, ecr:TagResource,
iam:TagRole and ssm:AddTagsToResource, all covered above. The two inline `AWS::IAM::Policy`
resources cannot be tagged.

**Import of existing resources.** The CLI creates the change set with
`ImportExistingResources: true` (112285, 110232). If a retained bucket or other named resource from
an earlier `CDKToolkit` still exists, CloudFormation adopts it through the read handlers listed
above. Those are covered by the same Sids.

## Calls made by the CDK CLI itself

| Call                                                                  | When                                                                                                                                                                                                                                 | `lib/index.js` line  | Covered by Sid                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------ |
| `sts:GetCallerIdentity`                                               | Resolve account and partition (`BootstrapStack.partition()` 112216)                                                                                                                                                                  | 285293               | **Identity**                                     |
| `cloudformation:DescribeStacks`                                       | Look up the existing `CDKToolkit`, wait for completion                                                                                                                                                                               | 93994, 95575, 110368 | **CloudFormationRead**, **CdkAndPlatformStacks** |
| `cloudformation:GetTemplate`                                          | Check whether a re-run has no changes (`canSkipDeploy`)                                                                                                                                                                              | 94029                | **CloudFormationRead**                           |
| `cloudformation:DeleteChangeSet`                                      | Remove a stale or empty change set                                                                                                                                                                                                   | 110125, 110252       | **CdkAndPlatformStacks**                         |
| `cloudformation:CreateChangeSet`                                      | CREATE or UPDATE change set. The template is sent inline as `TemplateBody` (about 38 KB, under the 50 KB limit at 92955), so nothing is uploaded to S3 first. Uses `CAPABILITY_NAMED_IAM`, stack tags and `ImportExistingResources`. | 110225               | **CdkAndPlatformStacks** (`stack/CDKToolkit/*`)  |
| `cloudformation:DescribeChangeSet`                                    | Wait for the change set and read it                                                                                                                                                                                                  | 92123, 92163         | **CloudFormationRead**                           |
| `cloudformation:UpdateTerminationProtection`                          | `--termination-protection`                                                                                                                                                                                                           | 110275               | **CdkAndPlatformStacks**                         |
| `cloudformation:ExecuteChangeSet`                                     | Deploy                                                                                                                                                                                                                               | 110205               | **CdkAndPlatformStacks**                         |
| `cloudformation:DescribeStackEvents`, `cloudformation:DescribeEvents` | Progress monitor, failure diagnosis                                                                                                                                                                                                  | 93494, 94346         | **CloudFormationRead**                           |
| `iam:GetPolicy`, `iam:CreatePolicy`                                   | Only with `--example-permissions-boundary` (112585). **Not called here.**                                                                                                                                                            | 112590, 112648       | n/a                                              |

The CLI makes no S3, ECR or SSM calls during `bootstrap`: no assets are published and the template
is sent inline.

## Other AWS calls in the workflow

| Step                                                | Calls                                                                                                                                                                                                                                               | Covered by Sid                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ops/aws/upsert_policy.py` (FoundryAscent-Boundary) | sts:GetCallerIdentity. On `policy/FoundryAscent-Boundary`: iam:GetPolicy, iam:CreatePolicy, iam:TagPolicy (tag-on-create, and adding a missing tag), iam:GetPolicyVersion, iam:ListPolicyVersions, iam:DeletePolicyVersion, iam:CreatePolicyVersion | **Identity**, **PlatformManagedPolicies** |
| Resolve account ID                                  | sts:GetCallerIdentity                                                                                                                                                                                                                               | **Identity**                              |
| CDKToolkit status                                   | cloudformation:DescribeStacks, cloudformation:DescribeStackEvents                                                                                                                                                                                   | **CloudFormationRead**                    |

## Not covered

None of these actions runs in this workflow, whether on the first run, an unchanged re-run, or a
rollback. They become relevant only if the inputs change as described.

| Action                                                                                             | Resource                    | Needed when                                                                                           | Notes                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `iam:UpdateRoleDescription`                                                                        | `role/cdk-*`                | A future bootstrap template adds or changes a `Description` on a bootstrap role                       | No role in template v32 has a description                                                                                          |
| `ssm:RemoveTagsFromResource`                                                                       | `parameter/cdk-bootstrap/*` | A stack tag key is removed or renamed in a later bootstrap (stack tags are copied to the parameter)   | Changing a tag value uses ssm:AddTagsToResource, which is granted                                                                  |
| `iam:DeleteRolePermissionsBoundary`                                                                | `role/cdk-*`                | The boundary is removed from the execution role                                                       | Intentionally not granted, and the boundary forbids it. A re-run without `--custom-permissions-boundary` keeps the previous value. |
| `kms:CreateKey`, `kms:PutKeyPolicy`, `kms:TagResource`, `kms:EnableKeyRotation`, `kms:CreateAlias` | `*`                         | `--bootstrap-customer-key`, or `--no-previous-parameters` without `--bootstrap-kms-key-id`            | Intentionally not granted: $1/month per key, and the boundary's `CostGuardrails` denies `kms:CreateKey`                            |
| `iam:CreatePolicy` and the other policy actions                                                    | `policy/cdk-*`              | `--example-permissions-boundary`                                                                      | Not used. The project uses its own boundary.                                                                                       |
| `s3:ListAllMyBuckets`, `iam:ListRoles`, `ssm:DescribeParameters`, `ecr:DescribeRepositories`       | `*`                         | The handlers' `list` operations, used only by the IaC generator and resource scans, never by a deploy | Until it is detached, `legacy-cleanup.json` (InventoryRead) also grants these                                                      |

## Observations (not policy coverage)

1. **Only the execution role carries the boundary.** `--custom-permissions-boundary` applies only to
   `cdk-hnb659fds-cfn-exec-role` (template 740-744). The deploy, file-publishing, image-publishing
   and lookup roles are created without it, so the README's "every platform role" holds only for
   roles created by CloudFormation deployments.

   The execution role's boundary denies `iam:CreateRole` unless the new role also carries
   `FoundryAscent-Boundary`. The CDK app must therefore set the boundary on every role it creates:
   put `"@aws-cdk/core:permissionsBoundary": {"name": "FoundryAscent-Boundary"}` in the `context` of
   `cdk.json`, or call `PermissionsBoundary.of(app).apply(...)`. Without it, any stack that creates a
   role, including custom-resource provider roles, fails with AccessDenied.

2. **The stage-0 user is effectively an administrator.** `BootstrapAndPlatformRoles` allows
   `iam:CreateRole` and `iam:AttachRolePolicy` on `role/cdk-*` and `role/FoundryAscent*` with no
   `iam:PermissionsBoundary` or `iam:PolicyARN` condition, and `AssumeCdkRoles` allows
   `sts:AssumeRole` on `role/cdk-*`. The access key can therefore create and assume a role with
   AdministratorAccess. The user can also publish new versions of `FoundryAscent-Boundary`, which
   `upsert_policy.py` needs.

   There is a second, one-call path. `PlatformManagedPolicies` allows `iam:CreatePolicyVersion`,
   `iam:SetDefaultPolicyVersion` and `iam:DeletePolicyVersion` on `policy/FoundryAscent*`, and that
   pattern also matches the user's own policies, `FoundryAscent-BootstrapOperator` and
   `FoundryAscent-LegacyCleanup`. The key can therefore publish a new default version of its own policy
   with `"Action": "*"`. `upsert_policy.py` refuses those two names, but that does not bind someone who
   holds the key. Recommended policy change, for the account owner to decide (it requires re-running
   `infra/iam/apply-bootstrap-access.sh`): set the `PlatformManagedPolicies` resource to
   `arn:aws:iam::*:policy/FoundryAscent-Boundary`, the only managed policy the workflows manage and the
   only one `required-actions.json` checks. Add other platform policy names explicitly when they are
   introduced, and never use a prefix that matches the two operator policies.

   Treat the key as admin-equivalent until it is retired in stage 1 (GitHub OIDC). No policy was
   changed here.

3. **What `cdk deploy` can do.** Deployments run through the deploy role and the execution role, with
   AdministratorAccess ∩ FoundryAscent-Boundary. The stage-0 user reaches those roles through
   `AssumeCdkRoles`, which includes `sts:TagSession`. The deploy role reads
   `/cdk-bootstrap/hnb659fds/version` through its own `ReadVersion` statement.
4. **`legacy-cleanup.json` does not protect platform resources.** `LegacyResourceDeletion` allows every
   delete action on `*`. Its only Deny covers `user/Foundry-Ascent`. IAM therefore allows deleting
   `cdk-*` and `FoundryAscent*` roles, `FoundryAscent-Boundary`, the GitHub OIDC provider,
   `/cdk-bootstrap/*` and `/foundry-ascent/*` parameters, `foundry-ascent/*` secrets, `cdk-*` and
   `foundry-ascent-*` buckets, `cdk-*` ECR repositories, the default VPC and the `FoundryAscent*`
   stacks. Termination protection is the only thing protecting `CDKToolkit`. `ops/aws/cleanup.py`
   enforces the protections in code in two layers: each step's own filter, then a guard in
   `Mutator.call()` that re-checks every target. It also refuses all changes in a region whose
   protected stacks cannot be listed. Recommended policy change, for the account owner to decide
   before running the cleanup with `--mode apply`: add an explicit Deny statement to
   `legacy-cleanup.json` that covers this protected set. No policy was changed here.
5. **`required-actions.json` follows the detach.** The legacy inventory and cleanup entries carry
   `"policy": "FoundryAscent-LegacyCleanup"`. `verify_access.py` checks them only while
   `iam:ListAttachedUserPolicies` shows that policy attached to `Foundry-Ascent`, so the
   **Ops - verify AWS access** workflow stays green after the planned detach.
