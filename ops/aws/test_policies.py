"""Offline checks of the IAM policy files against the required-actions manifest and the workflows (no AWS).

A small evaluator (Allow/Deny, Action/Resource wildcards ``*`` and ``?``, explicit deny wins) decides each
manifest pair against the policy documents. Statements with a ``Condition`` are ignored: for an Allow that
is conservative, and the must-be-denied checks then hold without relying on any condition.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path
from typing import Any

import pytest

import verify_access as v

REPO = Path(__file__).resolve().parents[2]
POLICIES = REPO / "infra" / "iam" / "policies"
WORKFLOWS = REPO / ".github" / "workflows"
ACCOUNT = "123456789012"
REGION = "us-east-1"
MAX_POLICY_CHARS = 6144  # IAM managed policy limit, whitespace excluded
INLINE_MAX_CHARS = 2048  # IAM user inline policies, all together

CDK_ROLES = ("deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role")
# IAM verbs that change identities, policies or credentials.
IAM_MUTATION = re.compile(r"^iam:(Add|Attach|Change|Create|Delete|Detach|Pass|Put|Remove|Reset|Set|Tag|Untag|Update|Upload)", re.IGNORECASE)
# The only mutations the stage-0 identity keeps: retiring itself.
SELF_RETIREMENT = {"iam:detachuserpolicy", "iam:deleteaccesskey"}
STAGE0_USER = "arn:aws:iam::*:user/Foundry-Ascent"


def load(name: str) -> dict[str, Any]:
    return json.loads((POLICIES / name).read_text(encoding="utf-8"))


def as_list(value: Any) -> list[str]:
    return [value] if isinstance(value, str) else list(value)


@cache
def pattern(text: str, ignore_case: bool) -> re.Pattern[str]:
    regex = "".join(".*" if ch == "*" else "." if ch == "?" else re.escape(ch) for ch in text)
    return re.compile(regex, re.IGNORECASE | re.DOTALL if ignore_case else re.DOTALL)


def matches(patterns: list[str], value: str, ignore_case: bool) -> bool:
    return any(pattern(p, ignore_case).fullmatch(value) for p in patterns)


def statement_applies(st: dict[str, Any], action: str, resource: str) -> bool:
    if "Condition" in st:
        return False
    if "Action" in st:
        hit = matches(as_list(st["Action"]), action, True)
    else:
        hit = not matches(as_list(st["NotAction"]), action, True)
    if not hit:
        return False
    if "Resource" in st:
        return matches(as_list(st["Resource"]), resource, False)
    return not matches(as_list(st["NotResource"]), resource, False)


def decide(docs: list[dict[str, Any]], action: str, resource: str) -> str:
    statements = [st for doc in docs for st in doc["Statement"]]
    if any(st["Effect"] == "Deny" and statement_applies(st, action, resource) for st in statements):
        return "explicitDeny"
    if any(st["Effect"] == "Allow" and statement_applies(st, action, resource) for st in statements):
        return "allowed"
    return "implicitDeny"


def operator() -> dict[str, Any]:
    return load("bootstrap-operator.json")


def legacy() -> dict[str, Any]:
    return load("legacy-cleanup.json")


def self_retirement() -> dict[str, Any]:
    return load("self-retirement.json")


def manifest() -> list[v.Entry]:
    return v.load_manifest()


def pairs(entry: v.Entry) -> list[tuple[str, str]]:
    return [(a, v.render(r, ACCOUNT, REGION)) for a in entry.actions for r in entry.resources]


# --------------------------------------------------------------------------- documents


@pytest.mark.parametrize("name", sorted(p.name for p in POLICIES.glob("*.json")))
def test_policy_documents_are_valid_and_within_the_iam_size_limit(name: str) -> None:
    doc = load(name)
    assert doc["Version"] == "2012-10-17"
    sids = [st.get("Sid") for st in doc["Statement"]]
    assert all(sids) and len(set(sids)) == len(sids), "every statement has a unique Sid"
    for st in doc["Statement"]:
        assert st["Effect"] in {"Allow", "Deny"}
        assert ("Action" in st) != ("NotAction" in st)
        assert ("Resource" in st) != ("NotResource" in st)
    size = len(re.sub(r"\s", "", json.dumps(doc, separators=(",", ":"))))
    limit = INLINE_MAX_CHARS if name == "self-retirement.json" else MAX_POLICY_CHARS
    assert size < limit, f"{name}: {size} characters without whitespace"


def test_policies_contain_no_account_ids() -> None:
    for path in [*POLICIES.glob("*.json"), REPO / "infra" / "iam" / "required-actions.json"]:
        # 12-digit runs, except the all-zero stack-id group of the manifest's example stack ARNs.
        assert not re.search(r"(?<![\d-])\d{12}(?!\d)", path.read_text(encoding="utf-8")), path.name


# --------------------------------------------------------------------------- stage-0 operator policy


def test_operator_policy_grants_no_iam_mutation_beyond_self_retirement() -> None:
    for st in operator()["Statement"]:
        if st["Effect"] != "Allow":
            continue
        assert "NotAction" not in st and "NotResource" not in st
        for action in as_list(st["Action"]):
            assert action != "*" and not action.lower().startswith("iam:*"), action
            assert not action.lower().startswith("sts:*"), action
            if IAM_MUTATION.match(action):
                assert action.lower() in SELF_RETIREMENT, f"IAM mutation {action} in {st['Sid']}"
                assert as_list(st["Resource"]) == [STAGE0_USER], st["Sid"]


@pytest.mark.parametrize(
    "action",
    [
        "iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:PassRole", "iam:TagRole",
        "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:CreateAccessKey", "iam:AttachUserPolicy",
        "iam:PutUserPolicy", "iam:CreateOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint",
        "cloudformation:CreateChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteStack",
        "cloudformation:UpdateStack", "s3:PutObject", "ssm:PutParameter", "ecr:SetRepositoryPolicy",
        "budgets:ModifyBudget",
    ],
)
@pytest.mark.parametrize(
    "resource",
    [
        f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-deploy-role-{ACCOUNT}-{REGION}",
        f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-{ACCOUNT}-{REGION}",
        f"arn:aws:iam::{ACCOUNT}:role/FoundryAscent-GitHubDeploy",
        f"arn:aws:iam::{ACCOUNT}:policy/FoundryAscent-Boundary",
        f"arn:aws:iam::{ACCOUNT}:user/Foundry-Ascent",
        f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/CDKToolkit/x",
        f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/FoundryAscent-Data/x",
        "*",
    ],
)
def test_operator_cannot_escalate_or_change_the_platform(action: str, resource: str) -> None:
    for docs in ([operator()], [operator(), self_retirement()]):
        assert decide(docs, action, resource) != "allowed", (action, resource)
    # With the legacy cleanup policy attached too (it may delete resources that predate the platform, so only
    # platform resources of the action's own service are meaningful here).
    if resource != "*" and resource.split(":")[2] == action.split(":")[0]:
        assert decide([operator(), legacy(), self_retirement()], action, resource) != "allowed", (action, resource)


def test_operator_assumes_exactly_the_four_cdk_bootstrap_roles() -> None:
    st = next(s for s in operator()["Statement"] if "sts:AssumeRole" in as_list(s.get("Action", [])))
    assert sorted(as_list(st["Action"])) == ["sts:AssumeRole", "sts:TagSession"]
    assert len(as_list(st["Resource"])) == 4
    for kind in CDK_ROLES:
        assert decide([operator()], "sts:AssumeRole", f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-{kind}-{ACCOUNT}-{REGION}") == "allowed"
    for other in (
        f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-{ACCOUNT}-{REGION}",
        f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-deploy-role-{ACCOUNT}-{REGION}-copy",
        f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-deploy-role-{ACCOUNT}-us-west-2",
        f"arn:aws:iam::{ACCOUNT}:role/cdk-other-deploy-role-{ACCOUNT}-{REGION}",
        f"arn:aws:iam::{ACCOUNT}:role/FoundryAscent-GitHubDeploy",
        f"arn:aws:iam::{ACCOUNT}:role/Admin",
    ):
        assert decide([operator(), legacy()], "sts:AssumeRole", other) != "allowed", other


def test_self_retirement_inline_policy_only_touches_the_user_itself() -> None:
    for st in self_retirement()["Statement"]:
        assert st["Effect"] == "Allow"
        for action in as_list(st["Action"]):
            if action.startswith("iam:"):
                assert action.startswith(("iam:Get", "iam:List")) or action.lower() in SELF_RETIREMENT, action
                assert as_list(st["Resource"]) == [STAGE0_USER]
            else:
                assert action == "sts:GetCallerIdentity"


# --------------------------------------------------------------------------- manifest vs policies


def test_every_manifest_entry_matches_the_policies() -> None:
    problems: list[str] = []
    for entry in manifest():
        for action, resource in pairs(entry):
            if entry.expect == "denied":
                for docs in ([operator(), self_retirement()], [operator(), legacy(), self_retirement()]):
                    if decide(docs, action, resource) == "allowed":
                        problems.append(f"must be denied but allowed: {action} on {resource} ({entry.purpose})")
            else:
                docs = [operator(), legacy()] if entry.policy == "FoundryAscent-LegacyCleanup" else [operator()]
                if entry.required and decide(docs, action, resource) != "allowed":
                    problems.append(f"required but not allowed: {action} on {resource} ({entry.purpose})")
    assert problems == []


def test_retirement_keeps_working_after_the_managed_policies_are_detached() -> None:
    user = f"arn:aws:iam::{ACCOUNT}:user/Foundry-Ascent"
    for action in ("iam:DeleteAccessKey", "iam:DetachUserPolicy", "iam:ListAccessKeys", "iam:ListAttachedUserPolicies"):
        assert decide([self_retirement()], action, user) == "allowed"
        # Legacy cleanup never blocks it.
        assert decide([operator(), legacy()], action, user) == "allowed"


def test_legacy_cleanup_can_no_longer_delete_platform_resources() -> None:
    platform = [
        ("cloudformation:DeleteStack", f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/FoundryAscent-Data/x"),
        ("cloudformation:DeleteStack", f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/CDKToolkit/x"),
        ("rds:DeleteDBCluster", f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:foundry-ascent"),
        ("rds:ModifyDBCluster", f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:foundry-ascent"),
        ("secretsmanager:DeleteSecret", f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:foundry-ascent/aurora-admin-AbCdEf"),
        ("s3:DeleteObject", "arn:aws:s3:::foundryascent-data-documentsbucket-abc/tenants/t/doc.pdf"),
        ("s3:DeleteBucket", f"arn:aws:s3:::cdk-hnb659fds-assets-{ACCOUNT}-{REGION}"),
        ("iam:DeleteRole", f"arn:aws:iam::{ACCOUNT}:role/FoundryAscent-GitHubDeploy"),
        ("iam:DetachRolePolicy", f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-{ACCOUNT}-{REGION}"),
        ("iam:DeletePolicyVersion", f"arn:aws:iam::{ACCOUNT}:policy/FoundryAscent-Boundary"),
        ("iam:DeleteOpenIDConnectProvider", f"arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"),
        ("lambda:DeleteFunction", f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:FoundryAscent-Api"),
        ("sqs:DeleteQueue", f"arn:aws:sqs:{REGION}:{ACCOUNT}:FoundryAscent-Jobs"),
        ("logs:DeleteLogGroup", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/FoundryAscent-Api"),
        ("ssm:DeleteParameter", f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/cdk-bootstrap/hnb659fds/version"),
    ]
    for action, resource in platform:
        assert decide([operator(), legacy()], action, resource) == "explicitDeny", (action, resource)
    # It still removes resources that predate the platform.
    assert decide([legacy()], "rds:DeleteDBCluster", f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:old-project") == "allowed"
    assert decide([legacy()], "s3:DeleteBucket", "arn:aws:s3:::old-project-bucket") == "allowed"
    tag_deny = next(st for st in legacy()["Statement"] if st["Sid"] == "ProtectPlatformByTag")
    assert tag_deny["Effect"] == "Deny"
    assert tag_deny["Condition"] == {"StringEquals": {"aws:ResourceTag/project": "foundry-ascent"}}


# --------------------------------------------------------------------------- workflows


AWS_CLI = re.compile(r"\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)")
STAGE0_SECRET = "secrets.AWS_ACCESS_KEY_ID"


def workflow_aws_calls() -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            for service, command in AWS_CLI.findall(line):
                action = f"{service}:{command.replace('-', '')}"
                calls.append((path.name, action))
    return calls


def test_every_aws_cli_call_in_the_workflows_is_in_the_manifest_and_allowed() -> None:
    calls = workflow_aws_calls()
    assert ("deploy.yml", "cloudformation:describestacks") in calls
    assert ("deploy.yml", "iam:listopenidconnectproviders") in calls
    assert ("deploy.yml", "cloudformation:describestackresources") in calls
    entries = [e for e in manifest() if e.expect == "allowed" and e.policy is None]
    problems: list[str] = []
    for workflow, action in calls:
        relevant = [e for e in entries if action in {a.lower() for a in e.actions}]
        if not relevant:
            problems.append(f"{workflow}: {action} is not in infra/iam/required-actions.json")
            continue
        for entry in relevant:
            for resource in entry.resources:
                if decide([operator()], action, v.render(resource, ACCOUNT, REGION)) != "allowed":
                    problems.append(f"{workflow}: {action} on {resource} is not allowed by bootstrap-operator.json")
    assert problems == []


def test_no_workflow_bootstraps_cdk_or_publishes_iam_policies() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        assert "upsert_policy.py" not in text, path.name
        assert not re.search(r"\bbootstrap\s+\"?aws://", text), path.name
        assert not re.search(r"aws\s+iam\s+(create|put|attach|update)-", text), path.name


def test_stage0_workflows_mask_the_account_id_and_do_not_persist_git_credentials() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        if STAGE0_SECRET not in text:
            continue
        assert "persist-credentials: false" in text, path.name
        masks = "::add-mask::" in text or "mask-aws-account-id: true" in text
        python_masks = re.search(r"python ops/aws/(verify_access|cleanup|inventory|retire_stage0)\.py", text)
        assert masks or python_masks, f"{path.name} must mask the account id"


# --------------------------------------------------------------------------- permissions boundary


def test_boundary_blocks_escalation_through_cloudformation_to_the_stage0_user() -> None:
    """A template deployed through the CDK execution role (which carries the boundary) cannot grant the CI
    user more permissions or rewrite the policies the account owner publishes."""
    boundary = [load("permissions-boundary.json")]
    user = f"arn:aws:iam::{ACCOUNT}:user/Foundry-Ascent"
    for action in ("iam:AttachUserPolicy", "iam:PutUserPolicy", "iam:AddUserToGroup", "iam:UpdateAccessKey",
                   "iam:CreateAccessKey", "iam:CreateLoginProfile"):
        assert decide(boundary, action, user) == "explicitDeny", action
    for name in ("FoundryAscent-Boundary", "FoundryAscent-BootstrapOperator", "FoundryAscent-LegacyCleanup"):
        arn = f"arn:aws:iam::{ACCOUNT}:policy/{name}"
        for action in ("iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy"):
            assert decide(boundary, action, arn) == "explicitDeny", (action, name)
    # The Data stack's own managed policies (CloudFormation-generated names) stay updatable.
    data_policy = f"arn:aws:iam::{ACCOUNT}:policy/FoundryAscent-Data-DatabaseAccessPolicy6F8810B6-AbCdEf"
    assert decide(boundary, "iam:CreatePolicyVersion", data_policy) == "allowed"
