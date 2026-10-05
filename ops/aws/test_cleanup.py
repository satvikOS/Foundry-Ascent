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
        pages = self.pages.get(op, [{}])
        if isinstance(pages, Exception):
            paginator.paginate.side_effect = pages  # raised like a failing AWS call
        else:
            paginator.paginate.side_effect = lambda **_: iter(pages)
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
    def describe(KeyId: str) -> dict[str, Any]:  # boto3 parameter name
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


def test_guard_refuses_protected_targets_even_if_a_step_filter_misses() -> None:
    """Mutator.call() is the second line of defence: legacy-cleanup.json allows deletes on '*'."""
    m = c.Mutator("apply", c.Report("apply"), protected_ids={"vpc-platform", "E2PLATFORMDIST"})
    client = Recorder()
    secret_arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:foundry-ascent/aurora-admin-AbCdEf"
    blocked = [
        ("delete_stack", {"StackName": "CDKToolkit"}),
        ("delete_stack", {"StackName": "FoundryAscent-Data"}),
        ("delete_role", {"RoleName": "cdk-hnb659fds-deploy-role-111122223333-us-east-1"}),
        ("delete_role", {"RoleName": "FoundryAscent-GitHubDeploy"}),
        ("delete_role", {"RoleName": "OrganizationAccountAccessRole"}),
        ("delete_role", {"RoleName": "AWSReservedSSO_Admin_0123456789abcdef"}),
        ("delete_policy", {"PolicyArn": "arn:aws:iam::111122223333:policy/FoundryAscent-Boundary"}),
        ("delete_open_id_connect_provider",
         {"OpenIDConnectProviderArn": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"}),
        ("delete_bucket", {"Bucket": "cdk-hnb659fds-assets-111122223333-us-east-1"}),
        ("delete_bucket", {"Bucket": "foundryascent-data-documentsbucket1a2b3c"}),
        ("delete_repository", {"repositoryName": "cdk-hnb659fds-container-assets-111122223333-us-east-1"}),
        ("delete_parameters", {"Names": ["/legacy/a", "/cdk-bootstrap/hnb659fds/version"]}),
        ("delete_parameters", {"Names": ["/foundry-ascent/config"]}),
        ("delete_secret", {"SecretId": secret_arn}),
        ("delete_vpc", {"VpcId": "vpc-platform"}),
        ("delete_distribution", {"Id": "E2PLATFORMDIST", "IfMatch": "E1"}),
    ]
    for op, kwargs in blocked:
        assert m.call(client, op, service="x", region="us-east-1", resource="legacy-looking", **kwargs) is None
    assert client.mutations == []
    assert len(m.report.outcomes) == len(blocked)
    assert all(o.result == "skipped" for o in m.report.outcomes)
    # A genuinely legacy target still goes through.
    m.call(client, "delete_role", service="iam", region="global", resource="old-role", RoleName="old-role")
    assert client.mutations == [("delete_role", {"RoleName": "old-role"})]


def test_github_oidc_provider_is_never_deleted() -> None:
    iam = Recorder(
        reads={"list_open_id_connect_providers": {"OpenIDConnectProviderList": [
            {"Arn": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"},
            {"Arn": "arn:aws:iam::111122223333:oidc-provider/legacy.example.com"},
        ]}},
        pages={"list_roles": [{"Roles": []}], "list_policies": [{"Policies": []}], "list_users": [{"Users": []}]},
    )
    cleaner = make_cleaner("apply", {"iam": iam})
    cleaner.iam()
    assert iam.mutations == [("delete_open_id_connect_provider",
                              {"OpenIDConnectProviderArn": "arn:aws:iam::111122223333:oidc-provider/legacy.example.com"})]


def test_unlisted_protected_stacks_block_region_and_global_changes() -> None:
    from botocore.exceptions import ClientError

    denied = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "ListStacks")
    cfn = Recorder(pages={"list_stacks": denied})
    lam = Recorder(pages={"list_event_source_mappings": [{}],
                          "list_functions": [{"Functions": [{"FunctionName": "legacy-fn", "FunctionArn": "arn:fn"}]}]})
    iam = Recorder(
        reads={"list_open_id_connect_providers": {"OpenIDConnectProviderList": []}},
        pages={"list_roles": [{"Roles": [{"RoleName": "old-role", "Path": "/", "Arn": "arn:r"}]}],
               "list_policies": [{"Policies": []}], "list_users": [{"Users": []}]},
    )
    cleaner = make_cleaner("apply", {"cloudformation": cfn, "lambda": lam, "iam": iam})
    cleaner.collect_protected(["us-east-1"])
    assert cleaner.unverified_regions == {"us-east-1"}
    cleaner.lambdas("us-east-1")
    cleaner.iam()
    assert lam.mutations == [] and iam.mutations == []
    assert any(o.action == "list_protected_stacks" and o.result == "failed" for o in cleaner.report.outcomes)


def test_region_not_enabled_is_not_unverified() -> None:
    from botocore.exceptions import ClientError

    cfn = Recorder(pages={"list_stacks": ClientError({"Error": {"Code": "OptInRequired"}}, "ListStacks")})
    cleaner = make_cleaner("apply", {"cloudformation": cfn})
    cleaner.collect_protected(["ap-east-1"])
    assert cleaner.unverified_regions == set()


def test_ecs_services_go_through_the_mutator() -> None:
    pages = {"list_clusters": [{"clusterArns": ["arn:aws:ecs:us-east-1:1:cluster/legacy"]}],
             "list_services": [{"serviceArns": ["arn:aws:ecs:us-east-1:1:service/legacy/web"]}]}
    plan_ecs = Recorder(pages=pages)
    make_cleaner("plan", {"ecs": plan_ecs}).ecs("us-east-1")
    assert plan_ecs.mutations == []
    ecs = Recorder(pages=pages)
    make_cleaner("apply", {"ecs": ecs}).ecs("us-east-1")
    assert [op for op, _ in ecs.mutations] == ["update_service", "delete_service", "delete_cluster"]
    assert ecs.mutations[1][1] == {"cluster": "arn:aws:ecs:us-east-1:1:cluster/legacy",
                                   "service": "arn:aws:ecs:us-east-1:1:service/legacy/web", "force": True}


def test_snapshots_of_platform_databases_are_kept() -> None:
    rds = Recorder(pages={
        "describe_db_instances": [{}], "describe_db_clusters": [{}], "describe_db_snapshots": [{}],
        "describe_db_cluster_snapshots": [{"DBClusterSnapshots": [
            {"DBClusterSnapshotIdentifier": "pre-migration", "DBClusterIdentifier": "foundryascent-data-cluster1"},
            {"DBClusterSnapshotIdentifier": "old-snap", "DBClusterIdentifier": "legacy-db"},
        ]}],
    })
    cleaner = make_cleaner("apply", {"rds": rds})
    cleaner.rds("us-east-1")
    assert rds.mutations == [("delete_db_cluster_snapshot", {"DBClusterSnapshotIdentifier": "old-snap"})]


def test_platform_log_groups_are_kept() -> None:
    # The Data stack exports Aurora logs to /aws/rds/cluster/<cluster id "foundry-ascent">/postgresql.
    aurora_logs = "/aws/rds/cluster/foundry-ascent/postgresql"
    assert c.starts(aurora_logs, c.PROTECTED_LOG_PREFIXES)
    logs = Recorder(pages={"describe_log_groups": [{"logGroups": [
        {"logGroupName": aurora_logs},
        {"logGroupName": "/aws/lambda/FoundryAscent-Api"},
        {"logGroupName": "/aws/lambda/legacy-fn"},
    ]}]})
    cleaner = make_cleaner("apply", {"logs": logs, "cloudwatch": Recorder()})
    cleaner.logs_and_alarms("us-east-1")
    assert logs.mutations == [("delete_log_group", {"logGroupName": "/aws/lambda/legacy-fn"})]


def test_account_ids_are_redacted_from_the_report() -> None:
    report = c.Report("plan")
    report.add("s3", "us-east-1", "aws-cloudtrail-logs-111122223333-abc", "delete_bucket", "failed",
               "AccessDenied on arn:aws:s3:::x 111122223333")
    assert "111122223333" not in str(report.outcomes)


def test_resources_serving_a_kept_mail_domain_are_protected() -> None:
    r53 = Recorder(pages={
        "list_hosted_zones": [{"HostedZones": [{"Id": "/hostedzone/Z9", "Name": "startup.net."}]}],
        "list_resource_record_sets": [{"ResourceRecordSets": [
            {"Name": "startup.net.", "Type": "MX", "ResourceRecords": [{"Value": "1 smtp.google.com."}]},
            {"Name": "startup.net.", "Type": "A", "AliasTarget": {"DNSName": "d111.cloudfront.net."}},
            {"Name": "www.startup.net.", "Type": "CNAME", "ResourceRecords": [{"Value": "www.startup.net.s3-website-us-east-1.amazonaws.com"}]},
        ]}],
    })
    cf = Recorder(
        reads={"get_distribution_config": {"ETag": "E1", "DistributionConfig": {"Enabled": True}}},
        pages={"list_distributions": [{"DistributionList": {"Items": [
            {"Id": "A", "DomainName": "d111.cloudfront.net", "Status": "Deployed"},
            {"Id": "B", "DomainName": "d222.cloudfront.net", "Status": "Deployed", "Aliases": {"Items": ["app.startup.net"]}},
            {"Id": "C", "DomainName": "d333.cloudfront.net", "Status": "Deployed"},
        ]}}]},
    )
    s3 = Recorder(reads={"list_buckets": {"Buckets": [{"Name": "www.startup.net"}]}})
    cleaner = make_cleaner("apply", {"route53": r53, "cloudfront": cf, "s3": s3})
    cleaner.collect_kept_domains()
    cleaner.cloudfront()
    cleaner.s3()
    assert [m[1]["Id"] for m in cf.mutations] == ["C"]
    assert s3.mutations == []
