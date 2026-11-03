"""Merge disjoint protocol shards; reject missing, duplicate or differently versioned evidence."""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Any


def combine(runs: list[dict[str, Any]], required_ids: set[str]) -> dict[str, Any]:
    manifests = [r["manifest"] for r in runs]
    first = manifests[0]
    for m in manifests:
        if not m["sourceUnchangedDuringRun"]:
            raise ValueError("source changed during a shard")
        for field in ("sourceSha256", "fixtureSha256", "promptVersion", "model", "liveModel", "code"):
            if m[field] != first[field]:
                raise ValueError("incompatible shard versions")
    results = [row for r in runs for row in r["results"]]
    transcripts = [row for r in runs for row in r["transcripts"]]
    if len({r["id"] for r in results}) != len(results) or len({r["id"] for r in transcripts}) != len(
        transcripts
    ):
        raise ValueError("duplicate scenario evidence")
    if {r["id"] for r in results} != required_ids or {r["id"] for r in transcripts} != required_ids:
        raise ValueError("missing or unexpected scenario evidence")
    for run in runs:
        m, rows = run["manifest"], run["results"]
        if m["scenariosAttempted"] != len(rows) or m["scenariosPassedProtocol"] != sum(
            r["status"] == "passed_protocol" for r in rows
        ):
            raise ValueError("manifest/result counts disagree")
    by_id = {row["id"]: row for row in transcripts}
    for row in results:
        turns = by_id[row["id"]]["transcript"]
        if row["status"] == "passed_protocol" and (
            sum(t["role"] == "student" for t in turns) != row["studentTurns"]
            or sum(t["role"] == "coach" for t in turns) != row["studentTurns"]
        ):
            raise ValueError("completed transcript is incomplete")
    events = sorted(
        (m[field], delta) for m in manifests for field, delta in [("startedAt", 1), ("finishedAt", -1)]
    )
    active = peak = 0
    for _, delta in events:
        active += delta
        peak = max(peak, active)
    manifest = {
        **{
            k: first[k]
            for k in ("code", "sourceSha256", "promptVersion", "fixtureSha256", "model", "liveModel")
        },
        "runId": "merged-" + min(m["startedAt"] for m in manifests),
        "startedAt": min(m["startedAt"] for m in manifests),
        "finishedAt": max(m["finishedAt"] for m in manifests),
        "sourceUnchangedDuringRun": True,
        "concurrency": peak,
        "shardCount": len(runs),
        "isolation": "one disposable database per shard; one distinct venture per scenario",
        "shards": manifests,
        "scenariosAttempted": len(results),
        "scenariosPassedProtocol": sum(r["status"] == "passed_protocol" for r in results),
        "scenariosFailed": sum(r["status"] != "passed_protocol" for r in results),
        "skipped": sum(m["skipped"] for m in manifests),
        "blocked": sum(m["blocked"] for m in manifests),
        "conversationsStarted": sum(m["conversationsStarted"] for m in manifests),
        "conversationsCompleted": sum(m["conversationsCompleted"] for m in manifests),
        "attemptedTurns": sum(m["attemptedTurns"] for m in manifests),
        "completedTurns": sum(m["completedTurns"] for m in manifests),
        "humanReviewed": 0,
        "behavioralScores": None,
    }
    return {
        "manifest": manifest,
        "results": sorted(results, key=lambda r: r["id"]),
        "transcripts": sorted(transcripts, key=lambda r: r["id"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, nargs="+", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    cases = [json.loads(s) for s in Path(__file__).with_name("scenarios.jsonl").read_text().splitlines()]
    runs = []
    for path in args.runs:
        with gzip.open(path / "transcripts.jsonl.gz", "rt") as f:
            transcripts = [json.loads(s) for s in f]
        runs.append(
            {
                "manifest": json.loads((path / "manifest.json").read_text()),
                "results": [json.loads(s) for s in (path / "results.jsonl").read_text().splitlines()],
                "transcripts": transcripts,
            }
        )
    merged = combine(runs, {c["id"] for c in cases})
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in merged["results"]))
    with gzip.open(args.out / "transcripts.jsonl.gz", "wt") as f:
        for row in merged["transcripts"]:
            f.write(json.dumps(row) + "\n")
    (args.out / "run-start.json").write_text(
        json.dumps(
            {
                k: merged["manifest"][k]
                for k in ["runId", "startedAt", "sourceSha256", "promptVersion", "fixtureSha256", "model"]
            },
            indent=2,
        )
        + "\n"
    )
    (args.out / "manifest.json").write_text(json.dumps(merged["manifest"], indent=2) + "\n")
    print(
        json.dumps(
            {
                k: merged["manifest"][k]
                for k in [
                    "runId",
                    "scenariosAttempted",
                    "scenariosPassedProtocol",
                    "scenariosFailed",
                    "completedTurns",
                ]
            }
        )
    )


if __name__ == "__main__":
    main()
