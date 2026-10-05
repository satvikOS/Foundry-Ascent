"""Offline safety tests for ops/aws/cleanup.py (no AWS access)."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

import cleanup as c


class Recorder:
    """Fake boto3 client: read operations return canned data, mutating ones are recorded."""

    def __init__(self, reads: dict[str, Any] | None = None, pages: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.reads = reads or {}
        self.pages = pages or {}
        self.mutations: list[tuple[str, dict[str, Any]]] = []

    def get_waiter(self, _name: str) -> Any:
        return MagicMock()

    def get_paginator(self, op: str) -> Any:
        paginator = MagicMock()
        paginator.paginate.side_effect = lambda **_: iter(self.pages.get(op, [{}]))
        return paginator

    def __getattr__(self, name: str) -> Any:
        if name.startswith(c.READ_ONLY_PREFIXES):
            value = self.reads.get(name, {})
            return lambda **_: value(**_) if callable(value) else value

        def mutate(**kwargs: Any) -> dict[str, Any]:
            self.mutations.append((name, kwargs))
            return {}

        return mutate


def make_cleaner(mode: str, clients: dict[str, Recorder]) -> c.Cleaner:
    cleaner = c.Cleaner(MagicMock(), mode, include_mail_zones=False)
    cleaner.client = lambda service, region=None: clients.setdefault(service, Recorder())  # type: ignore[method-assign]
    return cleaner


def test_mutator_refuses_read_only_operations() -> None:
    m = c.Mutator("apply", c.Report("apply"))
    with pytest.raises(ValueError):
        m.call(Recorder(), "list_buckets", service="s3", region="global", resource="x")


def test_plan_mode_never_mutates() -> None:
    kms = Recorder(
        reads={"describe_key": {"KeyMetadata": {"KeyId": "k1", "Arn": "arn:k1", "KeyManager": "CUSTOMER", "KeyState": "Enabled"}}},
        pages={"list_keys": [{"Keys": [{"KeyId": "k1"}]}], "list_aliases": [{"Aliases": []}]},
    )
    sm = Recorder(pages={"list_secrets": [{"SecretList": [{"Name": "old", "ARN": "arn:old"}]}]})
    s3 = Recorder(reads={"list_buckets": {"Buckets": [{"Name": "legacy-bucket"}]},
                         "get_bucket_location": {"LocationConstraint": None}},
                  pages={"list_object_versions": [{"Versions": [{"Key": "a", "VersionId": "1"}]}]})
    cleaner = make_cleaner("plan", {"kms": kms, "secretsmanager": sm, "s3": s3})
    cleaner.kms("us-east-1")
    cleaner.secrets("us-east-1")
    cleaner.s3()
    assert kms.mutations == [] and sm.mutations == [] and s3.mutations == []
    planned = {o.action for o in cleaner.report.outcomes if o.result == "planned"}
    assert {"schedule_key_deletion", "delete_secret", "delete_objects", "delete_bucket"} <= planned


def test_kms_and_secrets_use_seven_day_windows() -> None:
    kms = Recorder(
        reads={"describe_key": {"KeyMetadata": {"KeyId": "k1", "Arn": "arn:k1", "KeyManager": "CUSTOMER", "KeyState": "Enabled"}}},
        pages={"list_keys": [{"Keys": [{"KeyId": "k1"}]}], "list_aliases": [{"Aliases": []}]},
    )
    sm = Recorder(pages={"list_secrets": [{"SecretList": [{"Name": "old", "ARN": "arn:old"}]}]})
    cleaner = make_cleaner("apply", {"kms": kms, "secretsmanager": sm})
    cleaner.kms("us-east-1")
    cleaner.secrets("us-east-1")
    assert kms.mutations == [("schedule_key_deletion", {"KeyId": "k1", "PendingWindowInDays": 7})]
    assert sm.mutations == [("delete_secret", {"SecretId": "arn:old", "RecoveryWindowInDays": 7})]


def test_aws_managed_and_protected_keys_untouched() -> None:
    def describe(KeyId: str) -> dict[str, Any]:  # noqa: N803 - boto3 parameter name
        manager = "AWS" if KeyId == "aws-key" else "CUSTOMER"
        return {"KeyMetadata": {"KeyId": KeyId, "Arn": f"arn:{KeyId}", "KeyManager": manager, "KeyState": "Enabled"}}

    kms = Recorder(
        reads={"describe_key": describe},
        pages={"list_keys": [{"Keys": [{"KeyId": "aws-key"}, {"KeyId": "fa-key"}]}],
               "list_aliases": [{"Aliases": [{"AliasName": "alias/foundry-ascent/data", "TargetKeyId": "fa-key"}]}]},
    )
    cleaner = make_cleaner("apply", {"kms": kms})
    cleaner.kms("us-east-1")
    assert kms.mutations == []


def test_protected_stacks_buckets_and_roles_are_skipped() -> None:
    cfn = Recorder(pages={"list_stacks": [{"StackSummaries": [
        {"StackName": "CDKToolkit", "StackStatus": "CREATE_COMPLETE"},
        {"StackName": "FoundryAscent-Data", "StackStatus": "CREATE_COMPLETE"},
        {"StackName": "old-app", "StackStatus": "CREATE_COMPLETE"},
    ]}]})
    s3 = Recorder(reads={"list_buckets": {"Buckets": [{"Name": "cdk-hnb659fds-assets-1-us-east-1"},
                                                      {"Name": "foundry-ascent-documents"}]}})
    iam = Recorder(
        reads={"list_open_id_connect_providers": {"OpenIDConnectProviderList": []}},
        pages={"list_roles": [{"Roles": [
            {"RoleName": "cdk-hnb659fds-deploy-role", "Path": "/", "Arn": "arn:1"},
            {"RoleName": "FoundryAscent-GitHubDeploy", "Path": "/", "Arn": "arn:2"},
            {"RoleName": "AWSServiceRoleForSupport", "Path": "/aws-service-role/support.amazonaws.com/", "Arn": "arn:3"},
            {"RoleName": "OrganizationAccountAccessRole", "Path": "/", "Arn": "arn:4"},
        ]}], "list_policies": [{"Policies": []}], "list_users": [{"Users": [{"UserName": "Foundry-Ascent"}]}]},
    )
    cleaner = make_cleaner("apply", {"cloudformation": cfn, "s3": s3, "iam": iam})
    cleaner.cloudformation("us-east-1")
    cleaner.s3()
    cleaner.iam()
    assert [m for m in cfn.mutations if m[0] == "delete_stack"] == [("delete_stack", {"StackName": "old-app"})]
    assert s3.mutations == []
    assert iam.mutations == []


def test_physical_resources_of_protected_stacks_are_skipped() -> None:
    lam = Recorder(pages={"list_event_source_mappings": [{}],
                          "list_functions": [{"Functions": [{"FunctionName": "Custom-Provider-abc", "FunctionArn": "arn:fn"}]}]})
    cleaner = make_cleaner("apply", {"lambda": lam})
    cleaner.protected_ids.add("Custom-Provider-abc")
    cleaner.lambdas("us-east-1")
    assert lam.mutations == []


def test_mail_zones_need_explicit_flag() -> None:
    r53 = Recorder(pages={
        "list_hosted_zones": [{"HostedZones": [{"Id": "/hostedzone/Z1", "Name": "example.com."}]}],
        "list_resource_record_sets": [{"ResourceRecordSets": [
            {"Name": "example.com.", "Type": "NS"}, {"Name": "example.com.", "Type": "SOA"},
            {"Name": "example.com.", "Type": "MX"}]}],
        "list_domains": [{}],
    })
    cleaner = make_cleaner("apply", {"route53": r53, "route53domains": Recorder(pages={"list_domains": [{}]})})
    cleaner.route53()
    assert r53.mutations == []
    cleaner.include_mail_zones = True
    cleaner.route53()
    ops = [m[0] for m in r53.mutations]
    assert ops == ["change_resource_record_sets", "delete_hosted_zone"]
    deleted = r53.mutations[0][1]["ChangeBatch"]["Changes"]
    assert [ch["ResourceRecordSet"]["Type"] for ch in deleted] == ["MX"]


def test_iam_users_are_never_modified() -> None:
    iam = Recorder(
        reads={"list_open_id_connect_providers": {"OpenIDConnectProviderList": []}},
        pages={"list_roles": [{"Roles": []}], "list_policies": [{"Policies": []}],
               "list_users": [{"Users": [{"UserName": "someone"}, {"UserName": "Foundry-Ascent"}]}]},
    )
    cleaner = make_cleaner("apply", {"iam": iam})
    cleaner.iam()
    assert iam.mutations == []
    assert all(o.result == "skipped" for o in cleaner.report.outcomes if o.service == "iam")
