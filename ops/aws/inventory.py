"""Read-only inventory of billable and identity resources in an AWS account.

Dependencies: boto3 (see ops/aws/requirements.txt). Python 3.12+.

The script never mutates anything. It is designed to run in GitHub Actions where
logs may be public, so it:
  * registers the account ID with the runner's log masker before printing,
  * never prints secret values, key material, or object contents,
  * reports AccessDenied per call instead of failing the whole run.
"""

from __future__ import annotations

import datetime as dt
import os
import sys
from collections.abc import Callable, Iterable
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

CFG = Config(retries={"max_attempts": 6, "mode": "adaptive"}, connect_timeout=10, read_timeout=30)
IN_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"

Row = dict[str, Any]


def section(title: str) -> None:
    print(f"\n=== {title} ===", flush=True)


def safe(label: str, fn: Callable[[], Iterable[Row]]) -> list[Row]:
    try:
        return list(fn())
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "ClientError")
        # Opt-in / unsupported regions surface as these codes; they are not findings.
        if code not in {"UnrecognizedClientException", "InvalidClientTokenId", "AuthFailure"} or not label.startswith("["):
            print(f"  ! {label}: {code}")
        return []
    except BotoCoreError as exc:
        print(f"  ! {label}: {type(exc).__name__}")
        return []


def paginate(client: Any, op: str, key: str, **kwargs: Any) -> Iterable[Any]:
    for page in client.get_paginator(op).paginate(**kwargs):
        yield from page.get(key, [])


def fmt(rows: list[Row]) -> None:
    for row in rows:
        print("  - " + ", ".join(f"{k}={v}" for k, v in row.items()))


# --------------------------------------------------------------------------- regional


def regional(session: boto3.Session, region: str) -> dict[str, list[Row]]:
    c = lambda svc: session.client(svc, region_name=region, config=CFG)  # noqa: E731
    out: dict[str, list[Row]] = {}

    def kms() -> Iterable[Row]:
        client = c("kms")
        aliases: dict[str, list[str]] = {}
        for a in paginate(client, "list_aliases", "Aliases"):
            if a.get("TargetKeyId"):
                aliases.setdefault(a["TargetKeyId"], []).append(a["AliasName"])
        for k in paginate(client, "list_keys", "Keys"):
            meta = client.describe_key(KeyId=k["KeyId"])["KeyMetadata"]
            if meta.get("KeyManager") != "CUSTOMER":
                continue  # AWS-managed keys are free and cannot be deleted
            yield {
                "key": meta["KeyId"],
                "state": meta["KeyState"],
                "created": meta["CreationDate"].date(),
                "aliases": "|".join(aliases.get(meta["KeyId"], [])) or "-",
                "desc": (meta.get("Description") or "-")[:60],
                "deletion": meta.get("DeletionDate", "-"),
            }

    def secrets() -> Iterable[Row]:
        for s in paginate(c("secretsmanager"), "list_secrets", "SecretList", IncludePlannedDeletion=True):
            yield {
                "name": s["Name"],
                "created": s.get("CreatedDate", "-") and s["CreatedDate"].date(),
                "last_accessed": s.get("LastAccessedDate", "-"),
                "pending_delete": s.get("DeletedDate", "-"),
                "kms": s.get("KmsKeyId", "aws/secretsmanager"),
            }

    def lambdas() -> Iterable[Row]:
        for f in paginate(c("lambda"), "list_functions", "Functions"):
            yield {"name": f["FunctionName"], "runtime": f.get("Runtime", "image"), "modified": f["LastModified"][:10]}

    def rest_apis() -> Iterable[Row]:
        for a in paginate(c("apigateway"), "get_rest_apis", "items"):
            yield {"name": a["name"], "id": a["id"], "created": a["createdDate"].date()}

    def http_apis() -> Iterable[Row]:
        for a in c("apigatewayv2").get_apis().get("Items", []):
            yield {"name": a["Name"], "id": a["ApiId"], "protocol": a["ProtocolType"]}

    def stacks() -> Iterable[Row]:
        live = [
            "CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "ROLLBACK_COMPLETE",
            "CREATE_FAILED", "DELETE_FAILED", "UPDATE_ROLLBACK_FAILED", "ROLLBACK_FAILED",
            "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE", "CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS",
        ]
        for s in paginate(c("cloudformation"), "list_stacks", "StackSummaries", StackStatusFilter=live):
            yield {"name": s["StackName"], "status": s["StackStatus"], "created": s["CreationTime"].date()}

    def dynamo() -> Iterable[Row]:
        for t in paginate(c("dynamodb"), "list_tables", "TableNames"):
            yield {"table": t}

    def ec2_all() -> Iterable[Row]:
        ec2 = c("ec2")
        for r in paginate(ec2, "describe_instances", "Reservations"):
            for i in r["Instances"]:
                if i["State"]["Name"] != "terminated":
                    yield {"type": "instance", "id": i["InstanceId"], "state": i["State"]["Name"], "size": i["InstanceType"]}
        for v in paginate(ec2, "describe_volumes", "Volumes"):
            yield {"type": "ebs-volume", "id": v["VolumeId"], "gib": v["Size"], "state": v["State"]}
        for a in ec2.describe_addresses().get("Addresses", []):
            yield {"type": "elastic-ip", "ip": a.get("PublicIp"), "attached": bool(a.get("AssociationId"))}
        for n in paginate(ec2, "describe_nat_gateways", "NatGateways"):
            if n["State"] in {"pending", "available"}:
                yield {"type": "nat-gateway", "id": n["NatGatewayId"], "state": n["State"]}
        for v in ec2.describe_vpcs().get("Vpcs", []):
            if not v.get("IsDefault"):
                yield {"type": "vpc", "id": v["VpcId"], "cidr": v["CidrBlock"]}
        for s in paginate(ec2, "describe_snapshots", "Snapshots", OwnerIds=["self"]):
            yield {"type": "ebs-snapshot", "id": s["SnapshotId"], "gib": s["VolumeSize"]}
        for img in ec2.describe_images(Owners=["self"]).get("Images", []):
            yield {"type": "ami", "id": img["ImageId"], "name": img.get("Name", "-")}

    def elb() -> Iterable[Row]:
        for lb in paginate(c("elbv2"), "describe_load_balancers", "LoadBalancers"):
            yield {"name": lb["LoadBalancerName"], "type": lb["Type"], "state": lb["State"]["Code"]}

    def rds() -> Iterable[Row]:
        client = c("rds")
        for d in paginate(client, "describe_db_instances", "DBInstances"):
            yield {"type": "db-instance", "id": d["DBInstanceIdentifier"], "engine": d["Engine"], "class": d["DBInstanceClass"]}
        for d in paginate(client, "describe_db_clusters", "DBClusters"):
            yield {"type": "db-cluster", "id": d["DBClusterIdentifier"], "engine": d["Engine"], "status": d["Status"]}
        for s in paginate(client, "describe_db_snapshots", "DBSnapshots", SnapshotType="manual"):
            yield {"type": "db-snapshot", "id": s["DBSnapshotIdentifier"]}

    def ecr() -> Iterable[Row]:
        for r in paginate(c("ecr"), "describe_repositories", "repositories"):
            yield {"repo": r["repositoryName"], "created": r["createdAt"].date()}

    def ecs() -> Iterable[Row]:
        for arn in paginate(c("ecs"), "list_clusters", "clusterArns"):
            yield {"cluster": arn.rsplit("/", 1)[-1]}

    def log_groups() -> Iterable[Row]:
        groups = list(paginate(c("logs"), "describe_log_groups", "logGroups"))
        if groups:
            stored = sum(g.get("storedBytes", 0) for g in groups)
            yield {"count": len(groups), "stored_mib": round(stored / 1_048_576, 2),
                   "sample": "|".join(g["logGroupName"] for g in groups[:8])}

    def sns() -> Iterable[Row]:
        for t in paginate(c("sns"), "list_topics", "Topics"):
            yield {"topic": t["TopicArn"].rsplit(":", 1)[-1]}

    def sqs() -> Iterable[Row]:
        for q in c("sqs").list_queues().get("QueueUrls", []):
            yield {"queue": q.rsplit("/", 1)[-1]}

    def cognito() -> Iterable[Row]:
        for p in paginate(c("cognito-idp"), "list_user_pools", "UserPools", MaxResults=60):
            yield {"pool": p["Name"], "id": p["Id"]}

    def ssm() -> Iterable[Row]:
        params = list(paginate(c("ssm"), "describe_parameters", "Parameters"))
        if params:
            yield {"count": len(params), "sample": "|".join(p["Name"] for p in params[:8])}

    def acm() -> Iterable[Row]:
        for cert in paginate(c("acm"), "list_certificates", "CertificateSummaryList"):
            yield {"domain": cert["DomainName"], "status": cert.get("Status", "-")}

    def elasticache() -> Iterable[Row]:
        for cl in paginate(c("elasticache"), "describe_cache_clusters", "CacheClusters"):
            yield {"cluster": cl["CacheClusterId"], "engine": cl["Engine"]}

    def amplify() -> Iterable[Row]:
        for a in c("amplify").list_apps().get("apps", []):
            yield {"app": a["name"], "id": a["appId"]}

    def sfn() -> Iterable[Row]:
        for m in paginate(c("stepfunctions"), "list_state_machines", "stateMachines"):
            yield {"machine": m["name"]}

    def alarms() -> Iterable[Row]:
        n = sum(1 for _ in paginate(c("cloudwatch"), "describe_alarms", "MetricAlarms"))
        if n:
            yield {"metric_alarms": n}

    def backup() -> Iterable[Row]:
        for v in paginate(c("backup"), "list_backup_vaults", "BackupVaultList"):
            yield {"vault": v["BackupVaultName"], "recovery_points": v.get("NumberOfRecoveryPoints", 0)}

    def opensearch() -> Iterable[Row]:
        for d in c("opensearch").list_domain_names().get("DomainNames", []):
            yield {"domain": d["DomainName"]}

    def sagemaker() -> Iterable[Row]:
        for e in paginate(c("sagemaker"), "list_endpoints", "Endpoints"):
            yield {"endpoint": e["EndpointName"], "status": e["EndpointStatus"]}

    def apprunner() -> Iterable[Row]:
        for s in c("apprunner").list_services().get("ServiceSummaryList", []):
            yield {"service": s["ServiceName"], "status": s["Status"]}

    checks: dict[str, Callable[[], Iterable[Row]]] = {
        "kms-customer-keys": kms, "secretsmanager": secrets, "lambda": lambdas,
        "apigateway-rest": rest_apis, "apigateway-v2": http_apis, "cloudformation": stacks,
        "dynamodb": dynamo, "ec2": ec2_all, "elbv2": elb, "rds": rds, "ecr": ecr, "ecs": ecs,
        "cloudwatch-logs": log_groups, "sns": sns, "sqs": sqs, "cognito": cognito, "ssm-params": ssm,
        "acm": acm, "elasticache": elasticache, "amplify": amplify, "stepfunctions": sfn,
        "cloudwatch-alarms": alarms, "backup": backup, "opensearch": opensearch,
        "sagemaker": sagemaker, "apprunner": apprunner,
    }
    for name, fn in checks.items():
        rows = safe(f"[{region}] {name}", fn)
        if rows:
            out[name] = rows
    return out


# --------------------------------------------------------------------------- global


def global_inventory(session: boto3.Session, caller_arn: str) -> None:
    s3 = session.client("s3", config=CFG)
    section("S3 buckets (global)")

    def buckets() -> Iterable[Row]:
        for b in s3.list_buckets().get("Buckets", []):
            name = b["Name"]
            loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint") or "us-east-1"
            regional_s3 = session.client("s3", region_name=loc, config=CFG)
            listing = regional_s3.list_object_versions(Bucket=name, MaxKeys=1000)
            versions = len(listing.get("Versions", [])) + len(listing.get("DeleteMarkers", []))
            yield {
                "bucket": name, "region": loc, "created": b["CreationDate"].date(),
                "object_versions": f"{versions}{'+' if listing.get('IsTruncated') else ''}",
            }

    fmt(safe("s3", buckets))

    section("Route 53 (global)")
    r53 = session.client("route53", config=CFG)

    def zones() -> Iterable[Row]:
        for z in paginate(r53, "list_hosted_zones", "HostedZones"):
            types = sorted({
                rr["Type"] for rr in paginate(r53, "list_resource_record_sets", "ResourceRecordSets", HostedZoneId=z["Id"])
            })
            yield {
                "zone": z["Name"], "private": z["Config"]["PrivateZone"],
                "records": z.get("ResourceRecordSetCount"), "types": "|".join(types),
            }

    fmt(safe("route53 hosted zones", zones))

    def domains() -> Iterable[Row]:
        client = session.client("route53domains", region_name="us-east-1", config=CFG)
        for d in paginate(client, "list_domains", "Domains"):
            yield {"registered_domain": d["DomainName"], "auto_renew": d.get("AutoRenew"), "expiry": d.get("Expiry", "-")}

    fmt(safe("route53 registered domains", domains))

    section("CloudFront (global)")

    def distributions() -> Iterable[Row]:
        cf = session.client("cloudfront", config=CFG)
        for page in cf.get_paginator("list_distributions").paginate():
            for d in page.get("DistributionList", {}).get("Items", []) or []:
                yield {"id": d["Id"], "domain": d["DomainName"], "enabled": d["Enabled"],
                       "aliases": "|".join(d.get("Aliases", {}).get("Items", []) or []) or "-"}

    fmt(safe("cloudfront", distributions))

    section("IAM (global)")
    iam = session.client("iam", config=CFG)

    def users() -> Iterable[Row]:
        for u in paginate(iam, "list_users", "Users"):
            keys = iam.list_access_keys(UserName=u["UserName"]).get("AccessKeyMetadata", [])
            yield {
                "user": u["UserName"], "created": u["CreateDate"].date(),
                "is_ci_caller": u["Arn"] == caller_arn,
                "access_keys": "|".join(f"…{k['AccessKeyId'][-4:]}:{k['Status']}" for k in keys) or "-",
            }

    def roles() -> Iterable[Row]:
        for r in paginate(iam, "list_roles", "Roles"):
            yield {
                "role": r["RoleName"], "path": r["Path"], "created": r["CreateDate"].date(),
                "service_linked": r["Path"].startswith("/aws-service-role/"),
            }

    def policies() -> Iterable[Row]:
        for p in paginate(iam, "list_policies", "Policies", Scope="Local"):
            yield {"policy": p["PolicyName"], "attachments": p["AttachmentCount"]}

    def oidc() -> Iterable[Row]:
        for p in iam.list_open_id_connect_providers().get("OpenIDConnectProviderList", []):
            yield {"oidc_provider": p["Arn"].split("/", 1)[-1]}

    def groups() -> Iterable[Row]:
        for g in paginate(iam, "list_groups", "Groups"):
            yield {"group": g["GroupName"]}

    def profiles() -> Iterable[Row]:
        for p in paginate(iam, "list_instance_profiles", "InstanceProfiles"):
            yield {"instance_profile": p["InstanceProfileName"]}

    for label, fn in [("users", users), ("roles", roles), ("customer-managed policies", policies),
                      ("oidc providers", oidc), ("groups", groups), ("instance profiles", profiles)]:
        print(f" {label}:")
        fmt(safe(f"iam {label}", fn))


def cost(session: boto3.Session) -> None:
    """Two Cost Explorer calls (USD 0.01 each): last full month and month-to-date, by service and region."""
    ce = session.client("ce", region_name="us-east-1", config=CFG)
    today = dt.date.today()
    first_this = today.replace(day=1)
    first_prev = (first_this - dt.timedelta(days=1)).replace(day=1)
    windows = [("last full month", first_prev, first_this)]
    if today > first_this:
        windows.append(("month to date", first_this, today))
    for label, start, end in windows:
        section(f"Cost Explorer: {label} ({start} → {end}), unblended USD")

        def rows(start: dt.date = start, end: dt.date = end) -> Iterable[Row]:
            resp = ce.get_cost_and_usage(
                TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
                Granularity="MONTHLY", Metrics=["UnblendedCost"],
                GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}, {"Type": "DIMENSION", "Key": "REGION"}],
            )
            for period in resp["ResultsByTime"]:
                for g in period["Groups"]:
                    amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
                    if amount >= 0.005:
                        yield {"service": g["Keys"][0], "region": g["Keys"][1], "usd": round(amount, 2)}

        data = sorted(safe(f"ce {label}", rows), key=lambda r: -r["usd"])
        fmt(data)
        print(f"  total ≈ {round(sum(r['usd'] for r in data), 2)}")


def main() -> int:
    session = boto3.Session()
    sts = session.client("sts", region_name="us-east-1", config=CFG)
    ident = sts.get_caller_identity()
    account = ident["Account"]
    if IN_GITHUB:
        print(f"::add-mask::{account}", flush=True)
    print(f"Caller: {ident['Arn']}")
    print(f"Run at: {dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}")

    cost(session)
    global_inventory(session, ident["Arn"])

    ec2 = session.client("ec2", region_name="us-east-1", config=CFG)
    try:
        regions = sorted(r["RegionName"] for r in ec2.describe_regions()["Regions"])
    except ClientError as exc:
        print(f"  ! ec2:DescribeRegions denied ({exc.response['Error']['Code']}); scanning default-enabled regions")
        regions = sorted(session.get_available_regions("ec2", allow_non_regional=False))
    section(f"Regional resources across {len(regions)} enabled regions")
    empty: list[str] = []
    for region in regions:
        found = regional(session, region)
        if not found:
            empty.append(region)
            continue
        print(f"\n# {region}")
        for svc, rows in found.items():
            print(f" {svc}:")
            fmt(rows)
    print(f"\nRegions with no resources found: {', '.join(empty) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
