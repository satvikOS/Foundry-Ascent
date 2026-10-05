"""Create or update a customer-managed IAM policy from a JSON file (idempotent).

    python ops/aws/upsert_policy.py --name FoundryAscent-Boundary \\
        --file infra/iam/policies/permissions-boundary.json \\
        --description "Foundry Ascent permissions boundary for every platform role"

Behaviour:
  * policy missing        -> iam:CreatePolicy, tagged project=foundry-ascent
  * document differs      -> iam:CreatePolicyVersion with SetAsDefault. IAM keeps at most five
                             versions, so when five exist the oldest non-default one is deleted first.
  * document unchanged    -> nothing is published
  * project tag missing   -> iam:TagPolicy
Documents are compared as normalized JSON, so key order and whitespace do not matter.

Permissions: account administrator only (for example in AWS CloudShell). The stage-0 CI user can no longer
publish policies: a principal that can rewrite the permissions boundary can lift it from every platform role,
so infra/iam/policies/bootstrap-operator.json denies all IAM writes (Sid NoIdentityChanges) and no workflow runs
this script. The administrator's usual path is infra/iam/apply-bootstrap-access.sh; this script remains for a
single policy. It refuses FoundryAscent-BootstrapOperator and FoundryAscent-LegacyCleanup, which only
apply-bootstrap-access.sh changes (it also attaches or detaches them).
IAM has no API to change a managed policy's description, so --description only applies on creation; a
difference is reported.

Dependencies: boto3 (see ops/aws/requirements.txt). Python 3.12+.
Safe for public GitHub Actions logs: the account ID is registered with the log masker before any
AWS-derived output is printed, and it is also redacted from every line this script prints.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from typing import Any, NoReturn, TypeVar

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

CFG = Config(retries={"max_attempts": 6, "mode": "adaptive"}, connect_timeout=10, read_timeout=30)
IN_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"
REQUIRED_TAGS = {"project": "foundry-ascent"}
MAX_VERSIONS = 5  # IAM limit of stored versions per managed policy
MAX_DOC_CHARS = 6144  # IAM managed policy size limit, whitespace excluded
NAME_RE = re.compile(r"[\w+=,.@-]{1,128}", re.ASCII)
DENIED = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}
# The stage-0 identity's own policies. Publishing a version of either from CI would let the identity
# rewrite its own permissions; they are changed only by an administrator (apply-bootstrap-access.sh).
OPERATOR_POLICIES = frozenset({"foundryascent-bootstrapoperator", "foundryascent-legacycleanup"})

T = TypeVar("T")


class Redactor:
    """Masks the account ID: GitHub log mask plus literal replacement in everything printed."""

    def __init__(self) -> None:
        self.account = ""

    def set(self, account: str) -> None:
        self.account = account
        if IN_GITHUB and account:
            print(f"::add-mask::{account}", flush=True)

    def __call__(self, text: object) -> str:
        out = str(text)
        return out.replace(self.account, "*" * len(self.account)) if self.account else out


redact = Redactor()


def fail(message: str, code: int = 1) -> NoReturn:
    line = redact(message)
    print(f"::error::{line}" if IN_GITHUB else f"ERROR: {line}", file=sys.stderr, flush=True)
    sys.exit(code)


def report(action: str, exc: Exception) -> NoReturn:
    """Turn an AWS error into one readable line naming the IAM action (never a traceback)."""
    if isinstance(exc, ClientError):
        err = exc.response.get("Error", {})
        code = err.get("Code", "ClientError")
        hint = ""
        if code in DENIED:
            hint = " (not granted to this identity: run this as an account administrator"
            hint += "; the stage-0 CI user has no IAM write permission)" if action.startswith("iam:") else ")"
        fail(f"{action}: {code}: {err.get('Message', '')}{hint}")
    fail(f"{action}: {type(exc).__name__}: {exc}")


def call(action: str, fn: Callable[[], T]) -> T:
    try:
        return fn()
    except (ClientError, BotoCoreError) as exc:
        report(action, exc)


def error_code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


def normalize(document: Any) -> str:
    """Canonical JSON. IAM returns documents URL-encoded; boto3 usually decodes them to a dict already."""
    if isinstance(document, str):
        document = json.loads(urllib.parse.unquote(document))
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def load_document(path: Path) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        fail(f"cannot read {path}: {exc.strerror}", code=2)
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"{path} is not valid JSON: line {exc.lineno} column {exc.colno}: {exc.msg}", code=2)
    if not isinstance(doc, dict) or "Statement" not in doc:
        fail(f"{path} is not an IAM policy document (no top-level Statement)", code=2)
    compact = json.dumps(doc, separators=(",", ":"))
    size = len(re.sub(r"\s", "", compact))
    if size > MAX_DOC_CHARS:
        fail(f"{path} is {size} characters without whitespace; IAM allows {MAX_DOC_CHARS}", code=2)
    return doc, compact


def append_summary(line: str) -> None:
    """Job summaries are not covered by ::add-mask::, so everything written here is redacted."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(redact(line) + "\n")
    except OSError:
        pass  # a missing summary must never fail the run


def get_policy(iam: Any, arn: str) -> dict[str, Any] | None:
    try:
        return iam.get_policy(PolicyArn=arn)["Policy"]
    except ClientError as exc:
        if error_code(exc) == "NoSuchEntity":
            return None
        report("iam:GetPolicy", exc)
    except BotoCoreError as exc:
        report("iam:GetPolicy", exc)


def create_policy(iam: Any, name: str, compact: str, description: str | None) -> dict[str, Any] | None:
    """Returns the new policy, or None when it already exists (created concurrently)."""
    kwargs: dict[str, Any] = {
        "PolicyName": name,
        "PolicyDocument": compact,
        "Tags": [{"Key": k, "Value": v} for k, v in REQUIRED_TAGS.items()],
    }
    if description:
        kwargs["Description"] = description
    try:
        return iam.create_policy(**kwargs)["Policy"]
    except ClientError as exc:
        if error_code(exc) == "EntityAlreadyExists":
            return None
        report("iam:CreatePolicy", exc)
    except BotoCoreError as exc:
        report("iam:CreatePolicy", exc)


def ensure_tags(iam: Any, arn: str, policy: dict[str, Any]) -> None:
    current = {t["Key"]: t["Value"] for t in policy.get("Tags") or []}
    missing = [{"Key": k, "Value": v} for k, v in REQUIRED_TAGS.items() if current.get(k) != v]
    if missing:
        call("iam:TagPolicy", lambda: iam.tag_policy(PolicyArn=arn, Tags=missing))
        print("  tagged     " + ", ".join(f"{t['Key']}={t['Value']}" for t in missing))


def prune_versions(iam: Any, arn: str) -> None:
    def versions() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for page in iam.get_paginator("list_policy_versions").paginate(PolicyArn=arn):
            out.extend(page.get("Versions", []))
        return out

    existing = call("iam:ListPolicyVersions", versions)
    if len(existing) < MAX_VERSIONS:
        return
    candidates = sorted((v for v in existing if not v.get("IsDefaultVersion")), key=lambda v: v["CreateDate"])
    if not candidates:
        fail(f"{arn}: {len(existing)} versions exist and none is deletable")
    oldest = candidates[0]["VersionId"]
    call("iam:DeletePolicyVersion", lambda: iam.delete_policy_version(PolicyArn=arn, VersionId=oldest))
    print(f"  pruned     {oldest} (IAM keeps at most {MAX_VERSIONS} versions)")


def upsert(iam: Any, arn: str, name: str, doc: dict[str, Any], compact: str, description: str | None) -> str:
    policy = get_policy(iam, arn)
    if policy is None:
        created = create_policy(iam, name, compact, description)
        if created is not None:
            version = created.get("DefaultVersionId", "v1")
            print(f"created    {redact(created['Arn'])} ({version})")
            return f"created ({version})"
        policy = get_policy(iam, arn)
        if policy is None:
            fail(f"{name} exists but not at {arn} (non-default path?); refusing to guess")

    default_id = policy["DefaultVersionId"]
    current = call(
        "iam:GetPolicyVersion",
        lambda: iam.get_policy_version(PolicyArn=arn, VersionId=default_id)["PolicyVersion"],
    )
    ensure_tags(iam, arn, policy)
    if description and (policy.get("Description") or "") != description:
        print("  note       --description differs from the stored one; IAM cannot change it in place")

    if normalize(current["Document"]) == normalize(doc):
        print(f"unchanged  {redact(policy['Arn'])} ({default_id})")
        return f"unchanged ({default_id})"

    prune_versions(iam, arn)
    new = call(
        "iam:CreatePolicyVersion",
        lambda: iam.create_policy_version(PolicyArn=arn, PolicyDocument=compact, SetAsDefault=True)["PolicyVersion"],
    )
    print(f"updated    {redact(policy['Arn'])} ({default_id} -> {new['VersionId']}, now default)")
    return f"updated ({default_id} -> {new['VersionId']})"


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create a customer-managed IAM policy, or publish a new default version when the JSON "
            "document differs from the current default version (normalized comparison). Idempotent."
        ),
    )
    parser.add_argument("--name", required=True, help="policy name, e.g. FoundryAscent-Boundary (path /)")
    parser.add_argument("--file", required=True, type=Path, help="path to the IAM policy JSON document")
    parser.add_argument("--description", help="policy description, applied only when the policy is created")
    args = parser.parse_args(argv)
    if not NAME_RE.fullmatch(args.name):
        parser.error(f"--name {args.name!r} is not a valid IAM policy name (1-128 of [A-Za-z0-9_+=,.@-])")
    if args.name.lower() in OPERATOR_POLICIES:
        parser.error(f"--name {args.name!r} is a policy of the stage-0 identity itself; only an administrator "
                     "changes it (infra/iam/apply-bootstrap-access.sh)")
    if args.description is not None and len(args.description) > 1000:
        parser.error("--description is longer than 1000 characters")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    doc, compact = load_document(args.file)

    session = boto3.Session()
    sts = session.client("sts", region_name=session.region_name or "us-east-1", config=CFG)
    ident = call("sts:GetCallerIdentity", sts.get_caller_identity)
    redact.set(ident["Account"])
    partition = ident["Arn"].split(":")[1]
    arn = f"arn:{partition}:iam::{ident['Account']}:policy/{args.name}"

    iam = session.client("iam", config=CFG)
    print(f"Policy {args.name} from {args.file}")
    outcome = upsert(iam, arn, args.name, doc, compact, args.description)
    append_summary(f"- IAM policy `{args.name}`: {outcome}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
