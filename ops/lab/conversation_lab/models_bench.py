"""Suite ``models``: which reasoning, embedding and rerank models the account may call, and how fast, how good and how
expensive each is, before the app uses any (ADR-0024).

apps/api ``src/scripts/lab-models.ts`` makes every call itself, under the lab's role, on the candidates of
``ops/lab/models.json`` ``benchmark`` (the role may invoke exactly those and the app's): no app, no browser, no database.
Its budget is the run's, as a hard cap (a call is made only when its worst case still fits), and never above
``MODELS_MAX_BUDGET_USD``.

The script's full report, the models' replies to the synthetic coaching prompt and each question's rankings go to the
private folder (sealed or deleted, like every suite's content). The public summary keeps numbers, the candidates' ids
and error codes only (``public_result`` reads the report key by key against the committed candidates).
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from conversation_lab.config import MODELS_FILE, REPO

SCRIPT = "src/scripts/lab-models.ts"
#: The script's report file under the folder given as ``--out`` (it writes ``<out>/private/models-benchmark.json``).
REPORT_FILE = "models-benchmark.json"
#: How long the script may run (a few minutes; the role's session lasts an hour).
TIMEOUT_SECONDS = 40 * 60
#: A code the summary may carry: an AWS error class name or one of the gateway's own codes.
CODE = re.compile(r"[A-Za-z][A-Za-z0-9_]{2,63}")
#: A request field the gateway left out after Bedrock refused it.
DROPPED = re.compile(r"(?:dropped|reasoning_effort):[a-z_]{2,24}")
EFFORTS = frozenset({"none", "low", "medium", "high", "xhigh", "max"})
QUALITY = {
    "answerable": "answerable",
    "noAnswer": "no_answer",
    "recallAt1": "recall_at_1",
    "recallAt3": "recall_at_3",
    "recallAt5": "recall_at_5",
    "recallAt20": "recall_at_20",
    "mrr": "mrr",
    "hardNegativeFirst": "hard_negative_first",
    "noAnswerAuc": "no_answer_auc",
    "noAnswerCaught": "no_answer_caught",
}

Runner = Callable[..., subprocess.CompletedProcess[bytes]]


def models_env(base: Mapping[str, str], *, mock: bool, region: str = "us-east-1") -> dict[str, str]:
    """The script's environment: Bedrock, or the mock gateway (``mock``: a dry run, no AWS call at all)."""
    return {
        **base,
        "APP_ENV": "development",
        "MODEL_PROVIDER": "mock" if mock else "bedrock",
        "BEDROCK_REGION": region,
        "AWS_REGION": region,
    }


def models_command(*, pnpm: str, budget_usd: float, out: Path) -> list[str]:
    return [
        pnpm,
        "--filter",
        "@foundry/api",
        "exec",
        "tsx",
        SCRIPT,
        "--budget-usd",
        f"{budget_usd:.2f}",
        # pnpm runs the script in apps/api: the folder must be absolute.
        "--out",
        str(out.resolve()),
    ]


def run_models_bench(
    out: Path, *, env: Mapping[str, str], budget_usd: float, pnpm: str, runner: Runner = subprocess.run
) -> tuple[dict[str, Any] | None, int]:
    """Runs the script; returns its report (None when it wrote none) and its exit code. Its output is kept in the
    private logs, never printed."""
    private = out / "private"
    logs = private / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    cmd = models_command(pnpm=pnpm, budget_usd=budget_usd, out=out)
    try:
        done = runner(cmd, cwd=REPO, env=dict(env), capture_output=True, timeout=TIMEOUT_SECONDS, check=False)
        (logs / "models-benchmark.log").write_bytes((done.stdout or b"") + (done.stderr or b""))
        code = done.returncode
    except subprocess.TimeoutExpired:
        code = 124
    path = private / REPORT_FILE
    if not path.is_file():
        return None, code
    try:
        report = json.loads(path.read_text(encoding="utf-8")).get("report")
    except (ValueError, AttributeError):
        return None, code
    return (report if isinstance(report, dict) else None), code


def candidate_ids(path: Path = MODELS_FILE) -> frozenset[str]:
    """Every id the summary may print: the committed candidates."""
    benchmark = json.loads(path.read_text(encoding="utf-8")).get("benchmark") or {}
    return frozenset(
        item["id"] for key in ("reasoning", "embeddings", "rerankers") for item in benchmark.get(key) or ()
    )


def _num(value: Any) -> int | float | None:
    """A number, or None: nothing else from the report reaches the public summary (besides ids and codes)."""
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _code(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) and CODE.fullmatch(value) else "Error"


def _codes(values: Any) -> list[str]:
    items = values if isinstance(values, list) else []
    return sorted({c for c in (_code(v) for v in items[:20]) if c is not None})


def _map(source: Any) -> Mapping[str, Any]:
    return source if isinstance(source, Mapping) else {}


def _rows(source: Any) -> list[Mapping[str, Any]]:
    return [r for r in source if isinstance(r, Mapping)] if isinstance(source, list) else []


def _ms(source: Any) -> dict[str, int | float | None]:
    data = _map(source)
    return {"p50": _num(data.get("p50")), "p95": _num(data.get("p95"))}


def _quality(source: Any) -> dict[str, int | float | None] | None:
    return (
        {name: _num(source.get(key)) for key, name in QUALITY.items()}
        if isinstance(source, Mapping)
        else None
    )


def public_result(
    report: Mapping[str, Any] | None, *, exit_code: int, ids: frozenset[str] | None = None
) -> dict[str, Any]:
    """The suite's public result: numbers, candidate ids and codes, read key by key from the script's report."""
    if report is None:
        return {"script_exit": exit_code, "report": False}
    known = candidate_ids() if ids is None else ids

    def listed(source: Any) -> list[Mapping[str, Any]]:
        return [r for r in _rows(source) if r.get("id") in known]

    corpus, rerank, cost = _map(report.get("corpus")), _map(report.get("rerank")), _map(report.get("costUsd"))
    base = _map(rerank.get("base"))
    return {
        "script_exit": exit_code,
        "report": True,
        "budget_reached": report.get("budgetReached") is True,
        "wall_ms": _num(report.get("wallMs")),
        "corpus": {
            name: _num(corpus.get(key))
            for key, name in (
                ("passages", "passages"),
                ("characters", "characters"),
                ("queries", "queries"),
                ("answerable", "answerable"),
                ("noAnswer", "no_answer"),
            )
        },
        "access": [
            {"id": r["id"], "ok": r.get("ok") is True, "code": _code(r.get("code"))}
            for r in listed(report.get("access"))
        ],
        "reasoning": [
            {
                "id": r["id"],
                "effort": r.get("effort") if r.get("effort") in EFFORTS else None,
                "requests": _num(r.get("requests")),
                "failures": _num(r.get("failures")),
                "codes": _codes(r.get("codes")),
                "first_token_ms": _ms(r.get("firstTokenMs")),
                "total_ms": _ms(r.get("totalMs")),
                "tokens": {
                    "input": _num(_map(r.get("tokens")).get("input")),
                    "cached_input": _num(_map(r.get("tokens")).get("cachedInput")),
                    "output": _num(_map(r.get("tokens")).get("output")),
                },
                "usd_per_request": _num(_map(r.get("costUsd")).get("perRequest")),
                "structured": {
                    "requests": _num(_map(r.get("structured")).get("requests")),
                    "valid_first": _num(_map(r.get("structured")).get("validFirst")),
                    "valid_repaired": _num(_map(r.get("structured")).get("validRepaired")),
                    "failed": _num(_map(r.get("structured")).get("failed")),
                    "codes": _codes(_map(r.get("structured")).get("codes")),
                    "total_ms": _ms(_map(r.get("structured")).get("totalMs")),
                },
                "dropped_fields": sorted(
                    {f for f in (r.get("droppedFields") or []) if isinstance(f, str) and DROPPED.fullmatch(f)}
                ),
            }
            for r in listed(report.get("reasoning"))
        ],
        "lexical": _quality(report.get("lexical")),
        "embeddings": [
            {
                "id": r["id"],
                "dimensions": _num(r.get("dimensions")),
                "code": _code(r.get("code")),
                "query_ms": _ms(r.get("queryMs")),
                "usd_per_million_tokens": _num(r.get("usdPerMillionTokens")),
                "corpus_tokens": _num(r.get("corpusTokens")),
                "tokens_reported": r.get("tokensReported") is True,
                "vector": _quality(r.get("vector")),
                "hybrid": _quality(r.get("hybrid")),
            }
            for r in listed(report.get("embeddings"))
        ],
        "rerank": {
            "base": (
                {"id": base["id"], "dimensions": _num(base.get("dimensions"))}
                if base.get("id") in known
                else None
            ),
            "sample": _num(rerank.get("sample")),
            "before": _quality(rerank.get("before")),
            "models": [
                {
                    "id": r["id"],
                    "code": _code(r.get("code")),
                    "ms": _ms(r.get("ms")),
                    "usd_per_thousand_queries": _num(r.get("usdPerThousandQueries")),
                    "quality": _quality(r.get("quality")),
                }
                for r in listed(rerank.get("models"))
            ],
        },
        "cost_usd": {
            key: _num(cost.get(key)) for key in ("total", "access", "reasoning", "embeddings", "rerank")
        },
    }


def _cell(value: Any) -> str:
    return "-" if value is None else str(value)


def _spread(cell: Mapping[str, Any] | None) -> str:
    data = cell or {}
    return f"{_cell(data.get('p50'))} / {_cell(data.get('p95'))}"


def _quality_cells(q: Mapping[str, Any] | None) -> str:
    keys = (
        "recall_at_1",
        "recall_at_3",
        "recall_at_5",
        "mrr",
        "hard_negative_first",
        "no_answer_auc",
        "no_answer_caught",
    )
    return " | ".join(_cell((q or {}).get(k)) for k in keys)


def tables(result: Mapping[str, Any]) -> list[str]:
    """The suite's public tables (report.py)."""
    if not result.get("report"):
        return [f"No report from lab-models.ts (exit {result.get('script_exit')}).", ""]
    out = ["| Candidate | Access |", "| --- | --- |"]
    out += [f"| {a['id']} | {'yes' if a['ok'] else _cell(a['code'])} |" for a in result.get("access") or []]
    out += [
        "",
        "| Reasoning model | Effort | Requests (failed) | First token p50 / p95 (ms) | Whole reply p50 / p95 (ms) "
        "| Tokens in (cached) / out | USD per reply | Structured: valid first / repaired / failed | Its p50 / p95 (ms) "
        "| Codes, dropped fields |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in result.get("reasoning") or []:
        s, t = r["structured"], r["tokens"]
        notes = ", ".join([*r["codes"], *s["codes"], *r["dropped_fields"]]) or "-"
        out.append(
            f"| {r['id']} | {_cell(r['effort'])} | {_cell(r['requests'])} ({_cell(r['failures'])}) | "
            f"{_spread(r['first_token_ms'])} | {_spread(r['total_ms'])} | {_cell(t['input'])} "
            f"({_cell(t['cached_input'])}) / {_cell(t['output'])} | {_cell(r['usd_per_request'])} | "
            f"{_cell(s['valid_first'])} / {_cell(s['valid_repaired'])} / {_cell(s['failed'])} of {_cell(s['requests'])} | "
            f"{_spread(s['total_ms'])} | {notes} |"
        )
    corpus = result.get("corpus") or {}
    head = (
        "Query p50 / p95 (ms) | USD per 1M tokens | R@1 | R@3 | R@5 | MRR | Hard negative first "
        "| No-answer AUC | No-answer caught |"
    )
    out += [
        "",
        f"Retrieval over {_cell(corpus.get('passages'))} passages, {_cell(corpus.get('answerable'))} questions with an "
        f"answer and {_cell(corpus.get('no_answer'))} without:",
        "",
        f"| Retrieval | Size | {head}",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        f"| word search alone | - | - | - | {_quality_cells(result.get('lexical'))} |",
    ]
    for e in result.get("embeddings") or []:
        if e["code"] is not None:
            out.append(
                f"| {e['id']} | {_cell(e['dimensions'])} | {e['code']} | - | - | - | - | - | - | - | - |"
            )
            continue
        for label in ("vector", "hybrid"):
            out.append(
                f"| {e['id']} ({label}) | {_cell(e['dimensions'])} | {_spread(e['query_ms'])} | "
                f"{_cell(e['usd_per_million_tokens'])} | {_quality_cells(e[label])} |"
            )
    rerank = result.get("rerank") or {}
    base = rerank.get("base") or {}
    out += [
        "",
        f"Reranking the fused top 20 of {_cell(base.get('id'))} ({_cell(base.get('dimensions'))}) on "
        f"{_cell(rerank.get('sample'))} questions:",
        "",
        "| Reranker | p50 / p95 (ms) | USD per 1,000 | R@1 | R@3 | R@5 | MRR | Hard negative first | No-answer AUC "
        "| No-answer caught |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        f"| none | - | - | {_quality_cells(rerank.get('before'))} |",
    ]
    for m in rerank.get("models") or []:
        name = m["id"] if m["code"] is None else f"{m['id']} ({m['code']})"
        out.append(
            f"| {name} | {_spread(m['ms'])} | {_cell(m['usd_per_thousand_queries'])} | {_quality_cells(m['quality'])} |"
        )
    cost = result.get("cost_usd") or {}
    out += [
        "",
        f"Cost USD {_cell(cost.get('total'))} (access {_cell(cost.get('access'))}, reasoning "
        f"{_cell(cost.get('reasoning'))}, embeddings {_cell(cost.get('embeddings'))}, rerank "
        f"{_cell(cost.get('rerank'))}); budget reached: {'yes' if result.get('budget_reached') else 'no'}.",
        "",
    ]
    return out
