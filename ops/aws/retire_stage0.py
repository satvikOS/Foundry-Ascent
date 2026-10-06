"""Retire the stage-0 CI identity (IAM user ``Foundry-Ascent``) once deploys run through GitHub OIDC.

    python ops/aws/retire_stage0.py --mode plan
    python ops/aws/retire_stage0.py --mode detach-legacy-cleanup
    python ops/aws/retire_stage0.py --mode retire --deploy-role-arn "$AWS_DEPLOY_ROLE_ARN"

Run by the **Ops - retire stage-0 AWS access** workflow (.github/workflows/ops-aws-retire-stage0.yml) with
the stage-0 access key, or locally with it. Modes:

  plan                   Read-only. Lists the user's managed and inline policies, its access keys (only the
                         last four characters of each id) and whether it has a console password, and prints
                         what the other modes would change.
  detach-legacy-cleanup  Detaches FoundryAscent-LegacyCleanup (the legacy cleanup is closed).
  retire                 Detaches FoundryAscent-LegacyCleanup and FoundryAscent-BootstrapOperator and deletes
                         EVERY access key of the user, the key running this script last. Refused unless
                         --deploy-role-arn names the stage-1 role FoundryAscent-GitHubDeploy and that role
                         exists (stage 1 works), and unless the caller is the user itself.

Why the order matters: the managed policies are what allow the user to detach policies and delete keys. The
account owner's apply-bootstrap-access.sh also puts the inline policy FoundryAscent-SelfRetirement
(infra/iam/policies/self-retirement.json: list, detach and delete-key on this user only), which outlives the
managed policies, so the last key can be deleted after both are detached. Without that inline policy the
script deletes the last key but leaves FoundryAscent-BootstrapOperator attached to a user that then has no
credentials, and says so: the owner detaches it in CloudShell.

IAM actions (all on user/Foundry-Ascent unless noted): sts:GetCallerIdentity, iam:ListAttachedUserPolicies,
iam:ListUserPolicies, iam:ListAccessKeys, iam:GetLoginProfile, iam:GetRole (role/FoundryAscent-GitHubDeploy),
iam:DetachUserPolicy, iam:DeleteAccessKey. Every one is in infra/iam/required-actions.json.

Safe for public GitHub Actions logs: the account id is registered with the log masker before anything else is
printed, and every printed line goes through ``redact`` (runs of 6+ digits become ``***``). Access key ids are
shown as their last four characters only. Dependencies: boto3 (ops/aws/requirements.txt). Python 3.12+.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

USER_NAME = "Foundry-Ascent"
OPERATOR_POLICY = "FoundryAscent-BootstrapOperator"
LEGACY_POLICY = "FoundryAscent-LegacyCleanup"
SELF_RETIREMENT_POLICY = "FoundryAscent-SelfRetirement"  # inline, put by the account owner
DEPLOY_ROLE_NAME = "FoundryAscent-GitHubDeploy"
DEPLOY_ROLE_ARN_RE = re.compile(rf"arn:aws:iam::(\d{{12}}):role/{DEPLOY_ROLE_NAME}", re.ASCII)
USER_ARN_RE = re.compile(r"arn:aws:iam::(\d{12}):user/(?:[^:]*/)?([\w+=,.@-]+)", re.ASCII)
MODES = ("plan", "detach-legacy-cleanup", "retire")
ACCOUNT_ID_RE = re.compile(r"\d{6,}")
IN_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"
CFG = Config(retries={"max_attempts": 6, "mode": "adaptive"}, connect_timeout=10, read_timeout=30)


def redact(text: object) -> str:
    return ACCOUNT_ID_RE.sub("***", str(text))


def say(line: str) -> None:
    print(redact(line), flush=True)


def key_label(key_id: str) -> str:
    return f"…{key_id[-4:]}" if len(key_id) > 4 else "…"


def describe_error(exc: BaseException) -> str:
    if isinstance(exc, ClientError):
        err = exc.response.get("Error", {})
        return redact(f"{err.get('Code', 'ClientError')}: {' '.join(str(err.get('Message', '')).split())[:160]}")
    return type(exc).__name__


class Refused(Exception):
    """A precondition does not hold; nothing was changed by the step that raised it."""


@dataclass
class State:
    account: str
    managed: list[str]  # managed policy names attached to the user
    inline: list[str]  # inline policy names
    keys: list[str]  # access key ids
    console_password: bool
    current_key: str | None


@dataclass
class Outcome:
    done: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def caller_account(sts: Any) -> str:
    """Account id of the caller; refuses unless the caller is the IAM user Foundry-Ascent itself."""
    ident = sts.get_caller_identity()
    account = str(ident["Account"])
    if IN_GITHUB:
        print(f"::add-mask::{account}", flush=True)
    match = USER_ARN_RE.fullmatch(str(ident.get("Arn", "")))
    if not match or match[2] != USER_NAME:
        raise Refused(f"the caller must be the IAM user {USER_NAME} (the stage-0 access key), not {redact(ident.get('Arn'))}")
    return account


def read_state(iam: Any, account: str, current_key: str | None) -> State:
    managed = [
        p["PolicyName"]
        for page in iam.get_paginator("list_attached_user_policies").paginate(UserName=USER_NAME)
        for p in page.get("AttachedPolicies", [])
    ]
    inline = [
        name
        for page in iam.get_paginator("list_user_policies").paginate(UserName=USER_NAME)
        for name in page.get("PolicyNames", [])
    ]
    keys = [
        k["AccessKeyId"]
        for page in iam.get_paginator("list_access_keys").paginate(UserName=USER_NAME)
        for k in page.get("AccessKeyMetadata", [])
    ]
    try:
        iam.get_login_profile(UserName=USER_NAME)
        console_password = True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "NoSuchEntity":
            raise
        console_password = False
    return State(account, managed, inline, keys, console_password, current_key)


def policy_arn(account: str, name: str) -> str:
    return f"arn:aws:iam::{account}:policy/{name}"


def plan_lines(state: State) -> list[str]:
    lines = [
        f"User {USER_NAME}",
        f"  managed policies: {', '.join(sorted(state.managed)) or 'none'}",
        f"  inline policies:  {', '.join(sorted(state.inline)) or 'none'}",
        "  access keys:      "
        + (", ".join(key_label(k) + (" (this job)" if k == state.current_key else "") for k in state.keys) or "none"),
        f"  console password: {'yes' if state.console_password else 'no'}",
        "",
        "detach-legacy-cleanup would: "
        + (f"detach {LEGACY_POLICY}" if LEGACY_POLICY in state.managed else f"nothing ({LEGACY_POLICY} is not attached)"),
        "retire would: "
        + "; ".join(
            [
                *(f"detach {name}" for name in (LEGACY_POLICY, OPERATOR_POLICY) if name in state.managed),
                f"delete {len(state.keys)} access key(s), this job's key last",
            ]
        ),
    ]
    if SELF_RETIREMENT_POLICY not in state.inline:
        lines.append(
            f"  note: the inline policy {SELF_RETIREMENT_POLICY} is missing, so retire keeps {OPERATOR_POLICY} attached "
            "(to a user without keys); run infra/iam/apply-bootstrap-access.sh first to add it"
        )
    if state.console_password:
        lines.append(
            "  note: the user has a console password; the account owner should delete it "
            f"(aws iam delete-login-profile --user-name {USER_NAME})"
        )
    return lines


def detach(iam: Any, state: State, name: str, outcome: Outcome) -> None:
    if name not in state.managed:
        outcome.done.append(f"{name}: not attached")
        return
    iam.detach_user_policy(UserName=USER_NAME, PolicyArn=policy_arn(state.account, name))
    state.managed.remove(name)
    outcome.done.append(f"detached {name}")


def delete_key(iam: Any, state: State, key_id: str, outcome: Outcome) -> None:
    iam.delete_access_key(UserName=USER_NAME, AccessKeyId=key_id)
    state.keys.remove(key_id)
    outcome.done.append(f"deleted access key {key_label(key_id)}")


def normalize_deploy_role(value: str) -> str:
    """The role ARN as pasted into GitHub: whitespace and quotes dropped (an ARN contains neither), and a bare
    12-digit account id expanded to the ARN of role FoundryAscent-GitHubDeploy (same rule as deploy.yml)."""
    cleaned = re.sub(r"[\s\"']", "", value)
    if re.fullmatch(r"\d{12}", cleaned):
        return f"arn:aws:iam::{cleaned}:role/{DEPLOY_ROLE_NAME}"
    return cleaned


def check_deploy_role(iam: Any, account: str, deploy_role_arn: str) -> None:
    match = DEPLOY_ROLE_ARN_RE.fullmatch(normalize_deploy_role(deploy_role_arn))
    if not match:
        raise Refused(f"--deploy-role-arn must be the ARN of role {DEPLOY_ROLE_NAME} (repository secret or variable AWS_DEPLOY_ROLE_ARN)")
    if match[1] != account:
        raise Refused("--deploy-role-arn belongs to another AWS account")
    try:
        iam.get_role(RoleName=DEPLOY_ROLE_NAME)
    except ClientError as exc:
        raise Refused(f"role {DEPLOY_ROLE_NAME} cannot be read ({describe_error(exc)}); deploy once through OIDC first") from exc


def retire(iam: Any, state: State, deploy_role_arn: str) -> Outcome:
    """Detach both stage-0 policies and delete every access key, the caller's own key last."""
    check_deploy_role(iam, state.account, deploy_role_arn)
    current = state.current_key
    if not current or current not in state.keys:
        raise Refused("the access key running this job is not one of the user's keys (AWS_ACCESS_KEY_ID)")
    outcome = Outcome()
    for key_id in [k for k in state.keys if k != current]:
        delete_key(iam, state, key_id, outcome)
    detach(iam, state, LEGACY_POLICY, outcome)
    if SELF_RETIREMENT_POLICY in state.inline:
        # The inline policy keeps iam:DeleteAccessKey once the managed policies are gone.
        detach(iam, state, OPERATOR_POLICY, outcome)
        delete_key(iam, state, current, outcome)
    else:
        # Without it, detaching the operator policy first would leave this key undeletable. Delete the key:
        # a policy attached to a user without credentials grants nothing to anyone.
        delete_key(iam, state, current, outcome)
        if OPERATOR_POLICY in state.managed:
            outcome.warnings.append(
                f"{OPERATOR_POLICY} is still attached to {USER_NAME}, which now has no access keys. The account owner "
                f"detaches it in CloudShell: aws iam detach-user-policy --user-name {USER_NAME} --policy-arn "
                f"arn:aws:iam::<account>:policy/{OPERATOR_POLICY}"
            )
    if state.console_password:
        outcome.warnings.append(
            f"{USER_NAME} still has a console password; the account owner deletes it "
            f"(aws iam delete-login-profile --user-name {USER_NAME}) or deletes the user"
        )
    outcome.warnings.append(
        "Delete the repository secrets AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (Settings → Secrets and variables → Actions)."
    )
    return outcome


def run(mode: str, sts: Any, iam: Any, current_key: str | None, deploy_role_arn: str) -> int:
    if mode not in MODES:
        raise Refused(f"unknown mode {mode!r}")
    account = caller_account(sts)
    state = read_state(iam, account, current_key)
    for line in plan_lines(state):
        say(line)
    if mode == "plan":
        say("\nplan: nothing changed")
        return 0
    if mode == "detach-legacy-cleanup":
        outcome = Outcome()
        detach(iam, state, LEGACY_POLICY, outcome)
    else:
        outcome = retire(iam, state, deploy_role_arn)
    say("")
    for line in outcome.done:
        say(f"{mode}: {line}")
    for line in outcome.warnings:
        say(f"::warning::{line}" if IN_GITHUB else f"WARNING: {line}")
    return 0


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Retire the stage-0 IAM user Foundry-Ascent (see the module docstring).")
    parser.add_argument("--mode", choices=MODES, default="plan")
    parser.add_argument("--deploy-role-arn", default="", help="stage-1 role ARN (repository secret or variable AWS_DEPLOY_ROLE_ARN); required for retire")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    session = boto3.Session(region_name=os.environ.get("AWS_REGION") or "us-east-1")
    try:
        return run(
            args.mode,
            session.client("sts", config=CFG),
            session.client("iam", config=CFG),
            os.environ.get("AWS_ACCESS_KEY_ID"),
            args.deploy_role_arn,
        )
    except Refused as exc:
        say(f"::error::Refused: {exc}" if IN_GITHUB else f"Refused: {exc}")
        return 2
    except (ClientError, BotoCoreError) as exc:
        say(f"::error::{describe_error(exc)}" if IN_GITHUB else f"ERROR: {describe_error(exc)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
