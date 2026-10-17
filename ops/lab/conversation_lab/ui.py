"""The UI suite: the whole Playwright suite (apps/web/e2e) against the real model. The JSON report holds error
messages, which can quote model output, so it stays in the private folder; the public summary keeps counts and
test titles (fixed strings written in the specs)."""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

OUTCOMES = ("expected", "unexpected", "flaky", "skipped")


def _specs(
    suite: Mapping[str, Any], file: str, prefix: tuple[str, ...]
) -> Iterator[tuple[str, str, Mapping[str, Any]]]:
    title = str(suite.get("title", ""))
    path = prefix if title == file or not title else (*prefix, title)
    for spec in suite.get("specs", []):
        yield file, " > ".join((*path, str(spec.get("title", "")))), spec
    for child in suite.get("suites", []):
        yield from _specs(child, file, path)


def summarize(report: Mapping[str, Any]) -> dict[str, Any]:
    per_file: dict[str, dict[str, int]] = {}
    failing: list[dict[str, str]] = []
    flaky: list[dict[str, str]] = []
    totals = dict.fromkeys(OUTCOMES, 0)
    for top in report.get("suites", []):
        file = str(top.get("file") or top.get("title") or "")
        for _, title, spec in _specs(top, file, ()):
            for test in spec.get("tests", []):
                status = str(test.get("status", "skipped"))
                if status not in totals:
                    status = "unexpected"
                totals[status] += 1
                row = per_file.setdefault(file, dict.fromkeys(OUTCOMES, 0))
                row[status] += 1
                entry = {"file": file, "project": str(test.get("projectName", "")), "title": title}
                if status == "unexpected":
                    failing.append(entry)
                elif status == "flaky":
                    flaky.append(entry)
    run = totals["expected"] + totals["unexpected"] + totals["flaky"]
    return {
        "totals": totals,
        "pass_rate": round((totals["expected"] + totals["flaky"]) / run, 4) if run else None,
        "per_file": per_file,
        "failing": failing,
        "flaky": flaky,
        "duration_seconds": round(float(report.get("stats", {}).get("duration", 0)) / 1000, 1),
    }


def load(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
