"""Prepare a reproducible, blinded review packet from a complete synthetic run.

The packet is preparation, never evidence that a person reviewed the conversations.
Keep selection metadata separate from the transcript file given to reviewers.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

SEED = "foundry-calibration/2026-11-03.1"


def prepare(
    scenarios: list[dict[str, Any]],
    transcripts: list[dict[str, Any]],
    results: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_id = {row["id"]: row for row in transcripts}
    cases = {row["id"]: row for row in scenarios}
    outcomes = {row["id"]: row for row in results}
    if len(by_id) != len(transcripts) or len(cases) != len(scenarios) or len(outcomes) != len(results):
        raise ValueError("duplicate scenario or transcript id")
    if set(by_id) != set(cases) or set(outcomes) != set(cases):
        raise ValueError("a complete run, including failed scenarios, is required")
    families: dict[int, list[str]] = defaultdict(list)
    for row in scenarios:
        families[row["family"]].append(row["id"])
    if set(families) != set(range(1, 31)) or any(len(v) != 20 for v in families.values()):
        raise ValueError("expected 30 families with 20 distinct scenarios each")
    # Rotate the within-family offsets rather than taking every tenth row (which selects only corrections).
    chosen = set()
    for family, ids in families.items():
        ids.sort()
        offset = (family - 1) % 10
        chosen.update((ids[offset], ids[offset + 10]))
    failures = {sid for sid, row in outcomes.items() if row.get("status") != "passed_protocol"}
    chosen.update(failures)
    ordered = sorted(chosen, key=lambda sid: hashlib.sha256(f"{SEED}:{sid}".encode()).digest())
    packet = [
        {"sampleId": f"H{i:03}", "transcript": by_id[sid]["transcript"], "scores": None}
        for i, sid in enumerate(ordered, 1)
    ]
    metadata = {
        "selectionVersion": SEED,
        "selected": len(ordered),
        "humanReviewed": 0,
        "familyCounts": dict(sorted(Counter(cases[sid]["family"] for sid in ordered).items())),
        "tagCounts": {
            tag: sum(bool(cases[sid]["tags"][tag]) for sid in ordered)
            for tag in ("correction", "conversationControl", "multiSession", "longRunning")
        },
        "failedScenariosIncluded": len(failures),
        "reviewerFile": "human-calibration.jsonl",
        "selectionKey": {row["sampleId"]: sid for row, sid in zip(packet, ordered, strict=True)},
        "boundary": "Blinded synthetic transcripts prepared for review; no human labels or live-model quality claim.",
    }
    return packet, metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    scenarios = [json.loads(s) for s in Path(__file__).with_name("scenarios.jsonl").read_text().splitlines()]
    with gzip.open(args.run_dir / "transcripts.jsonl.gz", "rt") as stream:
        transcripts = [json.loads(s) for s in stream]
    results = [json.loads(s) for s in (args.run_dir / "results.jsonl").read_text().splitlines()]
    packet, metadata = prepare(scenarios, transcripts, results)
    metadata["transcriptsSha256"] = hashlib.sha256(
        (args.run_dir / "transcripts.jsonl.gz").read_bytes()
    ).hexdigest()
    metadata["runId"] = json.loads((args.run_dir / "manifest.json").read_text())["runId"]
    args.output_dir.mkdir(parents=True, exist_ok=False)
    (args.output_dir / "human-calibration.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in packet)
    )
    (args.output_dir / "selection-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"prepared": len(packet), "humanReviewed": 0}))


if __name__ == "__main__":
    main()
