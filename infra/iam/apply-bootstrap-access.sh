#!/usr/bin/env bash
# Grants the CI identity (IAM user "Foundry-Ascent") the two bootstrap policies.
#
# Run once, as an account administrator, in AWS CloudShell:
#   git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/apply-bootstrap-access.sh
#
# Idempotent: re-running publishes a new default policy version and re-attaches.
set -euo pipefail

USER_NAME="${1:-Foundry-Ascent}"
POLICY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policies"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

upsert_and_attach() {
  local name="$1" file="$2" description="$3"
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/${name}"

  if aws iam get-policy --policy-arn "${arn}" >/dev/null 2>&1; then
    # IAM keeps at most five versions; drop the oldest non-default one first.
    local versions
    # shellcheck disable=SC2016 # backticks are a JMESPath literal, not a shell expansion
    versions="$(aws iam list-policy-versions --policy-arn "${arn}" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)"
    if [ "$(wc -w <<<"${versions}")" -ge 4 ]; then
      aws iam delete-policy-version --policy-arn "${arn}" \
        --version-id "$(tr -s '[:blank:]' '\n' <<<"${versions}" | sort -V | head -n 1)"
    fi
    aws iam create-policy-version --policy-arn "${arn}" \
      --policy-document "file://${file}" --set-as-default >/dev/null
    echo "updated  ${name}"
  else
    aws iam create-policy --policy-name "${name}" --description "${description}" \
      --policy-document "file://${file}" \
      --tags Key=project,Value=foundry-ascent Key=managed-by,Value=infra-iam >/dev/null
    echo "created  ${name}"
  fi

  aws iam attach-user-policy --user-name "${USER_NAME}" --policy-arn "${arn}"
  echo "attached ${name} -> ${USER_NAME}"
}

upsert_and_attach "FoundryAscent-BootstrapOperator" "${POLICY_DIR}/bootstrap-operator.json" \
  "Foundry Ascent CI: CDK bootstrap, GitHub OIDC setup, model smoke tests, FinOps read, self-retirement"
upsert_and_attach "FoundryAscent-LegacyCleanup" "${POLICY_DIR}/legacy-cleanup.json" \
  "Foundry Ascent CI: one-time inventory and removal of pre-existing billable resources"

aws iam list-attached-user-policies --user-name "${USER_NAME}" --output table
