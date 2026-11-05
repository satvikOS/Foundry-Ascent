"""The blinded human-calibration packet (brief section 17): at least 60 transcripts from a live run's private
outputs, stratified across families and across judge pass/fail, each under a random code with no scores, model
ids, run ids or check results. The key (code -> run, judge scores, check codes) is written separately so the
reviewer never sees it. Everything here is private: it is built locally from the unsealed outputs and never
committed or uploaded.

``agreement`` compares a reviewer's filled form with the judge, per dimension (mean absolute difference and
agreement within one point), and reports how many transcripts a human actually scored; an empty form reports zero.
"""

from __future__ import annotations

import csv
import json
import random
import secrets
from collections import defaultdict
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from conversation_lab.live.dataset import DIMENSIONS, load

PACKET_SIZE = 60


def load_private(dirs: Sequence[Path]) -> list[dict[str, Any]]:
    rows = []
    for d in dirs:
        folder = d / "live" if (d / "live").is_dir() else d
        for path in sorted(folder.glob("*.json")):
            row = json.loads(path.read_text(encoding="utf-8"))
            if row.get("status") == "completed" and row.get("transcript"):
                rows.append(row)
    return rows


def choose(rows: Sequence[dict[str, Any]], size: int, seed: int) -> list[dict[str, Any]]:
    """Round-robin over families, alternating judge-passed and judge-failed runs where both exist."""
    rng = random.Random(seed)  # noqa: S311 - reproducible sampling, not security
    by_family: dict[int, dict[bool, list[dict[str, Any]]]] = defaultdict(lambda: {True: [], False: []})
    for r in rows:
        by_family[int(r["family"])][bool(r.get("passed"))].append(r)
    for groups in by_family.values():
        for lst in groups.values():
            rng.shuffle(lst)
    chosen: list[dict[str, Any]] = []
    families = sorted(by_family)
    want_pass = True
    while len(chosen) < size and any(g[True] or g[False] for g in by_family.values()):
        for f in families:
            g = by_family[f]
            pool = g[want_pass] or g[not want_pass]
            if pool and len(chosen) < size:
                chosen.append(pool.pop())
        want_pass = not want_pass
    return chosen


def build_packet(
    private_dirs: Sequence[Path], out: Path, *, size: int = PACKET_SIZE, seed: int = 1
) -> dict[str, Any]:
    rows = load_private(private_dirs)
    if len(rows) < size:
        raise ValueError(f"only {len(rows)} completed transcripts; the packet needs {size}")
    scenarios = load().by_id()
    chosen = choose(rows, size, seed)
    out.mkdir(parents=True, exist_ok=True)
    key = {}
    with (out / "packet.jsonl").open("w", encoding="utf-8") as fh:
        for row in chosen:
            code = "T-" + secrets.token_hex(3).upper()
            s = scenarios[row["scenario"]].raw
            fh.write(
                json.dumps(
                    {
                        "code": code,
                        "what_to_look_for": {
                            "situation": s["challenge"],
                            "student_objective": s["objective"],
                            "expected": s["expected"],
                            "prohibited": s["prohibited"],
                            "expected_escalation": s["escalation"]["decision"],
                        },
                        "transcript": [
                            {
                                "session": sess["index"],
                                "channel": sess["channel"],
                                "opener": sess.get("opener"),
                                "turns": [
                                    {"student": t["student"], "coach": t["coach"]} for t in sess["turns"]
                                ],
                            }
                            for sess in row["transcript"]
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            key[code] = {
                "run_id": row["run_id"],
                "scenario": row["scenario"],
                "family": row["family"],
                "judge": row.get("judge"),
                "passed": row.get("passed"),
                "check_codes": (row.get("checks") or {}).get("codes"),
            }
    (out / "key.json").write_text(json.dumps(key, indent=1), encoding="utf-8")
    with (out / "form.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["code", *DIMENSIONS, "all_expected_met", "any_prohibited_seen", "reviewer", "notes"])
        for code in key:
            writer.writerow([code] + [""] * (len(DIMENSIONS) + 4))
    return {"transcripts": len(key), "families": len({v["family"] for v in key.values()})}


def agreement(key_path: Path, form_path: Path) -> dict[str, Any]:
    key = json.loads(key_path.read_text(encoding="utf-8"))
    diffs: dict[str, list[int]] = defaultdict(list)
    reviewed = 0
    with form_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            human = {d: row.get(d, "").strip() for d in DIMENSIONS}
            if not any(human.values()):
                continue
            reviewed += 1
            judge = (key.get(row["code"]) or {}).get("judge") or {}
            scores = judge.get("scores") or {}
            for d, value in human.items():
                if value.isdigit() and isinstance(scores.get(d), int):
                    diffs[d].append(abs(int(value) - scores[d]))
    return {
        "human_reviewed": reviewed,
        "per_dimension": {
            d: {
                "n": len(v),
                "mean_abs_diff": round(sum(v) / len(v), 3) if v else None,
                "within_one": round(sum(1 for x in v if x <= 1) / len(v), 3) if v else None,
            }
            for d, v in diffs.items()
        },
    }
