"""Verify that the stage-0 CI identity can do everything Foundry Ascent needs.

Runs as IAM user ``Foundry-Ascent`` (GitHub secrets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY):

  1. ``sts:GetCallerIdentity``; the account id is masked before anything is printed.
  2. ``iam:SimulatePrincipalPolicy`` for every entry of ``infra/iam/required-actions.json``.
     A ``required`` entry whose decision is not ``allowed`` is a failure. An entry with ``"expect": "denied"``
     inverts that: it lists something the CI identity must NOT be able to do (IAM changes, stack deletion,
     CDKToolkit changes), and an ``allowed`` decision is the failure. An entry with a ``policy`` field
     (the legacy inventory/cleanup entries, ``FoundryAscent-LegacyCleanup``) is skipped once
     ``iam:ListAttachedUserPolicies`` shows that policy is no longer attached to the caller.
  3. Independent live probes, each reported PASS / FAIL / WARN:
       * Bedrock catalogue: Nova 2 Lite and Titan Text Embeddings V2 listed; Nova 2 Lite inference profiles.
       * bedrock-mantle (OpenAI-compatible, SigV4 service ``bedrock-mantle``): GPT-6 Luna listed, and one
         Chat Completions request answered. Required only while ``models.luna.enabled`` is true in
         ``infra/cdk/config/production.json``; while AWS gates Luna for the account (enabled = false) a
         failure is reported as WARN, because the platform never calls it.
       * bedrock-runtime Converse with Nova 2 Lite: base id, then the ``us.`` and ``global.`` profiles.
       * bedrock-runtime InvokeModel with Titan Text Embeddings V2 (1024 dimensions).
       * Cost Explorer month-to-date by service (optional, WARN only, USD 0.01 per request).
  4. Markdown summary to ``$GITHUB_STEP_SUMMARY``, optional JSON result (``--json-out``),
     exit 1 if a required simulation or a model probe failed, else 0.

Dependencies: boto3 only (see ops/aws/requirements.txt). Python 3.12+.

GitHub Actions logs of this repository are public, so every printed or written string goes through
``redact`` (12-digit account ids become ``***``), and probes report only HTTP status, model ids, stop
reasons and token counts: never prompts, completions, embeddings or other response content.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO_ROOT / "infra" / "iam" / "required-actions.json"
DEFAULT_PLATFORM_CONFIG = REPO_ROOT / "infra" / "cdk" / "config" / "production.json"
ACTION_RE = re.compile(r"^[a-z0-9-]+:[A-Za-z0-9*]+$")
POLICY_NAME_RE = re.compile(r"[\w+=,.@-]{1,128}", re.ASCII)
USER_ARN_RE = re.compile(r"arn:aws[\w-]*:iam::\d{12}:user/(?:[^:]*/)?([\w+=,.@-]+)", re.ASCII)
PLACEHOLDERS = {"account", "region"}
EXPECTATIONS = ("allowed", "denied")
DENIED_DECISIONS = {"explicitDeny", "implicitDeny"}
# Any run of 6+ digits: full account ids and fragments left by truncated AWS messages.
ACCOUNT_ID_RE = re.compile(r"\d{6,}")

CFG = Config(retries={"max_attempts": 6, "mode": "adaptive"}, connect_timeout=10, read_timeout=60)
IN_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"
SIM_BATCH = 25  # action names per SimulatePrincipalPolicy request

LUNA = "openai.gpt-6-luna"
NOVA_IDS = ("amazon.nova-2-lite-v1:0", "us.amazon.nova-2-lite-v1:0", "global.amazon.nova-2-lite-v1:0")
TITAN = "amazon.titan-embed-text-v2:0"
EMBED_DIM = 1024
PROMPT = "Reply with the single word: ready"
MANTLE = "bedrock-mantle"  # SigV4 service name and endpoint prefix
MANTLE_MODEL_PATHS = ("/openai/v1/models", "/v1/models")  # tried in order; a 404 moves on to the next
HTTP_RETRYABLE = {429, 500, 502, 503, 504}
USER_AGENT = "foundry-ascent-verify-access/1"

ProbeResult = tuple[str, str, dict[str, Any]]  # (status, short detail, data for the JSON result)


def redact(text: object) -> str:
    """Hide anything shaped like an AWS account id."""
    return ACCOUNT_ID_RE.sub("***", str(text))


def describe_error(exc: BaseException) -> str:
    if isinstance(exc, ClientError):
        err = exc.response.get("Error", {})
        code = err.get("Code") or "ClientError"
        message = " ".join(str(err.get("Message") or "").split())
        return redact(f"{code}: {redact(message)[:180]}" if message else code)
    if isinstance(exc, urllib.error.URLError):
        return redact(f"{type(exc).__name__}: {exc.reason}")[:200]
    return type(exc).__name__  # BotoCoreError text can embed endpoints and paths; the class name is enough


def section(title: str) -> None:
    print(f"\n=== {title} ===", flush=True)


def luna_enabled(path: Path | str = DEFAULT_PLATFORM_CONFIG) -> tuple[bool, str]:
    """``models.luna.enabled`` of the platform config, and a note for the log.

    While Luna is disabled (AWS gates it for the account) the deployed platform never calls it, so its
    probes are reported as WARN instead of failing the run; once enabled they are required. A config that
    cannot be read makes them required (fail closed).
    """
    try:
        models = json.loads(Path(path).read_text(encoding="utf-8")).get("models", {})
    except (OSError, ValueError, AttributeError) as exc:
        return True, f"platform config unreadable ({type(exc).__name__}): GPT-6 Luna probes are required"
    luna = models.get("luna") if isinstance(models, dict) else None
    enabled = isinstance(luna, dict) and luna.get("enabled") is True
    if enabled:
        return True, "models.luna.enabled = true: GPT-6 Luna is the primary model and its probes are required"
    return False, "models.luna.enabled = false: GPT-6 Luna probes are informational (WARN, not FAIL)"


# --------------------------------------------------------------------------- manifest


@dataclass(frozen=True)
class Entry:
    purpose: str
    actions: tuple[str, ...]
    resources: tuple[str, ...]
    required: bool
    policy: str | None = None  # entry applies only while this managed policy is attached to the caller
    expect: str = "allowed"  # "denied": the CI identity must not be able to do this

    @property
    def pairs(self) -> int:
        return len(self.actions) * len(self.resources)


def _entry_problems(where: str, item: Any) -> list[str]:
    if not isinstance(item, dict):
        return [f"{where}: not an object"]
    missing = {"purpose", "actions", "resources", "required"} - set(item)
    if missing:
        return [f"{where}: missing {', '.join(sorted(missing))}"]
    problems: list[str] = []
    if not isinstance(item["purpose"], str) or not item["purpose"].strip():
        problems.append(f"{where}: purpose must be a non-empty string")
    if not isinstance(item["required"], bool):
        problems.append(f"{where}: required must be true or false")
    if "policy" in item and not (isinstance(item["policy"], str) and POLICY_NAME_RE.fullmatch(item["policy"])):
        problems.append(f"{where}: policy must be a managed policy name, got {item['policy']!r}")
    if "expect" in item and item["expect"] not in EXPECTATIONS:
        problems.append(f"{where}: expect must be one of {', '.join(EXPECTATIONS)}, got {item['expect']!r}")
    actions, resources = item["actions"], item["resources"]
    if not isinstance(actions, list) or not actions:
        problems.append(f"{where}: actions must be a non-empty list")
    else:
        problems += [f"{where}: invalid action {a!r}" for a in actions if not isinstance(a, str) or not ACTION_RE.fullmatch(a)]
        if len(set(map(str, actions))) != len(actions):
            problems.append(f"{where}: duplicate actions")
    if not isinstance(resources, list) or not resources:
        problems.append(f"{where}: resources must be a non-empty list")
    else:
        for r in resources:
            if not isinstance(r, str) or not (r == "*" or r.startswith("arn:aws:")):
                problems.append(f"{where}: resource must be '*' or an arn:aws: template, got {r!r}")
            elif unknown := set(re.findall(r"\{([^{}]*)\}", r)) - PLACEHOLDERS:
                problems.append(f"{where}: unknown placeholder(s) {sorted(unknown)} in {r!r}")
    return problems


def load_manifest(path: Path | str = DEFAULT_MANIFEST) -> list[Entry]:
    """Load and validate the manifest; raises ValueError listing every problem."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    raw = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(raw, list) or not raw:
        raise ValueError("expected a non-empty 'entries' list")
    problems = [p for i, item in enumerate(raw) for p in _entry_problems(f"entries[{i}]", item)]
    if problems:
        raise ValueError("; ".join(problems))
    return [Entry(e["purpose"].strip(), tuple(e["actions"]), tuple(e["resources"]), e["required"], e.get("policy"),
                  e.get("expect", "allowed"))
            for e in raw]


def attached_policy_names(iam: Any, caller_arn: str) -> set[str] | None:
    """Managed policies attached directly to the calling IAM user; None when that cannot be determined.

    For the CI identity this is iam:ListAttachedUserPolicies on user/Foundry-Ascent (bootstrap-operator.json,
    Sid SelfIntrospectionAndRetirement). Other callers (assumed roles, federated users) return None.
    """
    m = USER_ARN_RE.fullmatch(caller_arn)
    if not m:
        return None
    try:
        pages = iam.get_paginator("list_attached_user_policies").paginate(UserName=m[1])
        return {p["PolicyName"] for page in pages for p in page.get("AttachedPolicies", [])}
    except (ClientError, BotoCoreError) as exc:
        print(f"  ! iam:ListAttachedUserPolicies: {describe_error(exc)}")
        return None


def select_entries(entries: list[Entry], attached: set[str] | None) -> tuple[list[Entry], list[Entry]]:
    """Split into (checked, skipped): an entry tied to a policy that is not attached is skipped.

    When attachment is unknown (None), every entry is checked as declared, so nothing is silently relaxed.
    """
    if attached is None:
        return list(entries), []
    checked = [e for e in entries if e.policy is None or e.policy in attached]
    skipped = [e for e in entries if e.policy is not None and e.policy not in attached]
    return checked, skipped


def render(template: str, account: str, region: str) -> str:
    return template.replace("{account}", account).replace("{region}", region)


# --------------------------------------------------------------------------- simulation


@dataclass
class SimRow:
    purpose: str
    action: str
    resource: str  # the manifest template, so it never contains the account id
    decision: str
    required: bool
    expect: str = "allowed"

    @property
    def as_expected(self) -> bool:
        """Allowed when it must be allowed; explicitly or implicitly denied when it must be denied."""
        if self.expect == "denied":
            return self.decision in DENIED_DECISIONS
        return self.decision == "allowed"

    @property
    def failed(self) -> bool:
        return self.required and not self.as_expected


class SimulationUnavailable(Exception):
    pass


def _chunks(items: Sequence[str], size: int) -> Iterator[list[str]]:
    for i in range(0, len(items), size):
        yield list(items[i:i + size])


def _simulate(iam: Any, principal: str, actions: list[str], arns: list[str]) -> dict[tuple[str, str], str]:
    """One logical SimulatePrincipalPolicy request, following Marker while IsTruncated."""
    decisions: dict[tuple[str, str], str] = {}
    kwargs: dict[str, Any] = {"PolicySourceArn": principal, "ActionNames": actions, "ResourceArns": arns, "MaxItems": 1000}
    while True:
        resp = iam.simulate_principal_policy(**kwargs)
        for res in resp.get("EvaluationResults", []):
            action = res["EvalActionName"].lower()
            specific = res.get("ResourceSpecificResults") or []
            for item in specific:
                decisions[(action, item["EvalResourceName"])] = item["EvalResourceDecision"]
            if not specific:
                decisions[(action, res.get("EvalResourceName", "*"))] = res["EvalDecision"]
        if not resp.get("IsTruncated"):
            return decisions
        kwargs["Marker"] = resp["Marker"]


def _simulate_batch(iam: Any, principal: str, actions: list[str], arns: list[str]) -> dict[tuple[str, str], str]:
    try:
        return _simulate(iam, principal, actions, arns)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "ClientError")
        if code in {"AccessDenied", "AccessDeniedException", "NoSuchEntity"}:
            raise SimulationUnavailable(describe_error(exc)) from exc
        if code == "InvalidInput" and (len(actions) > 1 or len(arns) > 1):
            # Isolate the offending action name or resource ARN instead of losing the whole batch.
            merged: dict[tuple[str, str], str] = {}
            if len(actions) > 1:
                for action in actions:
                    merged |= _simulate_batch(iam, principal, [action], arns)
            else:
                for arn in arns:
                    merged |= _simulate_batch(iam, principal, actions, [arn])
            return merged
        print(f"  ! simulate {actions[0]} on {redact(arns[0])}: {describe_error(exc)}")
        return {(a.lower(), arn): f"error:{code}" for a in actions for arn in arns}
    except BotoCoreError as exc:
        print(f"  ! simulate {actions[0]}: {describe_error(exc)}")
        return {(a.lower(), arn): f"error:{type(exc).__name__}" for a in actions for arn in arns}


def simulate_all(iam: Any, principal: str, entries: list[Entry], account: str, region: str) -> list[SimRow]:
    rows: list[SimRow] = []
    fatal: str | None = None
    for entry in entries:
        arn_of = {tpl: render(tpl, account, region) for tpl in entry.resources}
        arns = list(dict.fromkeys(arn_of.values()))
        for chunk in _chunks(entry.actions, SIM_BATCH):
            decisions: dict[tuple[str, str], str] = {}
            if fatal is None:
                try:
                    decisions = _simulate_batch(iam, principal, chunk, arns)
                except SimulationUnavailable as exc:
                    fatal = "error:simulation-unavailable"
                    print(f"  ! iam:SimulatePrincipalPolicy unavailable, every pair is reported as {fatal}: {exc}")
            for action in chunk:
                by_action = [d for (a, _), d in decisions.items() if a == action.lower()]
                for tpl, arn in arn_of.items():
                    decision = decisions.get((action.lower(), arn))
                    if decision is None and len(arns) == 1 and by_action:
                        decision = by_action[0]
                    rows.append(SimRow(entry.purpose, action, tpl, decision or fatal or "notEvaluated", entry.required,
                                       entry.expect))
    return rows


def _clip(text: str, width: int) -> str:
    return text if len(text) <= width else text[: width - 1] + "…"


def print_table(rows: list[SimRow]) -> None:
    headers = ("purpose", "action", "resource", "decision")
    cells = [
        (
            _clip(r.purpose, 48),
            r.action,
            _clip(r.resource, 100),
            r.decision
            + (" (must be denied)" if r.expect == "denied" else "")
            + ("  <-- REQUIRED" if r.failed else "  (optional)" if not r.as_expected else ""),
        )
        for r in rows
    ]
    widths = [max([len(h), *(len(c[i]) for c in cells)]) for i, h in enumerate(headers)]

    def line(values: Sequence[str]) -> str:
        return " | ".join(v.ljust(w) for v, w in zip(values, widths, strict=True)).rstrip()

    print(line(headers))
    print("-+-".join("-" * w for w in widths))
    for c in cells:
        print(line(c))


# --------------------------------------------------------------------------- probes


@dataclass
class Probe:
    name: str
    status: str  # PASS | FAIL | WARN
    detail: str
    required: bool
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return self.required and self.status == "FAIL"


def run_probe(name: str, fn: Callable[[], ProbeResult], required: bool = True) -> Probe:
    print(f"- {name}", flush=True)
    data: dict[str, Any] = {}
    try:
        status, detail, data = fn()
    except (ClientError, BotoCoreError, urllib.error.URLError, TimeoutError) as exc:
        status, detail = "FAIL", describe_error(exc)
    except Exception as exc:  # noqa: BLE001 - a bug in one probe must not hide the others; reported as FAIL
        status, detail = "FAIL", f"unexpected {type(exc).__name__}"
    if not required and status == "FAIL":
        status = "WARN"
    probe = Probe(name, status, redact(detail), required, data)
    print(f"  [{probe.status}] {probe.detail}", flush=True)
    return probe


def probe_catalogue(bedrock: Any) -> ProbeResult:
    summaries = bedrock.list_foundation_models(byProvider="amazon").get("modelSummaries", [])
    listed = {m.get("modelId") for m in summaries}
    missing = [m for m in (NOVA_IDS[0], TITAN) if m not in listed]
    if missing:
        return "FAIL", f"not listed: {', '.join(missing)} ({len(listed)} Amazon models listed)", {}
    return "PASS", f"listed: {NOVA_IDS[0]}, {TITAN}", {}


def probe_profiles(bedrock: Any) -> ProbeResult:
    found: list[str] = []
    for page in bedrock.get_paginator("list_inference_profiles").paginate():
        for p in page.get("inferenceProfileSummaries", []):
            models = " ".join(m.get("modelArn", "") for m in p.get("models", []))
            if "nova-2-lite" in p.get("inferenceProfileId", "") or "nova-2-lite" in models:
                found.append(p["inferenceProfileId"])
    found.sort()
    return "PASS", f"Nova 2 Lite inference profiles: {', '.join(found) or 'none'}", {"nova_2_lite_profiles": found}


def _json_body(raw: bytes) -> dict[str, Any]:
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _http_reason(status: int, data: dict[str, Any], headers: Any) -> str:
    err = data["error"] if isinstance(data.get("error"), dict) else data
    header_type = str(headers.get("x-amzn-ErrorType") or "").split(":")[0] if headers is not None else ""
    code = str(err.get("code") or err.get("type") or data.get("__type") or header_type or "").strip()
    message = " ".join(str(err.get("message") or err.get("Message") or "").split())
    return redact(f"HTTP {status} {code}".rstrip() + (f": {redact(message)[:160]}" if message else ""))


def mantle_call(creds: Any, region: str, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any], str]:
    """SigV4-signed request to the OpenAI-compatible bedrock-mantle endpoint -> (status, JSON body, error reason)."""
    url = f"https://{MANTLE}.{region}.api.aws{path}"
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    for attempt in range(1, 4):
        request = AWSRequest(method=method, url=url, data=body, headers={"content-type": "application/json"})
        SigV4Auth(creds, MANTLE, region).add_auth(request)  # hashes exactly these body bytes; re-signed per attempt
        prepared = request.prepare()
        http = urllib.request.Request(prepared.url, data=prepared.body, method=method, headers=dict(prepared.headers.items()))
        http.add_header("User-Agent", USER_AGENT)  # user-agent is never part of the SigV4 signature
        try:
            with urllib.request.urlopen(http, timeout=60) as resp:
                return resp.status, _json_body(resp.read()), ""
        except urllib.error.HTTPError as exc:
            data = _json_body(exc.read())
            if exc.code in HTTP_RETRYABLE and attempt < 3:
                time.sleep(2 * attempt)
                continue
            return exc.code, data, _http_reason(exc.code, data, exc.headers)
    raise RuntimeError("unreachable")


def probe_mantle_models(creds: Any, region: str) -> ProbeResult:
    # Chat Completions and Responses are served under both /openai/v1 and /v1, but as of 2026-10 the
    # models list answers 404 (before authentication) under /openai/v1 and is only served at /v1/models.
    for path in MANTLE_MODEL_PATHS:
        status, data, reason = mantle_call(creds, region, "GET", path)
        if status != 404:
            break
    if status != 200:
        return "FAIL", f"GET {path}: {reason}", {}
    ids = sorted({str(m["id"]) for m in data.get("data") or [] if isinstance(m, dict) and m.get("id")})
    if LUNA in ids:
        return "PASS", f"GET {path} HTTP 200, {LUNA} listed ({len(ids)} models)", {"models_path": path}
    openai_ids = [i for i in ids if i.startswith("openai.")]
    more = ", has_more=true" if data.get("has_more") else ""
    return "FAIL", (f"GET {path} HTTP 200, {LUNA} not listed ({len(ids)} models{more}; "
                    f"openai.*: {', '.join(openai_ids[:10]) or 'none'})"), {"models_path": path}


def probe_mantle_chat(creds: Any, region: str) -> ProbeResult:
    payload = {"model": LUNA, "messages": [{"role": "user", "content": PROMPT}], "max_completion_tokens": 16}
    status, data, reason = mantle_call(creds, region, "POST", "/openai/v1/chat/completions", payload)
    if status != 200:
        return "FAIL", reason, {}
    usage = data.get("usage") or {}
    detail = (f"HTTP 200, model={data.get('model')}, tokens prompt={usage.get('prompt_tokens')} "
              f"completion={usage.get('completion_tokens')} total={usage.get('total_tokens')}")
    if not data.get("choices"):
        return "FAIL", detail + ", no choice returned", {}
    return "PASS", detail, {}


def probe_nova(runtime: Any) -> ProbeResult:
    working: list[str] = []
    for model_id in NOVA_IDS:
        try:
            resp = runtime.converse(
                modelId=model_id,
                messages=[{"role": "user", "content": [{"text": PROMPT}]}],
                inferenceConfig={"maxTokens": 16},
            )
        except (ClientError, BotoCoreError) as exc:
            print(f"    {model_id}: {describe_error(exc)}")
            continue
        usage = resp.get("usage", {})
        working.append(model_id)
        print(f"    {model_id}: OK (stopReason={resp.get('stopReason')}, tokens in={usage.get('inputTokens')} "
              f"out={usage.get('outputTokens')})")
    data = {"working_model_ids": working, "configure_model_id": working[0] if working else None}
    if not working:
        return "FAIL", "no Nova 2 Lite model id could be invoked (per-id reasons above)", data
    return "PASS", f"configure modelId={working[0]} (works: {', '.join(working)})", data


def probe_titan(runtime: Any) -> ProbeResult:
    resp = runtime.invoke_model(
        modelId=TITAN,
        contentType="application/json",
        accept="application/json",
        body=json.dumps({"inputText": "Foundry Ascent access check", "dimensions": EMBED_DIM, "normalize": True}),
    )
    payload = json.loads(resp["body"].read())
    length = len(payload.get("embedding") or [])
    detail = f"embedding length {length} (expected {EMBED_DIM}), inputTextTokenCount={payload.get('inputTextTokenCount')}"
    return ("PASS" if length == EMBED_DIM else "FAIL"), detail, {}


def probe_cost(ce: Any) -> ProbeResult:
    today = dt.datetime.now(dt.UTC).date()
    start, label = today.replace(day=1), "month to date"
    if start == today:  # the month-to-date window is empty on day 1
        start, label = (today - dt.timedelta(days=1)).replace(day=1), "previous month"
    kwargs: dict[str, Any] = {
        "TimePeriod": {"Start": start.isoformat(), "End": today.isoformat()},
        "Granularity": "MONTHLY",
        "Metrics": ["UnblendedCost"],
        "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
    }
    totals: dict[str, float] = {}
    try:
        while True:
            resp = ce.get_cost_and_usage(**kwargs)
            for period in resp.get("ResultsByTime", []):
                for group in period.get("Groups", []):
                    service = group["Keys"][0]
                    totals[service] = totals.get(service, 0.0) + float(group["Metrics"]["UnblendedCost"]["Amount"])
            if not resp.get("NextPageToken"):
                break
            kwargs["NextPageToken"] = resp["NextPageToken"]
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "ClientError")
        if code in {"AccessDeniedException", "AccessDenied"}:
            return "WARN", (f"{code}: IAM access to billing data may need activation by the root user "
                            "(Account > IAM user and role access to Billing information)"), {}
        if code == "DataUnavailableException":
            return "WARN", f"{code}: Cost Explorer has no data yet (first enablement can take up to 24 hours)", {}
        return "WARN", describe_error(exc), {}
    top = sorted(totals.items(), key=lambda kv: -kv[1])[:5]
    total = sum(totals.values())
    return "PASS", (f"{label} {start}..{today}: USD {total:.2f}; top: "
                    + (", ".join(f"{k} {v:.2f}" for k, v in top) or "none")), {"total_usd": round(total, 2)}


def run_probes(session: boto3.Session, region: str, skip_cost: bool, luna_required: bool = True) -> list[Probe]:
    bedrock = session.client("bedrock", config=CFG)
    runtime = session.client("bedrock-runtime", config=CFG)
    creds_source = session.get_credentials()
    creds = creds_source.get_frozen_credentials() if creds_source else None

    def signed(fn: Callable[[Any, str], ProbeResult]) -> Callable[[], ProbeResult]:
        return lambda: fn(creds, region) if creds else ("FAIL", "no AWS credentials to sign with", {})

    probes = [
        run_probe("bedrock ListFoundationModels(byProvider=amazon)", lambda: probe_catalogue(bedrock)),
        run_probe("bedrock ListInferenceProfiles (Nova 2 Lite)", lambda: probe_profiles(bedrock)),
        run_probe(f"bedrock-mantle GET models list ({LUNA})", signed(probe_mantle_models), required=luna_required),
        run_probe(f"bedrock-mantle POST /openai/v1/chat/completions ({LUNA})", signed(probe_mantle_chat),
                  required=luna_required),
        run_probe("bedrock-runtime Converse (Nova 2 Lite)", lambda: probe_nova(runtime)),
        run_probe(f"bedrock-runtime InvokeModel ({TITAN}, {EMBED_DIM} dims)", lambda: probe_titan(runtime)),
    ]
    if not skip_cost:
        ce = session.client("ce", region_name="us-east-1", config=CFG)
        probes.append(run_probe("Cost Explorer GetCostAndUsage by SERVICE (optional)", lambda: probe_cost(ce), required=False))
    return probes


# --------------------------------------------------------------------------- reporting


def _md(text: object) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _md_table(rows: list[SimRow]) -> list[str]:
    out = ["| Purpose | Action | Resource | Expected | Decision |", "| --- | --- | --- | --- | --- |"]
    out += [f"| {_md(r.purpose)} | `{r.action}` | `{_md(r.resource)}` | {r.expect} | {r.decision} |" for r in rows]
    return out


def skipped_note(skipped: Sequence[Entry]) -> str:
    policies = sorted({e.policy for e in skipped if e.policy})
    return (f"{len(skipped)} manifest entries ({sum(e.pairs for e in skipped)} pairs) not simulated: they apply only "
            f"while {', '.join(policies)} is attached to the caller, and it is not")


def step_summary(ok: bool, caller: str, region: str, run_at: str, rows: list[SimRow], probes: list[Probe], note: str,
                 skipped: Sequence[Entry] = ()) -> str:
    failures = [r for r in rows if r.failed]
    optional = [r for r in rows if not r.required and not r.as_expected]
    allowed = sum(r.decision == "allowed" for r in rows if r.expect == "allowed")
    must_allow = sum(r.expect == "allowed" for r in rows)
    denied_ok = sum(r.as_expected for r in rows if r.expect == "denied")
    must_deny = len(rows) - must_allow
    lines = [
        "## Foundry Ascent: AWS access verification",
        "",
        f"**Result: {'PASS' if ok else 'FAIL'}**{f' ({note})' if note else ''}",
        "",
        f"Caller `{caller}`, region `{region}`, run at {run_at}",
        "",
        (
            f"- IAM simulation: {allowed}/{must_allow} action/resource pairs allowed, "
            f"{denied_ok}/{must_deny} that must be denied are denied, "
            f"{len(failures)} required not as expected, {len(optional)} optional not as expected"
        ),
        *([f"- Skipped: {skipped_note(skipped)}"] if skipped else []),
        (
            f"- Live probes: {sum(p.status == 'PASS' for p in probes)}/{len(probes)} passed, "
            f"{sum(p.failed for p in probes)} required failed"
        ),
        "",
    ]
    if probes:
        lines += ["### Live probes", "", "| Probe | Status | Detail |", "| --- | --- | --- |"]
        lines += [f"| {_md(p.name)} | {p.status} | {_md(p.detail)} |" for p in probes]
        lines.append("")
    if failures:
        lines += ["### Required permissions not as expected", "", *_md_table(failures), ""]
    if optional:
        lines += ["### Optional permissions not as expected", "", *_md_table(optional), ""]
    if rows:
        lines += [f"<details><summary>All {len(rows)} simulated action/resource pairs</summary>", "",
                  *_md_table(rows), "", "</details>", ""]
    return redact("\n".join(lines))


def write_outputs(args: argparse.Namespace, result: dict[str, Any], summary: str) -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(summary + "\n")
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(redact(json.dumps(result, indent=2, default=str)) + "\n", encoding="utf-8")
        print(f"\nJSON result written to {args.json_out}")


# --------------------------------------------------------------------------- main


def policy_source_arn(caller_arn: str) -> str:
    """SimulatePrincipalPolicy wants a user or role ARN; map an STS assumed-role session to its role (path-less)."""
    m = re.fullmatch(r"arn:(aws[\w-]*):sts::(\d{12}):assumed-role/([^/]+)/.+", caller_arn)
    return f"arn:{m[1]}:iam::{m[2]}:role/{m[3]}" if m else caller_arn


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Simulate every IAM action in the required-actions manifest for the calling identity and "
                    "probe the Bedrock models (Nova 2 Lite, Titan Text Embeddings V2, and GPT-6 Luna on bedrock-mantle, "
                    "which is required only while models.luna.enabled is true). "
                    "Exits 1 if a required permission or a required model probe fails.",
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST,
                        help="required-actions manifest (default: infra/iam/required-actions.json)")
    parser.add_argument("--json-out", type=Path, help="also write the result as JSON to this path (no account id)")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1",
                        help="platform region (default: $AWS_REGION, $AWS_DEFAULT_REGION or us-east-1)")
    parser.add_argument("--skip-probes", action="store_true", help="only run the IAM simulation (no model invocations)")
    parser.add_argument("--skip-cost", action="store_true", help="skip the Cost Explorer probe (USD 0.01 per request)")
    parser.add_argument("--platform-config", type=Path, default=DEFAULT_PLATFORM_CONFIG,
                        help="platform config whose models.luna.enabled decides whether the GPT-6 Luna probes are "
                             "required (default: infra/cdk/config/production.json)")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    run_at = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    try:
        entries = load_manifest(args.manifest)
    except (OSError, ValueError) as exc:
        print(f"Invalid manifest {args.manifest}: {exc}", file=sys.stderr)
        return 1

    session = boto3.Session(region_name=args.region)
    try:
        ident = session.client("sts", config=CFG).get_caller_identity()
    except (ClientError, BotoCoreError) as exc:
        reason = f"sts:GetCallerIdentity failed: {describe_error(exc)}"
        print(reason)
        write_outputs(args, {"ok": False, "run_at": run_at, "error": reason}, step_summary(False, "unknown", args.region, run_at, [], [], reason))
        return 1
    account = ident["Account"]
    if IN_GITHUB:
        print(f"::add-mask::{account}", flush=True)
    caller = redact(ident["Arn"])
    principal = policy_source_arn(ident["Arn"])
    try:
        manifest_label = str(args.manifest.resolve().relative_to(REPO_ROOT))
    except ValueError:
        manifest_label = str(args.manifest)
    print(f"Caller:   {caller}")
    print(f"Region:   {args.region}")
    print(f"Run at:   {run_at}")
    print(f"Manifest: {manifest_label} ({len(entries)} entries)")
    if not ident["Arn"].endswith(":user/Foundry-Ascent"):
        print("Note: caller is not IAM user Foundry-Ascent; results describe the caller, not the CI identity.")

    section("IAM policy simulation (iam:SimulatePrincipalPolicy)")
    iam = session.client("iam", config=CFG)
    skipped: list[Entry] = []
    if any(e.policy for e in entries):
        attached = attached_policy_names(iam, ident["Arn"])
        entries, skipped = select_entries(entries, attached)
        conditional = sorted({e.policy for e in entries + skipped if e.policy})
        if attached is None:
            print(f"Attached policies unknown: entries tied to {', '.join(conditional)} are checked as declared.")
        else:
            for name in conditional:
                print(f"Policy {name}: {'attached, its entries are checked' if name in attached else 'not attached'}")
        if skipped:
            print(f"Skipped: {skipped_note(skipped)}.")
    rows = simulate_all(iam, principal, entries, account, args.region)
    print_table(rows)
    sim_failures = [r for r in rows if r.failed]
    optional_denied = [r for r in rows if not r.required and not r.as_expected]
    must_deny = [r for r in rows if r.expect == "denied"]
    print(f"\n{sum(r.decision == 'allowed' for r in rows if r.expect == 'allowed')}/{len(rows) - len(must_deny)} pairs "
          f"allowed; {sum(r.as_expected for r in must_deny)}/{len(must_deny)} that must be denied are denied; "
          f"{len(sim_failures)} required not as expected; {len(optional_denied)} optional not as expected")

    probes: list[Probe] = []
    luna_required, luna_note = luna_enabled(args.platform_config)
    if args.skip_probes:
        print("\nLive probes skipped (--skip-probes).")
    else:
        section(f"Live probes ({args.region})")
        print(luna_note)
        probes = run_probes(session, args.region, args.skip_cost, luna_required)
    probe_failures = [p for p in probes if p.failed]

    ok = not sim_failures and not probe_failures
    note = "" if ok else f"{len(sim_failures)} required permission(s) not as expected, {len(probe_failures)} model probe(s) failed"
    section("Result")
    print("PASS" if ok else f"FAIL: {note}")
    if IN_GITHUB and not ok:
        print(f"::error title=AWS access verification failed::{note}")

    nova = next((p.data for p in probes if p.data.get("working_model_ids") is not None), {})
    profiles = next((p.data["nova_2_lite_profiles"] for p in probes if "nova_2_lite_profiles" in p.data), None)
    result = {
        "ok": ok,
        "run_at": run_at,
        "region": args.region,
        "caller_arn": caller,
        "manifest": manifest_label,
        "simulation": {
            "pairs": len(rows),
            "allowed": sum(r.decision == "allowed" for r in rows if r.expect == "allowed"),
            "denied_as_expected": sum(r.as_expected for r in rows if r.expect == "denied"),
            "required_not_allowed": [asdict(r) for r in sim_failures],
            "optional_not_allowed": [asdict(r) for r in optional_denied],
            "skipped_entries": [{"purpose": e.purpose, "policy": e.policy, "pairs": e.pairs} for e in skipped],
            "rows": [asdict(r) for r in rows],
        },
        "probes": [asdict(p) for p in probes],
        "models": {
            "luna_enabled": luna_required,
            "luna": LUNA,
            "fallback_configure_model_id": nova.get("configure_model_id"),
            "fallback_working_model_ids": nova.get("working_model_ids"),
            "fallback_inference_profiles": profiles,
            "embeddings": TITAN,
        },
    }
    write_outputs(args, result, step_summary(ok, caller, args.region, run_at, rows, probes, note, skipped))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
