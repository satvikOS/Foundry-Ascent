#!/usr/bin/env bash
# Account owner only: publishes the Foundry Ascent IAM policies and sets the access of the CI identity
# (IAM user "Foundry-Ascent", stage 0). The CI identity cannot do any of this itself: it has no IAM write
# permission (infra/iam/policies/bootstrap-operator.json, Sid NoIdentityChanges).
#
# Run as an account administrator in AWS CloudShell (region us-east-1):
#   git clone --depth 1 https://github.com/satvikOS/Foundry-Ascent && bash Foundry-Ascent/infra/iam/apply-bootstrap-access.sh
#
# What it does (idempotent; re-running publishes a new default version only where the document changed):
#   1. FoundryAscent-Boundary           permissions boundary of every platform role (published, not attached)
#   2. FoundryAscent-BootstrapOperator  post-bootstrap stage-0 policy: read-only, assume the four CDK
#                                       bootstrap roles, model smoke tests, FinOps reads, self-retirement.
#                                       Attached to the user.
#   3. FoundryAscent-SelfRetirement     inline policy on the user: list, detach and delete-key on itself
#                                       only, so the retire workflow can delete the last access key after
#                                       detaching the managed policies.
#   4. FoundryAscent-LegacyCleanup      the tightened version is published if the policy exists. It is
#                                       DETACHED unless --with-legacy-cleanup is given (only while a legacy
#                                       cleanup is still running; docs/runbooks/legacy-aws-cleanup.md).
#
# Options:
#   --with-legacy-cleanup   keep (or attach) FoundryAscent-LegacyCleanup
#   --user NAME             CI user name (default Foundry-Ascent)
set -euo pipefail

USER_NAME="Foundry-Ascent"
WITH_LEGACY=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-legacy-cleanup) WITH_LEGACY=true ;;
    --user)
      USER_NAME="$2"
      shift
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

POLICY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policies"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

policy_arn() { echo "arn:aws:iam::${ACCOUNT_ID}:policy/$1"; }

canonical() { python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))'; }

# Creates the managed policy, or publishes the file as its new default version when it differs.
upsert_policy() {
  local name="$1" file="$2" description="$3"
  local arn
  arn="$(policy_arn "${name}")"

  if aws iam get-policy --policy-arn "${arn}" >/dev/null 2>&1; then
    local default_version current wanted
    default_version="$(aws iam get-policy --policy-arn "${arn}" --query 'Policy.DefaultVersionId' --output text)"
    current="$(aws iam get-policy-version --policy-arn "${arn}" --version-id "${default_version}" \
      --query 'PolicyVersion.Document' --output json | canonical)"
    wanted="$(canonical <"${file}")"
    if [ "${current}" = "${wanted}" ]; then
      echo "unchanged ${name}"
      return
    fi
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
    echo "updated   ${name}"
  else
    aws iam create-policy --policy-name "${name}" --description "${description}" \
      --policy-document "file://${file}" \
      --tags Key=project,Value=foundry-ascent Key=managed-by,Value=infra-iam >/dev/null
    echo "created   ${name}"
  fi
}

is_attached() {
  aws iam list-attached-user-policies --user-name "${USER_NAME}" \
    --query "AttachedPolicies[?PolicyName=='$1'].PolicyName" --output text | grep -qx "$1"
}

upsert_policy "FoundryAscent-Boundary" "${POLICY_DIR}/permissions-boundary.json" \
  "Foundry Ascent permissions boundary for every platform role"

upsert_policy "FoundryAscent-BootstrapOperator" "${POLICY_DIR}/bootstrap-operator.json" \
  "Foundry Ascent CI (stage 0, after the CDK bootstrap): read-only, CDK bootstrap roles, model smoke tests, FinOps read, self-retirement"
aws iam attach-user-policy --user-name "${USER_NAME}" --policy-arn "$(policy_arn FoundryAscent-BootstrapOperator)"
echo "attached  FoundryAscent-BootstrapOperator -> ${USER_NAME}"

aws iam put-user-policy --user-name "${USER_NAME}" --policy-name FoundryAscent-SelfRetirement \
  --policy-document "file://${POLICY_DIR}/self-retirement.json"
echo "inline    FoundryAscent-SelfRetirement -> ${USER_NAME}"

legacy_arn="$(policy_arn FoundryAscent-LegacyCleanup)"
if [ "${WITH_LEGACY}" = true ] || aws iam get-policy --policy-arn "${legacy_arn}" >/dev/null 2>&1; then
  upsert_policy "FoundryAscent-LegacyCleanup" "${POLICY_DIR}/legacy-cleanup.json" \
    "Foundry Ascent CI: one-time inventory and removal of pre-existing billable resources (never platform resources)"
fi
if [ "${WITH_LEGACY}" = true ]; then
  aws iam attach-user-policy --user-name "${USER_NAME}" --policy-arn "${legacy_arn}"
  echo "attached  FoundryAscent-LegacyCleanup -> ${USER_NAME} (detach it when the legacy cleanup is closed)"
elif is_attached FoundryAscent-LegacyCleanup; then
  aws iam detach-user-policy --user-name "${USER_NAME}" --policy-arn "${legacy_arn}"
  echo "detached  FoundryAscent-LegacyCleanup from ${USER_NAME}"
fi

aws iam list-attached-user-policies --user-name "${USER_NAME}" --output table
aws iam list-user-policies --user-name "${USER_NAME}" --output table
