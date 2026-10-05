#!/usr/bin/env bash
# Account owner only: bootstraps (or re-bootstraps) CDK in us-east-1 (stack CDKToolkit).
#
# The CI identity cannot run this: it has no IAM, CloudFormation or S3 write permission of its own
# (infra/iam/policies/bootstrap-operator.json). Bootstrapping creates the cdk-hnb659fds-* roles, and a
# principal that can create or change those roles can grant itself administrator access, so only an account
# administrator bootstraps. Needed once, and again only when a new aws-cdk release requires a newer bootstrap
# template (cdk deploy then fails with a "bootstrap stack version" error).
#
# Run in AWS CloudShell (region us-east-1) after apply-bootstrap-access.sh has published the boundary:
#   git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/cdk-bootstrap.sh
#
# Flags verified against aws-cdk 2.1144.0 (docs/ops/cdk-bootstrap-permissions.md):
#   --custom-permissions-boundary  the CloudFormation execution role gets AdministratorAccess capped by
#                                  FoundryAscent-Boundary (the CDK-recommended pattern)
#   --bootstrap-kms-key-id AWS_MANAGED_KEY  never creates a customer KMS key ($1/month)
#   --termination-protection       CDKToolkit cannot be deleted by accident
# --no-previous-parameters is deliberately NOT passed: parameters that are not given would fall back to
# template defaults on re-runs.
set -euo pipefail

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ ! "${ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "sts:GetCallerIdentity did not return a 12-digit account id" >&2
  exit 1
fi
if ! aws iam get-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/FoundryAscent-Boundary" >/dev/null 2>&1; then
  echo "FoundryAscent-Boundary is not published: run infra/iam/apply-bootstrap-access.sh first" >&2
  exit 1
fi

CDK_DISABLE_CLI_TELEMETRY=true npx --yes aws-cdk@2.1144.0 bootstrap "aws://${ACCOUNT_ID}/us-east-1" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --custom-permissions-boundary FoundryAscent-Boundary \
  --bootstrap-kms-key-id AWS_MANAGED_KEY \
  --termination-protection \
  --tags project=foundry-ascent

aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query 'Stacks[0].{Status:StackStatus,TerminationProtection:EnableTerminationProtection}' --output table
