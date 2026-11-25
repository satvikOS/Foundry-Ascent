"""``client-regrade``: every deterministic grader, as it is now, over an earlier run's opened transcripts (offline, no model):
what a new or stricter grader would have said then. The printed table is numbers and grader names only; what failed and
why goes to ``--out`` (private: it quotes the transcripts).

    python -m conversation_lab client-regrade --transcripts <opened>/client/client --day 2026-11-25 --out <dir> \
        [--api-log <opened>/client/logs/api.log] [--labels labels.json]

``--api-log`` (the sealed API log) says, for each failed grader, whether the model's own words failed it too or the
server's. ``--labels`` (``{"AR-01 2.1": 2, ...}``, a person's 1 to 5 for each turn, private) prints how the blocking
graders agree with them.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from conversation_lab.client import reading
from conversation_lab.client.graders import BLOCKING, GRADERS, grade_turn
from conversation_lab.client.judge import Scorecard
from conversation_lab.client.report import grader_rates
from conversation_lab.client.runner import ClientRunner, ScenarioResult, TurnResult
from conversation_lab.client.scenarios import Scenario, load
from conversation_lab.client.strict import STRICT

#: A person's score this low is a reply a professor would be embarrassed by; this high, one they would hand out.
BAD, GOOD = 2, 4


class RegradeError(ValueError):
    """Transcripts that cannot be read (file names and ids only, never content)."""


def read_result(raw: Mapping[str, Any], scenario: Scenario) -> ScenarioResult:
    """One opened transcript as the runner's own result, its turns matched to the scenario's plan by position."""
    result = ScenarioResult(scenario, status=str(raw.get("status", "completed")))
    result.openers = [str(o) for o in raw.get("openers") or []]
    plans = list(scenario.sessions) * scenario.repeat
    for t in raw.get("transcript") or []:
        session, number = (int(x) for x in str(t["at"]).split("."))
        if session > len(plans) or number > len(plans[session - 1].turns):
            raise RegradeError(f"{scenario.id}: turn {t['at']} is not in the scenario")
        turn = TurnResult(
            at=str(t["at"]),
            session=session,
            channel=str(t["channel"]),
            plan=plans[session - 1].turns[number - 1],
            founder=str(t["founder"]),
            reply=str(t.get("reply") or ""),
            kind=str(t.get("kind", "error")),
            error=t.get("error"),
            seconds=float(t.get("seconds") or 0.0),
            first_token_ms=t.get("first_token_ms"),
            cost_usd=t.get("cost_usd"),
            input_tokens=t.get("input_tokens"),
            output_tokens=t.get("output_tokens"),
            model=t.get("model"),
        )
        guidance = t.get("guidance_full")
        turn.guidance = guidance if isinstance(guidance, dict) else None
        turn.evidence = [e for e in t.get("evidence") or [] if isinstance(e, dict)]
        scores = t.get("scores")
        if isinstance(scores, Mapping) and not scores.get("error"):
            turn.card = Scorecard(
                scores=dict(scores.get("scores") or {}),
                raw=dict(scores.get("raw") or {}),
                note=str(t.get("judge_note") or ""),
            )
        result.turns.append(turn)
    return result


def read_folder(folder: Path, scenarios: Mapping[str, Scenario]) -> tuple[list[ScenarioResult], list[str]]:
    """Every transcript of the folder, and the ids of those whose scenario is no longer in the set."""
    found: list[ScenarioResult] = []
    unknown: list[str] = []
    for path in sorted(folder.glob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RegradeError(f"{path.name}: not JSON") from exc
        if not isinstance(raw, dict) or "transcript" not in raw:
            continue
        scenario = scenarios.get(str(raw.get("id")))
        if scenario is None:
            unknown.append(str(raw.get("id")))
            continue
        found.append(read_result(raw, scenario))
    return found, unknown


# What the model wrote and what the server showed -----------------------------------------------------------------------


def model_words(path: Path) -> list[str]:
    """What the model itself wrote, turn by turn (``turn.phase_a`` of the sealed API log)."""
    out = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("event") == "turn.phase_a":
                out.append(str(event.get("replyText") or ""))
    return out


def own_words(reply: str, said: Sequence[str]) -> str | None:
    """The model's text a shown reply came from: the one that shares the most of its sentences (None: no clear one)."""
    mine = {" ".join(reading.words(s)) for s in reading.sentences(reading.plain(reply))}
    mine = {m for m in mine if len(m.split()) >= 3}
    best, score = None, 0.0
    for text in said:
        theirs = {" ".join(reading.words(s)) for s in reading.sentences(reading.plain(text))}
        share = len(mine & theirs) / max(1, min(len(mine), len(theirs)))
        if share > score:
            best, score = text, share
    return best if score >= 0.5 else None


# The report -------------------------------------------------------------------------------------------------------------


@dataclass
class Regraded:
    results: list[ScenarioResult]
    unknown: list[str]
    #: grader -> failures whose model words fail it too, pass it, or could not be matched.
    blame: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def turns(self) -> list[tuple[ScenarioResult, TurnResult]]:
        return [(r, t) for r in self.results for t in r.turns]


def regrade(
    results: Sequence[ScenarioResult],
    unknown: Iterable[str],
    day: dt.date,
    said: Sequence[str] | None = None,
) -> Regraded:
    runner = ClientRunner(app=None, simulator=None, judge=None, today=day, log=lambda _m: None)
    out = Regraded(list(results), sorted(unknown))
    for r in out.results:
        runner.grade(r)
        if said is None:
            continue
        for index, turn in enumerate(r.turns):
            failed = [k for k, g in turn.grades.items() if g.passed is False]
            if not failed:
                continue
            words = own_words(turn.reply, said)
            raw = {} if words is None else grade_turn(replace(runner.reply_turn(r, index), reply=words))
            for name in failed:
                row = out.blame.setdefault(name, {"model": 0, "server": 0, "unknown": 0})
                if words is None:
                    row["unknown"] += 1
                elif (g := raw.get(name)) is not None and g.passed is False:
                    row["model"] += 1
                else:
                    row["server"] += 1
    return out


def summary(done: Regraded) -> dict[str, Any]:
    """Numbers, grader names and scenario ids only."""
    rates = grader_rates(done.results)
    turns = done.turns
    blocked = [(r, t) for r, t in turns if blocking(t)]
    strict = [(r, t) for r, t in turns if any(k in STRICT for k in blocking(t))]
    return {
        "scenarios": len(done.results),
        "not_in_the_set": done.unknown,
        "turns": len(turns),
        "turns_blocked": len(blocked),
        "turns_blocked_by_strict": len(strict),
        "turns_blocked_before": sum(1 for _, t in turns if any(k not in STRICT for k in blocking(t))),
        "graders": {
            k: {**v, "failed": v["applied"] - v["passed"], "strict": k in STRICT, "blocking": k in BLOCKING}
            for k, v in rates.items()
        },
        "blame": done.blame,
        "scenarios_clean": sum(1 for r in done.results if not any(blocking(t) for t in r.turns)),
    }


def blocking(t: TurnResult) -> list[str]:
    return sorted(k for k, g in t.grades.items() if g.passed is False and k in BLOCKING)


def agreement(done: Regraded, labels: Mapping[str, int]) -> dict[str, Any]:
    """How a person's 1 to 5 and the blocking graders agree on the labelled turns."""
    cells = {"bad_caught": 0, "bad_missed": 0, "generic_caught": 0, "generic_passed": 0}
    cells |= {"good_flagged": 0, "good_passed": 0}
    missed, flagged = [], []
    for r, t in done.turns:
        score = labels.get(f"{r.scenario.id} {t.at}")
        if score is None:
            continue
        found = bool(blocking(t))
        if score <= BAD:
            cells["bad_caught" if found else "bad_missed"] += 1
            if not found:
                missed.append(f"{r.scenario.id} {t.at}")
        elif score >= GOOD:
            cells["good_flagged" if found else "good_passed"] += 1
            if found:
                flagged.append(f"{r.scenario.id} {t.at}: {', '.join(blocking(t))}")
        else:
            cells["generic_caught" if found else "generic_passed"] += 1
    decided = cells["bad_caught"] + cells["bad_missed"] + cells["good_flagged"] + cells["good_passed"]
    right = cells["bad_caught"] + cells["good_passed"]
    return {
        **cells,
        "agreement": round(right / decided, 3) if decided else None,
        "missed": missed,
        "flagged": flagged,
    }


def render(found: Mapping[str, Any]) -> str:
    out = [
        f"Scenarios {found['scenarios']}, turns {found['turns']}. Turns with a blocking failure: "
        f"{found['turns_blocked']} (by the earlier graders {found['turns_blocked_before']}, by the strict ones "
        f"{found['turns_blocked_by_strict']}). Scenarios without one: {found['scenarios_clean']}.",
        "",
        "| Grader | Failed / applied | Share | Set | Model's words / server's / unmatched |",
        "| --- | --- | --- | --- | --- |",
    ]
    for name, row in found["graders"].items():
        share = row["failed"] / row["applied"] if row["applied"] else 0.0
        marks = ("strict" if row["strict"] else "earlier") + (", blocking" if row["blocking"] else "")
        blame = found["blame"].get(name)
        said = "-" if blame is None else f"{blame['model']} / {blame['server']} / {blame['unknown']}"
        out.append(f"| {name} | {row['failed']}/{row['applied']} | {share:.0%} | {marks} | {said} |")
    return "\n".join(out) + "\n"


def failures(done: Regraded) -> list[dict[str, Any]]:
    return [
        {
            "scenario": r.scenario.id,
            "at": t.at,
            "grader": k,
            "blocking": k in BLOCKING,
            "why": g.detail,
            "founder": t.founder,
            "reply": t.reply,
        }
        for r, t in done.turns
        for k, g in t.grades.items()
        if g.passed is False
    ]


def read_labels(path: Path) -> dict[str, int]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not all(isinstance(v, int) and 1 <= v <= 5 for v in raw.values()):
        raise RegradeError("the labels are not 1 to 5 by turn")
    return {str(k): v for k, v in raw.items()}


def cmd_regrade(args: argparse.Namespace) -> int:
    folder, out = Path(args.transcripts), Path(args.out)
    if out.resolve().is_relative_to(Path(__file__).resolve().parents[4]):
        print(
            "client-regrade: the output quotes transcripts; write it outside the repository", file=sys.stderr
        )
        return 2
    try:
        day = dt.date.fromisoformat(args.day)
        results, unknown = read_folder(folder, load(day).by_id())
        said = model_words(Path(args.api_log)) if args.api_log else None
        labels = read_labels(Path(args.labels)) if args.labels else None
    except (RegradeError, OSError, ValueError) as exc:
        print(
            f"client-regrade: {exc if isinstance(exc, RegradeError) else type(exc).__name__}", file=sys.stderr
        )
        return 2
    if not results:
        print("client-regrade: no transcript of a scenario in the set was found", file=sys.stderr)
        return 2
    done = regrade(results, unknown, day, said)
    found = summary(done)
    if labels is not None:
        found["agreement"] = agreement(done, labels)
    out.mkdir(parents=True, exist_ok=True)
    (out / "regrade.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
    (out / "regrade-failures.json").write_text(json.dumps(failures(done), indent=1), encoding="utf-8")
    text = render(found)
    (out / "regrade.md").write_text(text, encoding="utf-8")
    print(text)
    if labels is not None:
        print(json.dumps(found["agreement"], indent=1))
    return 0


def add_command(sub: Any) -> None:
    parser = sub.add_parser("client-regrade", help="today's graders over an earlier run's opened transcripts")
    parser.add_argument(
        "--transcripts", required=True, help="the opened client folder (one JSON per scenario)"
    )
    parser.add_argument("--day", required=True, help="the run's day, YYYY-MM-DD")
    parser.add_argument("--api-log", default="", help="that run's opened API log (the model's own words)")
    parser.add_argument("--labels", default="", help="a person's 1 to 5 by turn, as JSON (private)")
    parser.add_argument("--out", required=True, help="a folder outside the repository")
    parser.set_defaults(func=cmd_regrade)


__all__ = ["GRADERS", "Regraded", "agreement", "cmd_regrade", "read_folder", "regrade", "summary"]
