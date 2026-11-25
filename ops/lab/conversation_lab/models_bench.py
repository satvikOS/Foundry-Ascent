"""Suite ``models``: which reasoning, embedding and rerank models the account may call, and how fast, how good and how
expensive each is, before the app uses any (ADR-0024).

apps/api ``src/scripts/lab-models.ts`` makes every call itself, under the lab's role, on the candidates of
``ops/lab/models.json`` ``benchmark`` (the role may invoke exactly those and the app's): no app, no browser. With the
job's own reset database (``DATABASE_URL``, local only) it measures production's own search on real embeddings; without
one, the models alone. Its budget is the run's, as a hard cap (a call is made only when its worst case still fits), and
never above ``MODELS_MAX_BUDGET_USD``.

The script's full report, the models' replies to the synthetic coaching prompt, each question's rankings and what AWS
said when it refused a candidate (account ids masked) go to the private folder (sealed or deleted, like every suite's
content). The public summary keeps numbers, the candidates' ids, fixed names and error codes only (``public_result``
reads the report key by key against the committed candidates).
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

SELECTION = {
    "recall": "recall",
    "precision": "precision",
    "perQuery": "per_query",
    "answerableEmpty": "answerable_empty",
    "noAnswerEmpty": "no_answer_empty",
    "perNoAnswer": "per_no_answer",
}
#: The fusion weights, floors and passage families lab-retrieval.ts measures, by the names the summary may print.
FUSIONS = (
    "words",
    "vector",
    "rrf_1",
    "rrf_2",
    "rrf_3",
    "rrf_4",
    "tie_break",
    "rescue_only",
    "default",
)
FLOORS = ("current", "suggested", "suggested_tight", "strict")
FAMILIES = ("knowledge_base", "corpus", "programme", "coach", "play")
#: The sets of messages and ways of matching lab-plays.ts measures, by the names the summary may print.
ASK_SETS = ("client", "protocol", "paraphrases", "short", "held_out", "blind", "benchmark")
NO_ASK_SETS = ("social", "venting", "off_topic", "fact", "report", "reaction", "benchmark_none")
MATCHINGS = {
    "production": "production (phrase, meaning, nothing; code's constants)",
    "suggested": "the same, suggested constants",
    "phrases": "phrases and rules alone",
    "fallback": "embedding late or failed (phrases, then plainly nearest words)",
    "held": "held-out half, suggested constants",
    "heldPhrases": "held-out half, phrases and rules alone",
}
#: Floors and margins a grid may hold, at most.
GRID_POINTS = 200
#: Variables of the job the script does not need: the app's access code is not its to hold.
NOT_THE_SCRIPTS = frozenset({"E2E_OWNER_ACCESS_CODE"})

Runner = Callable[..., subprocess.CompletedProcess[bytes]]


def models_env(base: Mapping[str, str], *, mock: bool, region: str = "us-east-1") -> dict[str, str]:
    """The script's environment: Bedrock, or the mock gateway (``mock``: a dry run, no AWS call at all)."""
    return {
        **{k: v for k, v in base.items() if k not in NOT_THE_SCRIPTS},
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


def _measured(source: Any) -> dict[str, int | float | None] | None:
    """What a search returned: selection numbers, and how its order ranks."""
    if not isinstance(source, Mapping):
        return None
    quality = _map(source.get("quality"))
    return {
        **{name: _num(source.get(key)) for key, name in SELECTION.items()},
        "recall_at_1": _num(quality.get("recallAt1")),
        "recall_at_3": _num(quality.get("recallAt3")),
        "mrr": _num(quality.get("mrr")),
    }


def _profile(source: Any) -> dict[str, int | float | None]:
    data = _map(source)
    return {"floor": _num(data.get("floor")), "weak": _num(data.get("weak"))}


def _nums(source: Any, count: int) -> list[int | float | None]:
    items = source if isinstance(source, list) else []
    return [_num(v) for v in items[:count]]


def _search(row: Mapping[str, Any]) -> dict[str, Any]:
    calibration, production = _map(row.get("calibration")), _map(row.get("production"))
    ranking, floors = _map(row.get("ranking")), _map(row.get("floors"))
    retrieval, families = _map(production.get("retrieval")), _map(production.get("families"))
    return {
        "id": row["id"],
        "dimensions": _num(row.get("dimensions")),
        "search_ms": _ms(row.get("searchMs")),
        "calibration": {
            "current": _profile(calibration.get("current")),
            "suggested": _profile(calibration.get("suggested")),
            "strict": _profile(calibration.get("strict")),
            "related": _nums(calibration.get("related"), 3),
            "unrelated": _nums(calibration.get("unrelated"), 3),
            "curve": [
                {key: _num(point.get(key)) for key in ("floor", "answered", "caught")}
                for point in _rows(calibration.get("curve"))[:20]
            ],
        },
        "ranking": {name: _quality(ranking.get(name)) for name in FUSIONS},
        "floors": {name: _measured(floors.get(name)) for name in FLOORS},
        "production": {
            "questions": _num(production.get("questions")),
            "play_answers": _num(production.get("playAnswers")),
            "retrieval": {name: _measured(retrieval.get(name)) for name in ("equal_weights", *FLOORS)},
            "pack": _measured(production.get("pack")),
            "families": {
                name: {key: _num(_map(families.get(name)).get(key)) for key in ("questions", "found")}
                for name in FAMILIES
            },
        },
    }


def _match_profile(source: Any) -> dict[str, int | float | None] | None:
    if not isinstance(source, Mapping):
        return None
    return {
        name: _num(source.get(key))
        for key, name in (
            ("floor", "floor"),
            ("margin", "margin"),
            ("referralFloor", "referral_floor"),
            ("guard", "guard"),
        )
    }


def _matching_score(source: Any) -> dict[str, Any]:
    data = _map(source)

    def share(row: Any) -> dict[str, int | float | None]:
        return {key: _num(_map(row).get(key)) for key in ("messages", "right", "wrong")}

    def matched(row: Any) -> dict[str, int | float | None]:
        return {key: _num(_map(row).get(key)) for key in ("messages", "matched")}

    asks, false = _map(data.get("asks")), _map(data.get("falseMatch"))
    return {
        "asks": {name: share(asks.get(name)) for name in ASK_SETS},
        "all": share(data.get("all")),
        "false_match": {name: matched(false.get(name)) for name in NO_ASK_SETS},
        "false_match_all": matched(data.get("falseMatchAll")),
        "near_miss": matched(data.get("nearMiss")),
        "chosen": _num(data.get("chosen")),
        "chosen_right": _num(data.get("chosenRight")),
    }


def _play_matching(row: Mapping[str, Any]) -> dict[str, Any]:
    open_, nearest, scores = _map(row.get("open")), _map(row.get("nearestRight")), _map(row.get("scores"))
    return {
        "id": row["id"],
        "dimensions": _num(row.get("dimensions")),
        "messages": _num(row.get("messages")),
        "open": {key: _num(open_.get(key)) for key in ("ask", "guarded")},
        "nearest_right": {key: _num(nearest.get(key)) for key in ("first", "top")},
        "related": _nums(row.get("related"), 3),
        "unrelated": _nums(row.get("unrelated"), 3),
        "current": _match_profile(row.get("current")),
        "suggested": _match_profile(row.get("suggested")),
        "scores": {name: _matching_score(scores.get(name)) for name in MATCHINGS},
        "grid": [
            {
                name: _num(point.get(key))
                for key, name in (
                    ("floor", "floor"),
                    ("margin", "margin"),
                    ("right", "right"),
                    ("wrong", "wrong"),
                    ("falseMatch", "false_match"),
                )
            }
            for point in _rows(row.get("grid"))[:GRID_POINTS]
        ],
    }


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
        "search": [_search(r) for r in listed(report.get("search"))],
        "play_matching": [_play_matching(r) for r in listed(report.get("playMatching"))],
        "rerank": {
            "base": (
                {
                    "id": base["id"],
                    "dimensions": _num(base.get("dimensions")),
                    "by": base.get("by") if base.get("by") in ("search", "fused") else None,
                }
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
                    "ambiguous_only": (
                        {
                            "share": _num(only.get("share")),
                            "usd_per_thousand_questions": _num(only.get("usdPerThousandQuestions")),
                            "quality": _quality(only.get("quality")),
                        }
                        if isinstance(only := r.get("ambiguousOnly"), Mapping)
                        else None
                    ),
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


def _measured_cells(m: Mapping[str, Any] | None) -> str:
    keys = (
        "recall_at_1",
        "recall_at_3",
        "mrr",
        "recall",
        "precision",
        "per_query",
        "answerable_empty",
        "no_answer_empty",
        "per_no_answer",
    )
    return " | ".join(_cell((m or {}).get(k)) for k in keys)


def search_tables(rows: list[Mapping[str, Any]]) -> list[str]:
    """Production's own search with each model's vectors: the order, the floors, and what a turn is given."""
    out: list[str] = []
    for r in rows:
        cal, prod = r["calibration"], r["production"]
        out += [
            "",
            f"Production's search with {r['id']} ({_cell(r['dimensions'])}), {_spread(r['search_ms'])} ms a search. "
            f"Floors (floor / weak): code {_cell(cal['current']['floor'])} / {_cell(cal['current']['weak'])}, "
            f"suggested {_cell(cal['suggested']['floor'])} / {_cell(cal['suggested']['weak'])}, "
            f"strict {_cell(cal['strict']['floor'])} / {_cell(cal['strict']['weak'])}. Cosine p10 / p50 / p90: "
            f"answer {' / '.join(_cell(v) for v in cal['related'])}, "
            f"no answer {' / '.join(_cell(v) for v in cal['unrelated'])}.",
            "",
            "| Fusion (whole corpus, no floor) | R@1 | R@3 | R@5 | MRR | Hard negative first |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for name in FUSIONS:
            q = r["ranking"].get(name) or {}
            cells = (
                q.get(k) for k in ("recall_at_1", "recall_at_3", "recall_at_5", "mrr", "hard_negative_first")
            )
            out.append(f"| {name} | " + " | ".join(_cell(c) for c in cells) + " |")
        out += [
            "",
            "| Search | R@1 | R@3 | MRR | Answer shown | Precision | Items | Answerable, nothing shown "
            "| No answer, nothing shown | Items when no answer |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for name in FLOORS:
            out.append(f"| whole corpus, first 3, floors {name} | {_measured_cells(r['floors'].get(name))} |")
        for name in ("equal_weights", *FLOORS):
            out.append(f"| a turn's retrieval, {name} | {_measured_cells(prod['retrieval'].get(name))} |")
        out.append(f"| a turn's evidence with its play | {_measured_cells(prod['pack'])} |")
        families = ", ".join(
            f"{name} {_cell(f['found'])} of {_cell(f['questions'])}" for name, f in prod["families"].items()
        )
        out += [
            "",
            f"Of {_cell(prod['questions'])} questions production could answer or must not; a turn's first message "
            f"gets a play that answers for {_cell(prod['play_answers'])} of the answerable ones. Found by family: {families}.",
            "",
            "| Vector floor | " + " | ".join(_cell(p["floor"]) for p in cal["curve"]) + " |",
            "| --- |" + " --- |" * len(cal["curve"]),
            "| answers kept | " + " | ".join(_cell(p["answered"]) for p in cal["curve"]) + " |",
            "| no-answer caught | " + " | ".join(_cell(p["caught"]) for p in cal["curve"]) + " |",
        ]
    return out


def _profile_text(p: Mapping[str, Any] | None) -> str:
    if p is None:
        return "none"
    return (
        f"floor {_cell(p['floor'])}, margin {_cell(p['margin'])}, referral floor {_cell(p['referral_floor'])}, "
        f"guard {_cell(p['guard'])}"
    )


def matching_tables(rows: list[Mapping[str, Any]]) -> list[str]:
    """Which play a message gets, by the rules and with each model's vectors behind them."""
    out: list[str] = []
    for r in rows:
        out += [
            "",
            f"Plays by meaning with {r['id']} ({_cell(r['dimensions'])}) over {_cell(r['messages'])} messages; "
            f"{_cell(r['open']['ask'])} plain asks and {_cell(r['open']['guarded'])} others are asked what they mean. Constants: "
            f"code's {_profile_text(r['current'])}; suggested {_profile_text(r['suggested'])}. A play that answers is "
            f"nearest for {_cell(r['nearest_right']['first'])} of the asks, among the nearest three for "
            f"{_cell(r['nearest_right']['top'])}. Similarity p10 / p50 / p90: "
            f"{' / '.join(_cell(v) for v in r['related'])} of an ask with it, "
            f"{' / '.join(_cell(v) for v in r['unrelated'])} of a message of nothing with its nearest.",
            "",
            "| Right (wrong) play | All asks | "
            + " | ".join(ASK_SETS)
            + " | Nothing asked, matched | Near misses | Chosen by meaning (right) |",
            "| --- | --- |" + " --- |" * (len(ASK_SETS) + 3),
        ]
        for name, label in MATCHINGS.items():
            s = r["scores"][name]
            cells = [f"{_cell(x['right'])} ({_cell(x['wrong'])})" for x in (s["all"], *s["asks"].values())]
            out.append(
                f"| {label} | "
                + " | ".join(cells)
                + f" | {_cell(s['false_match_all']['matched'])} | {_cell(s['near_miss']['matched'])} | "
                f"{_cell(s['chosen'])} ({_cell(s['chosen_right'])}) |"
            )
        out += [
            "",
            "| Nothing asked, matched | " + " | ".join(NO_ASK_SETS) + " |",
            "| --- |" + " --- |" * len(NO_ASK_SETS),
        ]
        for name in ("production", "suggested", "phrases", "fallback"):
            cells = [_cell(x["matched"]) for x in r["scores"][name]["false_match"].values()]
            out.append(f"| {MATCHINGS[name]} | " + " | ".join(cells) + " |")
        floors = sorted({p["floor"] for p in r["grid"] if p["floor"] is not None})
        margins = sorted({p["margin"] for p in r["grid"] if p["margin"] is not None})
        points = {(p["floor"], p["margin"]): p for p in r["grid"]}
        out += [
            "",
            "Right / wrong on asks, matched of messages of nothing, on the half the suggestion comes from, by floor and "
            "margin:",
            "",
            "| Floor | " + " | ".join(f"margin {m}" for m in margins) + " |",
            "| --- |" + " --- |" * len(margins),
        ]
        for floor in floors:
            cells = []
            for margin in margins:
                p = points.get((floor, margin)) or {}
                cells.append(
                    f"{_cell(p.get('right'))} / {_cell(p.get('wrong'))}, {_cell(p.get('false_match'))}"
                )
            out.append(f"| {floor} | " + " | ".join(cells) + " |")
    return out


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
    out += search_tables(result.get("search") or [])
    out += matching_tables(result.get("play_matching") or [])
    rerank = result.get("rerank") or {}
    base = rerank.get("base") or {}
    out += [
        "",
        f"Reranking the top 20 of {_cell(base.get('id'))} ({_cell(base.get('dimensions'))}) on "
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
        only = m.get("ambiguous_only")
        if only is not None:
            out.append(
                f"| {m['id']}, only when ambiguous ({_cell(only['share'])} of questions) | {_spread(m['ms'])} | "
                f"{_cell(only['usd_per_thousand_questions'])} | {_quality_cells(only['quality'])} |"
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
