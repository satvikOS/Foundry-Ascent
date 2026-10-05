"""Remove billable resources that predate Foundry Ascent (one-time legacy cleanup).

Dependencies: boto3 (ops/aws/requirements.txt). Python 3.11+.

Usage:
    python ops/aws/cleanup.py --mode plan              # default: read-only, prints what would happen
    python ops/aws/cleanup.py --mode apply             # performs the deletions
    python ops/aws/cleanup.py --mode apply --include-mail-zones

Safety properties (covered by ops/aws/test_cleanup.py):
  * Every mutating call goes through Mutator.call(), which refuses unless --mode apply.
  * Foundry Ascent and CDK bootstrap resources are protected by name and by stack membership.
  * IAM users and groups are never modified. AWS-managed KMS keys, service-linked roles,
    the default VPC, registered domains and AWS-owned backup vaults are never touched.
  * KMS keys and Secrets Manager secrets are *scheduled* for deletion with a 7-day window:
    billing stops immediately and both can be restored for 7 days.
  * Route 53 zones with MX records are skipped unless --include-mail-zones is given.
  * One failure never aborts the run; failures are reported.
Logs are public on this repository, so the account ID is masked and no contents are printed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, WaiterError

CFG = Config(retries={"max_attempts": 8, "mode": "adaptive"}, connect_timeout=10, read_timeout=60)
IN_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"

PROTECTED_STACK_PREFIXES = ("CDKToolkit", "FoundryAscent")
PROTECTED_ROLE_PREFIXES = ("cdk-", "FoundryAscent")
PROTECTED_ROLE_NAMES = {"OrganizationAccountAccessRole"}
PROTECTED_ROLE_PATHS = ("/aws-service-role/", "/aws-reserved/")
PROTECTED_POLICY_PREFIXES = ("FoundryAscent",)
PROTECTED_BUCKET_PREFIXES = ("cdk-", "foundry-ascent-")
PROTECTED_ECR_PREFIXES = ("cdk-",)
PROTECTED_PARAM_PREFIXES = ("/cdk-bootstrap/", "/foundry-ascent/")
PROTECTED_SECRET_PREFIXES = ("foundry-ascent/",)
PROTECTED_LOG_PREFIXES = ("/aws/lambda/FoundryAscent", "/foundry-ascent/", "/aws/rds/cluster/foundryascent")
PROTECTED_KMS_ALIAS_PREFIXES = ("alias/foundry-ascent", "alias/aws/")
S3_DIRECT_DELETE_LIMIT = 20_000
READ_ONLY_PREFIXES = ("list_", "describe_", "get_", "head_")


@dataclass
class Outcome:
    service: str
    region: str
    resource: str
    action: str
    result: str  # planned | done | skipped | failed
    detail: str = ""


@dataclass
class Report:
    mode: str
    outcomes: list[Outcome] = field(default_factory=list)

    def add(self, service: str, region: str, resource: str, action: str, result: str, detail: str = "") -> None:
        self.outcomes.append(Outcome(service, region, resource, action, result, detail))
        print(f"{result.upper():8} {service:15} {region:15} {resource} -> {action}" + (f" ({detail})" if detail else ""),
              flush=True)


class Mutator:
    """Single choke point for every state-changing AWS call."""

    def __init__(self, mode: str, report: Report) -> None:
        self.apply = mode == "apply"
        self.report = report

    def call(self, client: Any, operation: str, *, service: str, region: str, resource: str,
             reason: str = "", **kwargs: Any) -> Any:
        if operation.startswith(READ_ONLY_PREFIXES):
            raise ValueError(f"{operation} is read-only; call the client directly")
        if not self.apply:
            self.report.add(service, region, resource, operation, "planned", reason)
            return None
        try:
            result = getattr(client, operation)(**kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "ClientError")
            self.report.add(service, region, resource, operation, "failed", code)
            return None
        except BotoCoreError as exc:
            self.report.add(service, region, resource, operation, "failed", type(exc).__name__)
            return None
        self.report.add(service, region, resource, operation, "done", reason)
        return result if result is not None else True


def starts(value: str | None, prefixes: Iterable[str]) -> bool:
    return bool(value) and any(value.startswith(p) for p in prefixes)  # type: ignore[union-attr]


def paginate(client: Any, op: str, key: str, **kwargs: Any) -> Iterable[Any]:
    for page in client.get_paginator(op).paginate(**kwargs):
        yield from page.get(key, []) or []


def read(report: Report, service: str, region: str, fn: Callable[[], Any], default: Any = None) -> Any:
    """Run a read-only call; on access errors record a skip instead of crashing."""
    try:
        return fn()
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "ClientError")
        if code not in {"UnrecognizedClientException", "InvalidClientTokenId", "AuthFailure", "OptInRequired"}:
            report.add(service, region, "*", "read", "skipped", code)
        return default
    except (BotoCoreError, KeyError) as exc:
        report.add(service, region, "*", "read", "skipped", type(exc).__name__)
        return default


class Cleaner:
    def __init__(self, session: boto3.Session, mode: str, include_mail_zones: bool) -> None:
        self.session = session
        self.report = Report(mode)
        self.m = Mutator(mode, self.report)
        self.include_mail_zones = include_mail_zones
        self.protected_ids: set[str] = set()

    def client(self, service: str, region: str | None = None) -> Any:
        return self.session.client(service, region_name=region, config=CFG)

    # -- protection -------------------------------------------------------------------------------

    def collect_protected(self, regions: list[str]) -> None:
        for region in regions:
            cfn = self.client("cloudformation", region)
            stacks = read(self.report, "cloudformation", region,
                          lambda cfn=cfn: list(paginate(cfn, "list_stacks", "StackSummaries")), [])
            for s in stacks:
                if s["StackStatus"] == "DELETE_COMPLETE" or not starts(s["StackName"], PROTECTED_STACK_PREFIXES):
                    continue
                resources = read(self.report, "cloudformation", region,
                                 lambda cfn=cfn, n=s["StackName"]: list(
                                     paginate(cfn, "list_stack_resources", "StackResourceSummaries", StackName=n)), [])
                self.protected_ids.update(r.get("PhysicalResourceId", "") for r in resources)
        self.protected_ids.discard("")
        print(f"Protected physical resources from CDKToolkit/FoundryAscent stacks: {len(self.protected_ids)}")

    def is_protected(self, *identifiers: str | None) -> bool:
        return any(i and i in self.protected_ids for i in identifiers)

    # -- regional ---------------------------------------------------------------------------------

    def cloudformation(self, region: str) -> None:
        cfn = self.client("cloudformation", region)
        stacks = read(self.report, "cloudformation", region,
                      lambda: list(paginate(cfn, "list_stacks", "StackSummaries")), [])
        targets = [s["StackName"] for s in stacks
                   if s["StackStatus"] not in ("DELETE_COMPLETE", "DELETE_IN_PROGRESS")
                   and not s.get("ParentId") and not starts(s["StackName"], PROTECTED_STACK_PREFIXES)]
        for name in targets:
            self.m.call(cfn, "delete_stack", service="cloudformation", region=region, resource=name,
                        reason="legacy stack", StackName=name)
        if self.m.apply and targets:
            deadline = time.monotonic() + 600
            for name in targets:
                remaining = max(30, int(deadline - time.monotonic()))
                try:
                    cfn.get_waiter("stack_delete_complete").wait(
                        StackName=name, WaiterConfig={"Delay": 15, "MaxAttempts": remaining // 15})
                except WaiterError as exc:
                    self.report.add("cloudformation", region, name, "wait_delete", "failed", str(exc)[:120])

    def kms(self, region: str) -> None:
        kms = self.client("kms", region)
        aliases: dict[str, list[str]] = {}
        for a in read(self.report, "kms", region, lambda: list(paginate(kms, "list_aliases", "Aliases")), []):
            if a.get("TargetKeyId"):
                aliases.setdefault(a["TargetKeyId"], []).append(a["AliasName"])
        for k in read(self.report, "kms", region, lambda: list(paginate(kms, "list_keys", "Keys")), []):
            meta = read(self.report, "kms", region, lambda k=k: kms.describe_key(KeyId=k["KeyId"])["KeyMetadata"])
            if not meta or meta.get("KeyManager") != "CUSTOMER" or meta["KeyState"] not in ("Enabled", "Disabled"):
                continue
            names = aliases.get(meta["KeyId"], [])
            if any(starts(n, PROTECTED_KMS_ALIAS_PREFIXES) for n in names) or self.is_protected(meta["KeyId"], meta["Arn"]):
                self.report.add("kms", region, meta["KeyId"], "schedule_key_deletion", "skipped", "protected")
                continue
            self.m.call(kms, "schedule_key_deletion", service="kms", region=region,
                        resource=f"{meta['KeyId']} {'|'.join(names)}".strip(),
                        reason="7-day window; billing stops now", KeyId=meta["KeyId"], PendingWindowInDays=7)

    def secrets(self, region: str) -> None:
        sm = self.client("secretsmanager", region)
        for s in read(self.report, "secretsmanager", region,
                      lambda: list(paginate(sm, "list_secrets", "SecretList", IncludePlannedDeletion=True)), []):
            if s.get("DeletedDate") or starts(s["Name"], PROTECTED_SECRET_PREFIXES) or self.is_protected(s["ARN"], s["Name"]):
                continue
            self.m.call(sm, "delete_secret", service="secretsmanager", region=region, resource=s["Name"],
                        reason="7-day recovery window; billing stops now", SecretId=s["ARN"], RecoveryWindowInDays=7)

    def lambdas(self, region: str) -> None:
        lam = self.client("lambda", region)
        for esm in read(self.report, "lambda", region,
                        lambda: list(paginate(lam, "list_event_source_mappings", "EventSourceMappings")), []):
            fn = esm.get("FunctionArn", "")
            if "FoundryAscent" in fn or self.is_protected(fn.rsplit(":", 1)[-1]):
                continue
            self.m.call(lam, "delete_event_source_mapping", service="lambda", region=region, resource=esm["UUID"],
                        UUID=esm["UUID"])
        for f in read(self.report, "lambda", region, lambda: list(paginate(lam, "list_functions", "Functions")), []):
            name = f["FunctionName"]
            if starts(name, PROTECTED_STACK_PREFIXES) or self.is_protected(name, f["FunctionArn"]):
                continue
            self.m.call(lam, "delete_function", service="lambda", region=region, resource=name, FunctionName=name)

    def apigateway(self, region: str) -> None:
        rest = self.client("apigateway", region)
        for api in read(self.report, "apigateway", region, lambda: list(paginate(rest, "get_rest_apis", "items")), []):
            if self.is_protected(api["id"]):
                continue
            self.m.call(rest, "delete_rest_api", service="apigateway", region=region, resource=api["name"],
                        restApiId=api["id"])
        for d in read(self.report, "apigateway", region, lambda: list(paginate(rest, "get_domain_names", "items")), []):
            self.m.call(rest, "delete_domain_name", service="apigateway", region=region, resource=d["domainName"],
                        domainName=d["domainName"])
        v2 = self.client("apigatewayv2", region)
        for api in read(self.report, "apigatewayv2", region, lambda: v2.get_apis().get("Items", []), []):
            if self.is_protected(api["ApiId"]):
                continue
            self.m.call(v2, "delete_api", service="apigatewayv2", region=region, resource=api["Name"], ApiId=api["ApiId"])
        for d in read(self.report, "apigatewayv2", region, lambda: v2.get_domain_names().get("Items", []), []):
            self.m.call(v2, "delete_domain_name", service="apigatewayv2", region=region, resource=d["DomainName"],
                        DomainName=d["DomainName"])

    def dynamodb(self, region: str) -> None:
        ddb = self.client("dynamodb", region)
        for name in read(self.report, "dynamodb", region, lambda: list(paginate(ddb, "list_tables", "TableNames")), []):
            if self.is_protected(name):
                continue
            desc = read(self.report, "dynamodb", region, lambda n=name: ddb.describe_table(TableName=n)["Table"], {})
            if desc.get("DeletionProtectionEnabled"):
                self.m.call(ddb, "update_table", service="dynamodb", region=region, resource=name,
                            reason="disable deletion protection", TableName=name, DeletionProtectionEnabled=False)
            self.m.call(ddb, "delete_table", service="dynamodb", region=region, resource=name, TableName=name)

    def ec2(self, region: str) -> None:
        ec2 = self.client("ec2", region)
        for r in read(self.report, "ec2", region, lambda: list(paginate(ec2, "describe_instances", "Reservations")), []):
            for i in r["Instances"]:
                if i["State"]["Name"] in ("terminated", "shutting-down") or self.is_protected(i["InstanceId"]):
                    continue
                attr = read(self.report, "ec2", region, lambda iid=i["InstanceId"]: ec2.describe_instance_attribute(
                    InstanceId=iid, Attribute="disableApiTermination")["DisableApiTermination"]["Value"], False)
                if attr:
                    self.report.add("ec2", region, i["InstanceId"], "terminate_instances", "skipped",
                                    "termination protection on; disable it in the console")
                    continue
                self.m.call(ec2, "terminate_instances", service="ec2", region=region, resource=i["InstanceId"],
                            InstanceIds=[i["InstanceId"]])
        for a in read(self.report, "ec2", region, lambda: ec2.describe_addresses().get("Addresses", []), []):
            if a.get("AssociationId"):
                self.m.call(ec2, "disassociate_address", service="ec2", region=region, resource=a.get("PublicIp", "?"),
                            AssociationId=a["AssociationId"])
            if a.get("AllocationId"):
                self.m.call(ec2, "release_address", service="ec2", region=region, resource=a.get("PublicIp", "?"),
                            AllocationId=a["AllocationId"])
        for n in read(self.report, "ec2", region, lambda: list(paginate(ec2, "describe_nat_gateways", "NatGateways")), []):
            if n["State"] in ("pending", "available") and not self.is_protected(n["NatGatewayId"]):
                self.m.call(ec2, "delete_nat_gateway", service="ec2", region=region, resource=n["NatGatewayId"],
                            NatGatewayId=n["NatGatewayId"])
        for v in read(self.report, "ec2", region, lambda: list(paginate(
                ec2, "describe_volumes", "Volumes", Filters=[{"Name": "status", "Values": ["available"]}])), []):
            if not self.is_protected(v["VolumeId"]):
                self.m.call(ec2, "delete_volume", service="ec2", region=region, resource=v["VolumeId"],
                            VolumeId=v["VolumeId"])
        for img in read(self.report, "ec2", region, lambda: ec2.describe_images(Owners=["self"]).get("Images", []), []):
            self.m.call(ec2, "deregister_image", service="ec2", region=region, resource=img["ImageId"],
                        ImageId=img["ImageId"])
        for s in read(self.report, "ec2", region, lambda: list(paginate(
                ec2, "describe_snapshots", "Snapshots", OwnerIds=["self"])), []):
            self.m.call(ec2, "delete_snapshot", service="ec2", region=region, resource=s["SnapshotId"],
                        SnapshotId=s["SnapshotId"])
        for vpc in read(self.report, "ec2", region, lambda: ec2.describe_vpcs().get("Vpcs", []), []):
            if vpc.get("IsDefault") or self.is_protected(vpc["VpcId"]):
                continue
            self._teardown_vpc(ec2, region, vpc["VpcId"])

    def _teardown_vpc(self, ec2: Any, region: str, vpc_id: str) -> None:
        f = [{"Name": "vpc-id", "Values": [vpc_id]}]
        mc = self.m.call
        for e in read(self.report, "ec2", region, lambda: ec2.describe_vpc_endpoints(Filters=f).get("VpcEndpoints", []), []):
            mc(ec2, "delete_vpc_endpoints", service="ec2", region=region, resource=e["VpcEndpointId"],
               VpcEndpointIds=[e["VpcEndpointId"]])
        for eni in read(self.report, "ec2", region, lambda: ec2.describe_network_interfaces(
                Filters=f + [{"Name": "status", "Values": ["available"]}]).get("NetworkInterfaces", []), []):
            mc(ec2, "delete_network_interface", service="ec2", region=region, resource=eni["NetworkInterfaceId"],
               NetworkInterfaceId=eni["NetworkInterfaceId"])
        for igw in read(self.report, "ec2", region, lambda: ec2.describe_internet_gateways(
                Filters=[{"Name": "attachment.vpc-id", "Values": [vpc_id]}]).get("InternetGateways", []), []):
            mc(ec2, "detach_internet_gateway", service="ec2", region=region, resource=igw["InternetGatewayId"],
               InternetGatewayId=igw["InternetGatewayId"], VpcId=vpc_id)
            mc(ec2, "delete_internet_gateway", service="ec2", region=region, resource=igw["InternetGatewayId"],
               InternetGatewayId=igw["InternetGatewayId"])
        for eigw in read(self.report, "ec2", region, lambda: ec2.describe_egress_only_internet_gateways().get(
                "EgressOnlyInternetGateways", []), []):
            if any(a.get("VpcId") == vpc_id for a in eigw.get("Attachments", [])):
                mc(ec2, "delete_egress_only_internet_gateway", service="ec2", region=region,
                   resource=eigw["EgressOnlyInternetGatewayId"],
                   EgressOnlyInternetGatewayId=eigw["EgressOnlyInternetGatewayId"])
        for rt in read(self.report, "ec2", region, lambda: ec2.describe_route_tables(Filters=f).get("RouteTables", []), []):
            if any(a.get("Main") for a in rt.get("Associations", [])):
                continue
            for a in rt.get("Associations", []):
                if a.get("RouteTableAssociationId"):
                    mc(ec2, "disassociate_route_table", service="ec2", region=region, resource=rt["RouteTableId"],
                       AssociationId=a["RouteTableAssociationId"])
            mc(ec2, "delete_route_table", service="ec2", region=region, resource=rt["RouteTableId"],
               RouteTableId=rt["RouteTableId"])
        for sn in read(self.report, "ec2", region, lambda: ec2.describe_subnets(Filters=f).get("Subnets", []), []):
            mc(ec2, "delete_subnet", service="ec2", region=region, resource=sn["SubnetId"], SubnetId=sn["SubnetId"])
        for acl in read(self.report, "ec2", region, lambda: ec2.describe_network_acls(Filters=f).get("NetworkAcls", []), []):
            if not acl.get("IsDefault"):
                mc(ec2, "delete_network_acl", service="ec2", region=region, resource=acl["NetworkAclId"],
                   NetworkAclId=acl["NetworkAclId"])
        for sg in read(self.report, "ec2", region, lambda: ec2.describe_security_groups(Filters=f).get("SecurityGroups", []), []):
            if sg.get("GroupName") != "default":
                mc(ec2, "delete_security_group", service="ec2", region=region, resource=sg["GroupId"], GroupId=sg["GroupId"])
        mc(ec2, "delete_vpc", service="ec2", region=region, resource=vpc_id, VpcId=vpc_id)

    def elb(self, region: str) -> None:
        elb = self.client("elbv2", region)
        for lb in read(self.report, "elbv2", region, lambda: list(paginate(elb, "describe_load_balancers", "LoadBalancers")), []):
            if not self.is_protected(lb["LoadBalancerArn"]):
                self.m.call(elb, "delete_load_balancer", service="elbv2", region=region, resource=lb["LoadBalancerName"],
                            LoadBalancerArn=lb["LoadBalancerArn"])
        for tg in read(self.report, "elbv2", region, lambda: list(paginate(elb, "describe_target_groups", "TargetGroups")), []):
            if not self.is_protected(tg["TargetGroupArn"]):
                self.m.call(elb, "delete_target_group", service="elbv2", region=region, resource=tg["TargetGroupName"],
                            TargetGroupArn=tg["TargetGroupArn"])

    def rds(self, region: str) -> None:
        rds = self.client("rds", region)
        for d in read(self.report, "rds", region, lambda: list(paginate(rds, "describe_db_instances", "DBInstances")), []):
            ident = d["DBInstanceIdentifier"]
            if self.is_protected(ident) or ident.startswith("foundryascent"):
                continue
            if d.get("DeletionProtection"):
                self.m.call(rds, "modify_db_instance", service="rds", region=region, resource=ident,
                            reason="disable deletion protection", DBInstanceIdentifier=ident,
                            DeletionProtection=False, ApplyImmediately=True)
            self.m.call(rds, "delete_db_instance", service="rds", region=region, resource=ident,
                        DBInstanceIdentifier=ident, SkipFinalSnapshot=True, DeleteAutomatedBackups=True)
        for c in read(self.report, "rds", region, lambda: list(paginate(rds, "describe_db_clusters", "DBClusters")), []):
            ident = c["DBClusterIdentifier"]
            if self.is_protected(ident) or ident.startswith("foundryascent"):
                continue
            if c.get("DeletionProtection"):
                self.m.call(rds, "modify_db_cluster", service="rds", region=region, resource=ident,
                            reason="disable deletion protection", DBClusterIdentifier=ident,
                            DeletionProtection=False, ApplyImmediately=True)
            self.m.call(rds, "delete_db_cluster", service="rds", region=region, resource=ident,
                        DBClusterIdentifier=ident, SkipFinalSnapshot=True)
        for s in read(self.report, "rds", region, lambda: list(paginate(
                rds, "describe_db_snapshots", "DBSnapshots", SnapshotType="manual")), []):
            self.m.call(rds, "delete_db_snapshot", service="rds", region=region, resource=s["DBSnapshotIdentifier"],
                        DBSnapshotIdentifier=s["DBSnapshotIdentifier"])
        for s in read(self.report, "rds", region, lambda: list(paginate(
                rds, "describe_db_cluster_snapshots", "DBClusterSnapshots", SnapshotType="manual")), []):
            self.m.call(rds, "delete_db_cluster_snapshot", service="rds", region=region,
                        resource=s["DBClusterSnapshotIdentifier"], DBClusterSnapshotIdentifier=s["DBClusterSnapshotIdentifier"])

    def ecr(self, region: str) -> None:
        ecr = self.client("ecr", region)
        for r in read(self.report, "ecr", region, lambda: list(paginate(ecr, "describe_repositories", "repositories")), []):
            if starts(r["repositoryName"], PROTECTED_ECR_PREFIXES) or self.is_protected(r["repositoryName"]):
                continue
            self.m.call(ecr, "delete_repository", service="ecr", region=region, resource=r["repositoryName"],
                        repositoryName=r["repositoryName"], force=True)

    def ecs(self, region: str) -> None:
        ecs = self.client("ecs", region)
        for cluster in read(self.report, "ecs", region, lambda: list(paginate(ecs, "list_clusters", "clusterArns")), []):
            if self.is_protected(cluster):
                continue
            for svc in read(self.report, "ecs", region,
                            lambda c=cluster: list(paginate(ecs, "list_services", "serviceArns", cluster=c)), []):
                self._ecs_delete_service(ecs, region, cluster, svc)
            self.m.call(ecs, "delete_cluster", service="ecs", region=region, resource=cluster.rsplit("/", 1)[-1],
                        cluster=cluster)

    def _ecs_delete_service(self, ecs: Any, region: str, cluster: str, svc: str) -> None:
        # "service" is both a Mutator keyword and an ECS parameter, so pass it explicitly.
        name = svc.rsplit("/", 1)[-1]
        if not self.m.apply:
            self.report.add("ecs", region, name, "delete_service", "planned", "scale to 0, force delete")
            return
        try:
            ecs.update_service(cluster=cluster, service=svc, desiredCount=0)
            ecs.delete_service(cluster=cluster, service=svc, force=True)
            self.report.add("ecs", region, name, "delete_service", "done")
        except ClientError as exc:
            self.report.add("ecs", region, name, "delete_service", "failed", exc.response["Error"]["Code"])

    def logs_and_alarms(self, region: str) -> None:
        logs = self.client("logs", region)
        for g in read(self.report, "logs", region, lambda: list(paginate(logs, "describe_log_groups", "logGroups")), []):
            name = g["logGroupName"]
            if starts(name, PROTECTED_LOG_PREFIXES) or self.is_protected(name):
                continue
            self.m.call(logs, "delete_log_group", service="logs", region=region, resource=name, logGroupName=name)
        cw = self.client("cloudwatch", region)
        alarms = [a["AlarmName"] for a in read(self.report, "cloudwatch", region,
                                                lambda: list(paginate(cw, "describe_alarms", "MetricAlarms")), [])
                  if not starts(a["AlarmName"], PROTECTED_STACK_PREFIXES) and not self.is_protected(a["AlarmName"])]
        for i in range(0, len(alarms), 100):
            self.m.call(cw, "delete_alarms", service="cloudwatch", region=region, resource=f"{len(alarms[i:i + 100])} alarms",
                        AlarmNames=alarms[i:i + 100])
        dashboards = [d["DashboardName"] for d in read(self.report, "cloudwatch", region,
                                                        lambda: list(paginate(cw, "list_dashboards", "DashboardEntries")), [])
                      if not starts(d["DashboardName"], PROTECTED_STACK_PREFIXES)]
        if dashboards:
            self.m.call(cw, "delete_dashboards", service="cloudwatch", region=region, resource=f"{len(dashboards)} dashboards",
                        DashboardNames=dashboards)

    def messaging(self, region: str) -> None:
        sns = self.client("sns", region)
        for t in read(self.report, "sns", region, lambda: list(paginate(sns, "list_topics", "Topics")), []):
            arn = t["TopicArn"]
            if "FoundryAscent" in arn or self.is_protected(arn):
                continue
            self.m.call(sns, "delete_topic", service="sns", region=region, resource=arn.rsplit(":", 1)[-1], TopicArn=arn)
        sqs = self.client("sqs", region)
        for url in read(self.report, "sqs", region, lambda: sqs.list_queues().get("QueueUrls", []), []):
            if "FoundryAscent" in url or self.is_protected(url):
                continue
            self.m.call(sqs, "delete_queue", service="sqs", region=region, resource=url.rsplit("/", 1)[-1], QueueUrl=url)

    def misc_regional(self, region: str) -> None:
        sfn = self.client("stepfunctions", region)
        for sm in read(self.report, "stepfunctions", region, lambda: list(paginate(sfn, "list_state_machines", "stateMachines")), []):
            if not self.is_protected(sm["stateMachineArn"]):
                self.m.call(sfn, "delete_state_machine", service="stepfunctions", region=region, resource=sm["name"],
                            stateMachineArn=sm["stateMachineArn"])
        ev = self.client("events", region)
        for rule in read(self.report, "events", region, lambda: list(paginate(ev, "list_rules", "Rules")), []):
            if rule.get("ManagedBy") or starts(rule["Name"], PROTECTED_STACK_PREFIXES) or self.is_protected(rule["Name"]):
                continue
            targets = read(self.report, "events", region, lambda r=rule: [
                t["Id"] for t in ev.list_targets_by_rule(Rule=r["Name"]).get("Targets", [])], [])
            if targets:
                self.m.call(ev, "remove_targets", service="events", region=region, resource=rule["Name"],
                            Rule=rule["Name"], Ids=targets)
            self.m.call(ev, "delete_rule", service="events", region=region, resource=rule["Name"], Name=rule["Name"])
        sch = self.client("scheduler", region)
        for s in read(self.report, "scheduler", region, lambda: list(paginate(sch, "list_schedules", "Schedules")), []):
            self.m.call(sch, "delete_schedule", service="scheduler", region=region, resource=s["Name"],
                        Name=s["Name"], GroupName=s.get("GroupName", "default"))
        amp = self.client("amplify", region)
        for app in read(self.report, "amplify", region, lambda: amp.list_apps().get("apps", []), []):
            self.m.call(amp, "delete_app", service="amplify", region=region, resource=app["name"], appId=app["appId"])
        cog = self.client("cognito-idp", region)
        for pool in read(self.report, "cognito-idp", region,
                         lambda: list(paginate(cog, "list_user_pools", "UserPools", MaxResults=60)), []):
            detail = read(self.report, "cognito-idp", region,
                          lambda p=pool: cog.describe_user_pool(UserPoolId=p["Id"])["UserPool"], {})
            if detail.get("Domain"):
                self.m.call(cog, "delete_user_pool_domain", service="cognito-idp", region=region, resource=detail["Domain"],
                            Domain=detail["Domain"], UserPoolId=pool["Id"])
            if detail.get("DeletionProtection") == "ACTIVE":
                self.m.call(cog, "update_user_pool", service="cognito-idp", region=region, resource=pool["Name"],
                            reason="disable deletion protection", UserPoolId=pool["Id"], DeletionProtection="INACTIVE")
            self.m.call(cog, "delete_user_pool", service="cognito-idp", region=region, resource=pool["Name"],
                        UserPoolId=pool["Id"])
        ssm = self.client("ssm", region)
        names = [p["Name"] for p in read(self.report, "ssm", region,
                                         lambda: list(paginate(ssm, "describe_parameters", "Parameters")), [])
                 if not starts(p["Name"], PROTECTED_PARAM_PREFIXES) and not self.is_protected(p["Name"])]
        for i in range(0, len(names), 10):
            self.m.call(ssm, "delete_parameters", service="ssm", region=region, resource=f"{len(names[i:i + 10])} parameters",
                        Names=names[i:i + 10])
        acm = self.client("acm", region)
        for c in read(self.report, "acm", region, lambda: list(paginate(acm, "list_certificates", "CertificateSummaryList")), []):
            if c.get("InUse") or self.is_protected(c["CertificateArn"]):
                continue
            self.m.call(acm, "delete_certificate", service="acm", region=region, resource=c["DomainName"],
                        CertificateArn=c["CertificateArn"])
        ec = self.client("elasticache", region)
        for rg in read(self.report, "elasticache", region, lambda: list(paginate(ec, "describe_replication_groups", "ReplicationGroups")), []):
            self.m.call(ec, "delete_replication_group", service="elasticache", region=region, resource=rg["ReplicationGroupId"],
                        ReplicationGroupId=rg["ReplicationGroupId"])
        for cc in read(self.report, "elasticache", region, lambda: list(paginate(ec, "describe_cache_clusters", "CacheClusters")), []):
            if not cc.get("ReplicationGroupId"):
                self.m.call(ec, "delete_cache_cluster", service="elasticache", region=region, resource=cc["CacheClusterId"],
                            CacheClusterId=cc["CacheClusterId"])
        es = self.client("opensearch", region)
        for d in read(self.report, "opensearch", region, lambda: es.list_domain_names().get("DomainNames", []), []):
            self.m.call(es, "delete_domain", service="opensearch", region=region, resource=d["DomainName"],
                        DomainName=d["DomainName"])
        sm = self.client("sagemaker", region)
        for e in read(self.report, "sagemaker", region, lambda: list(paginate(sm, "list_endpoints", "Endpoints")), []):
            self.m.call(sm, "delete_endpoint", service="sagemaker", region=region, resource=e["EndpointName"],
                        EndpointName=e["EndpointName"])
        ar = self.client("apprunner", region)
        for s in read(self.report, "apprunner", region, lambda: ar.list_services().get("ServiceSummaryList", []), []):
            self.m.call(ar, "delete_service", service="apprunner", region=region, resource=s["ServiceName"],
                        ServiceArn=s["ServiceArn"])

    # -- global -----------------------------------------------------------------------------------

    def s3(self) -> None:
        s3 = self.client("s3")
        for b in read(self.report, "s3", "global", lambda: s3.list_buckets().get("Buckets", []), []):
            name = b["Name"]
            if starts(name, PROTECTED_BUCKET_PREFIXES) or self.is_protected(name):
                continue
            region = read(self.report, "s3", "global",
                          lambda n=name: s3.get_bucket_location(Bucket=n).get("LocationConstraint") or "us-east-1", "us-east-1")
            rs3 = self.client("s3", region)
            objects: list[dict[str, str]] = []
            truncated = False
            for page in read(self.report, "s3", region, lambda c=rs3, n=name: list(
                    c.get_paginator("list_object_versions").paginate(Bucket=n)), []):
                for v in (page.get("Versions") or []) + (page.get("DeleteMarkers") or []):
                    objects.append({"Key": v["Key"], "VersionId": v["VersionId"]})
                if len(objects) > S3_DIRECT_DELETE_LIMIT:
                    truncated = True
                    break
            if truncated:
                self.m.call(rs3, "put_bucket_lifecycle_configuration", service="s3", region=region, resource=name,
                            reason="large bucket: self-empties in ~1 day; re-run cleanup after 48 h", Bucket=name,
                            LifecycleConfiguration={"Rules": [{
                                "ID": "foundry-ascent-legacy-expiry", "Status": "Enabled", "Filter": {},
                                "Expiration": {"Days": 1},
                                "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
                                "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}]})
                continue
            for i in range(0, len(objects), 1000):
                self.m.call(rs3, "delete_objects", service="s3", region=region,
                            resource=f"{name} ({len(objects[i:i + 1000])} object versions)",
                            Bucket=name, Delete={"Objects": objects[i:i + 1000], "Quiet": True})
            if self.m.call(rs3, "delete_bucket", service="s3", region=region, resource=name, Bucket=name) is None and self.m.apply:
                self.m.call(rs3, "put_bucket_lifecycle_configuration", service="s3", region=region, resource=name,
                            reason="delete failed (likely open multipart uploads); expiry rule set, re-run later",
                            Bucket=name, LifecycleConfiguration={"Rules": [{
                                "ID": "foundry-ascent-legacy-expiry", "Status": "Enabled", "Filter": {},
                                "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}]})

    def route53(self) -> None:
        r53 = self.client("route53")
        for z in read(self.report, "route53", "global", lambda: list(paginate(r53, "list_hosted_zones", "HostedZones")), []):
            zid, zname = z["Id"].rsplit("/", 1)[-1], z["Name"]
            records = read(self.report, "route53", "global", lambda i=zid: list(
                paginate(r53, "list_resource_record_sets", "ResourceRecordSets", HostedZoneId=i)), [])
            has_mail = any(r["Type"] == "MX" for r in records)
            if has_mail and not self.include_mail_zones:
                self.report.add("route53", "global", zname, "delete_hosted_zone", "skipped",
                                "has MX (email) records; re-run with --include-mail-zones to delete")
                continue
            changes = [{"Action": "DELETE", "ResourceRecordSet": r} for r in records
                       if not (r["Type"] in ("NS", "SOA") and r["Name"] == zname)]
            for i in range(0, len(changes), 100):
                self.m.call(r53, "change_resource_record_sets", service="route53", region="global",
                            resource=f"{zname} ({len(changes[i:i + 100])} records)", HostedZoneId=zid,
                            ChangeBatch={"Changes": changes[i:i + 100]})
            self.m.call(r53, "delete_hosted_zone", service="route53", region="global", resource=zname,
                        reason="$0.50/month", Id=zid)
        domains = read(self.report, "route53domains", "global", lambda: list(paginate(
            self.client("route53domains", "us-east-1"), "list_domains", "Domains")), [])
        for d in domains:
            self.report.add("route53domains", "global", d["DomainName"], "none", "skipped", "registered domains are never touched")

    def cloudfront(self) -> None:
        cf = self.client("cloudfront")
        dists = []
        for page in read(self.report, "cloudfront", "global", lambda: list(cf.get_paginator("list_distributions").paginate()), []):
            dists.extend(page.get("DistributionList", {}).get("Items", []) or [])
        for d in dists:
            if self.is_protected(d["Id"]):
                continue
            cfg = read(self.report, "cloudfront", "global", lambda i=d["Id"]: cf.get_distribution_config(Id=i), None)
            if not cfg:
                continue
            if cfg["DistributionConfig"]["Enabled"]:
                cfg["DistributionConfig"]["Enabled"] = False
                self.m.call(cf, "update_distribution", service="cloudfront", region="global", resource=d["DomainName"],
                            reason="disable now; delete on a later run once Deployed", Id=d["Id"], IfMatch=cfg["ETag"],
                            DistributionConfig=cfg["DistributionConfig"])
            elif d["Status"] == "Deployed":
                self.m.call(cf, "delete_distribution", service="cloudfront", region="global", resource=d["DomainName"],
                            Id=d["Id"], IfMatch=cfg["ETag"])
            else:
                self.report.add("cloudfront", "global", d["DomainName"], "delete_distribution", "skipped",
                                "disable still propagating; re-run later")

    def iam(self) -> None:
        iam = self.client("iam")
        for r in read(self.report, "iam", "global", lambda: list(paginate(iam, "list_roles", "Roles")), []):
            name = r["RoleName"]
            if (starts(name, PROTECTED_ROLE_PREFIXES) or name in PROTECTED_ROLE_NAMES
                    or starts(r["Path"], PROTECTED_ROLE_PATHS) or self.is_protected(name, r["Arn"])):
                continue
            for p in read(self.report, "iam", "global", lambda n=name: list(
                    paginate(iam, "list_attached_role_policies", "AttachedPolicies", RoleName=n)), []):
                self.m.call(iam, "detach_role_policy", service="iam", region="global", resource=name,
                            RoleName=name, PolicyArn=p["PolicyArn"])
            for pn in read(self.report, "iam", "global", lambda n=name: list(
                    paginate(iam, "list_role_policies", "PolicyNames", RoleName=n)), []):
                self.m.call(iam, "delete_role_policy", service="iam", region="global", resource=name,
                            RoleName=name, PolicyName=pn)
            for ip in read(self.report, "iam", "global", lambda n=name: list(
                    paginate(iam, "list_instance_profiles_for_role", "InstanceProfiles", RoleName=n)), []):
                self.m.call(iam, "remove_role_from_instance_profile", service="iam", region="global", resource=name,
                            InstanceProfileName=ip["InstanceProfileName"], RoleName=name)
                self.m.call(iam, "delete_instance_profile", service="iam", region="global",
                            resource=ip["InstanceProfileName"], InstanceProfileName=ip["InstanceProfileName"])
            self.m.call(iam, "delete_role", service="iam", region="global", resource=name, RoleName=name)
        for p in read(self.report, "iam", "global", lambda: list(paginate(iam, "list_policies", "Policies", Scope="Local")), []):
            if starts(p["PolicyName"], PROTECTED_POLICY_PREFIXES):
                continue
            attached = read(self.report, "iam", "global", lambda a=p["Arn"]: iam.get_policy(PolicyArn=a)["Policy"]["AttachmentCount"], 1)
            if attached and self.m.apply:
                self.report.add("iam", "global", p["PolicyName"], "delete_policy", "skipped", "still attached (user/group)")
                continue
            for v in read(self.report, "iam", "global", lambda a=p["Arn"]: iam.list_policy_versions(PolicyArn=a)["Versions"], []):
                if not v["IsDefaultVersion"]:
                    self.m.call(iam, "delete_policy_version", service="iam", region="global", resource=p["PolicyName"],
                                PolicyArn=p["Arn"], VersionId=v["VersionId"])
            self.m.call(iam, "delete_policy", service="iam", region="global", resource=p["PolicyName"], PolicyArn=p["Arn"])
        for o in read(self.report, "iam", "global", lambda: iam.list_open_id_connect_providers().get("OpenIDConnectProviderList", []), []):
            if self.is_protected(o["Arn"]):
                continue
            self.m.call(iam, "delete_open_id_connect_provider", service="iam", region="global",
                        resource=o["Arn"].split("/", 1)[-1], OpenIDConnectProviderArn=o["Arn"])
        for u in read(self.report, "iam", "global", lambda: list(paginate(iam, "list_users", "Users")), []):
            self.report.add("iam", "global", u["UserName"], "none", "skipped", "IAM users are never modified")


REGIONAL_STEPS = ("kms", "secrets", "lambdas", "apigateway", "dynamodb", "ec2", "elb", "rds", "ecr", "ecs",
                  "logs_and_alarms", "messaging", "misc_regional")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=("plan", "apply"), default="plan")
    parser.add_argument("--regions", default="all", help="'all' or a comma-separated list")
    parser.add_argument("--include-mail-zones", action="store_true")
    parser.add_argument("--json-out")
    args = parser.parse_args(argv)

    session = boto3.Session()
    ident = session.client("sts", region_name="us-east-1", config=CFG).get_caller_identity()
    if IN_GITHUB:
        print(f"::add-mask::{ident['Account']}", flush=True)
    print(f"Mode: {args.mode} | caller: {ident['Arn']}")

    cleaner = Cleaner(session, args.mode, args.include_mail_zones)
    if args.regions == "all":
        regions = read(cleaner.report, "ec2", "us-east-1", lambda: sorted(
            r["RegionName"] for r in cleaner.client("ec2", "us-east-1").describe_regions()["Regions"]), None) \
            or sorted(session.get_available_regions("ec2"))
    else:
        regions = [r.strip() for r in args.regions.split(",") if r.strip()]

    cleaner.collect_protected(regions)
    for region in regions:
        cleaner.cloudformation(region)
    for region in regions:
        for step in REGIONAL_STEPS:
            try:
                getattr(cleaner, step)(region)
            except Exception as exc:  # noqa: BLE001 - one failure must never abort the run
                cleaner.report.add(step, region, "*", "step", "failed", f"{type(exc).__name__}: {str(exc)[:120]}")
    for step in ("cloudfront", "route53", "s3", "iam"):
        try:
            getattr(cleaner, step)()
        except Exception as exc:  # noqa: BLE001
            cleaner.report.add(step, "global", "*", "step", "failed", f"{type(exc).__name__}: {str(exc)[:120]}")

    counts: dict[str, int] = {}
    for o in cleaner.report.outcomes:
        counts[o.result] = counts.get(o.result, 0) + 1
    print("\nSummary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(f"## Legacy cleanup ({args.mode})\n\n" + ", ".join(f"**{k}** {v}" for k, v in sorted(counts.items())))
            fh.write("\n\n| Result | Service | Region | Resource | Action | Detail |\n|---|---|---|---|---|---|\n")
            for o in cleaner.report.outcomes:
                if o.resource != "*" or o.result == "failed":
                    fh.write(f"| {o.result} | {o.service} | {o.region} | {o.resource} | {o.action} | {o.detail} |\n")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump({"mode": args.mode, "outcomes": [asdict(o) for o in cleaner.report.outcomes]}, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
