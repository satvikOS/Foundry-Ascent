"""Offline tests for ops/aws/retire_stage0.py (no AWS access)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

import retire_stage0 as r

ACCOUNT = "123456789012"
USER_ARN = f"arn:aws:iam::{ACCOUNT}:user/Foundry-Ascent"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/FoundryAscent-GitHubDeploy"
MANIFEST = Path(__file__).resolve().parents[2] / "infra" / "iam" / "required-actions.json"


def client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "op")


class FakeIam:
    """Records every IAM call (as the IAM action name) and serves a small user state."""

    def __init__(self, managed: list[str], inline: list[str], keys: list[str], *, password: bool = False,
                 role_exists: bool = True) -> None:
        self.managed = list(managed)
        self.inline = list(inline)
        self.keys = list(keys)
        self.password = password
        self.role_exists = role_exists
        self.calls: list[str] = []

    def _record(self, op: str) -> None:
        self.calls.append("iam:" + "".join(part.title() for part in op.split("_")))

    def get_paginator(self, op: str) -> Any:
        fake = self

        class Paginator:
            def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
                assert kwargs == {"UserName": "Foundry-Ascent"}
                fake._record(op)
                if op == "list_attached_user_policies":
                    return [{"AttachedPolicies": [{"PolicyName": n} for n in fake.managed]}]
                if op == "list_user_policies":
                    return [{"PolicyNames": list(fake.inline)}]
                if op == "list_access_keys":
                    return [{"AccessKeyMetadata": [{"AccessKeyId": k} for k in fake.keys]}]
                raise AssertionError(op)

        return Paginator()

    def get_login_profile(self, **_: Any) -> dict[str, Any]:
        self._record("get_login_profile")
        if not self.password:
            raise client_error("NoSuchEntity")
        return {"LoginProfile": {}}

    def get_role(self, **kwargs: Any) -> dict[str, Any]:
        self._record("get_role")
        assert kwargs == {"RoleName": "FoundryAscent-GitHubDeploy"}
        if not self.role_exists:
            raise client_error("NoSuchEntity")
        return {"Role": {}}

    def detach_user_policy(self, **kwargs: Any) -> None:
        self._record("detach_user_policy")
        name = kwargs["PolicyArn"].rsplit("/", 1)[1]
        assert kwargs["PolicyArn"] == f"arn:aws:iam::{ACCOUNT}:policy/{name}"
        self.managed.remove(name)

    def delete_access_key(self, **kwargs: Any) -> None:
        self._record("delete_access_key")
        assert kwargs["UserName"] == "Foundry-Ascent"
        self.keys.remove(kwargs["AccessKeyId"])


class FakeSts:
    def __init__(self, arn: str = USER_ARN) -> None:
        self.arn = arn

    def get_caller_identity(self) -> dict[str, str]:
        return {"Account": ACCOUNT, "Arn": self.arn}


def iam_action_order(iam: FakeIam) -> list[str]:
    return [c for c in iam.calls if c in {"iam:DetachUserPolicy", "iam:DeleteAccessKey"}]


def test_plan_changes_nothing_and_never_prints_the_account_or_full_key_ids(capsys: pytest.CaptureFixture[str]) -> None:
    iam = FakeIam([r.OPERATOR_POLICY, r.LEGACY_POLICY], [r.SELF_RETIREMENT_POLICY], ["AKIAEXAMPLEKEY0001", "AKIAEXAMPLEKEY0002"])
    assert r.run("plan", FakeSts(), iam, "AKIAEXAMPLEKEY0002", "") == 0
    assert iam_action_order(iam) == []
    out = capsys.readouterr().out
    assert ACCOUNT not in out
    assert "AKIAEXAMPLEKEY" not in out
    assert "…0002 (this job)" in out


def test_detach_legacy_cleanup_only_detaches_that_policy() -> None:
    iam = FakeIam([r.OPERATOR_POLICY, r.LEGACY_POLICY], [], ["AKIAEXAMPLEKEY0001"])
    assert r.run("detach-legacy-cleanup", FakeSts(), iam, "AKIAEXAMPLEKEY0001", "") == 0
    assert iam.managed == [r.OPERATOR_POLICY]
    assert iam.keys == ["AKIAEXAMPLEKEY0001"]


def test_retire_detaches_both_policies_and_deletes_every_key_with_the_callers_key_last() -> None:
    iam = FakeIam([r.LEGACY_POLICY, r.OPERATOR_POLICY], [r.SELF_RETIREMENT_POLICY], ["AKIAEXAMPLEKEY0001", "AKIAEXAMPLEKEY0002"])
    assert r.run("retire", FakeSts(), iam, "AKIAEXAMPLEKEY0001", ROLE_ARN) == 0
    assert iam.managed == []
    assert iam.keys == []
    assert iam_action_order(iam) == [
        "iam:DeleteAccessKey",  # the other key
        "iam:DetachUserPolicy",  # legacy cleanup
        "iam:DetachUserPolicy",  # operator (the inline self-retirement policy keeps DeleteAccessKey)
        "iam:DeleteAccessKey",  # this job's key, last
    ]


def test_retire_without_the_inline_policy_still_deletes_the_last_key_and_warns(capsys: pytest.CaptureFixture[str]) -> None:
    iam = FakeIam([r.LEGACY_POLICY, r.OPERATOR_POLICY], [], ["AKIAEXAMPLEKEY0001"], password=True)
    assert r.run("retire", FakeSts(), iam, "AKIAEXAMPLEKEY0001", ROLE_ARN) == 0
    assert iam.keys == []
    assert iam.managed == [r.OPERATOR_POLICY]
    out = capsys.readouterr().out
    assert "still attached" in out
    assert "console password" in out


@pytest.mark.parametrize(
    ("deploy_role_arn", "role_exists", "current_key", "message"),
    [
        ("", True, "AKIAEXAMPLEKEY0001", "--deploy-role-arn"),
        (f"arn:aws:iam::{ACCOUNT}:role/SomethingElse", True, "AKIAEXAMPLEKEY0001", "--deploy-role-arn"),
        ("arn:aws:iam::210987654321:role/FoundryAscent-GitHubDeploy", True, "AKIAEXAMPLEKEY0001", "another AWS account"),
        (ROLE_ARN, False, "AKIAEXAMPLEKEY0001", "cannot be read"),
        (ROLE_ARN, True, None, "not one of the user's keys"),
        (ROLE_ARN, True, "AKIAOTHERACCOUNTKEY", "not one of the user's keys"),
    ],
)
def test_retire_is_refused_before_any_change(deploy_role_arn: str, role_exists: bool, current_key: str | None,
                                             message: str) -> None:
    iam = FakeIam([r.LEGACY_POLICY, r.OPERATOR_POLICY], [r.SELF_RETIREMENT_POLICY], ["AKIAEXAMPLEKEY0001"],
                  role_exists=role_exists)
    with pytest.raises(r.Refused, match=re.escape(message)):
        r.run("retire", FakeSts(), iam, current_key, deploy_role_arn)
    assert iam_action_order(iam) == []
    assert iam.keys == ["AKIAEXAMPLEKEY0001"]


def test_only_the_stage0_user_may_run_it() -> None:
    iam = FakeIam([], [], [])
    with pytest.raises(r.Refused, match="Foundry-Ascent"):
        r.run("plan", FakeSts(f"arn:aws:sts::{ACCOUNT}:assumed-role/Admin/me"), iam, None, "")
    assert iam.calls == []


def test_every_iam_call_is_in_the_required_actions_manifest() -> None:
    iam = FakeIam([r.LEGACY_POLICY, r.OPERATOR_POLICY], [r.SELF_RETIREMENT_POLICY], ["AKIAEXAMPLEKEY0001", "AKIAEXAMPLEKEY0002"],
                  password=True)
    r.run("retire", FakeSts(), iam, "AKIAEXAMPLEKEY0002", ROLE_ARN)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    allowed = {
        a.lower()
        for e in manifest["entries"]
        if e.get("expect", "allowed") == "allowed" and "policy" not in e
        for a in e["actions"]
    }
    missing = sorted({c for c in iam.calls if c.lower() not in allowed})
    assert missing == []
