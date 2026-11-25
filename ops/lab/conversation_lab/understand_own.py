"""The understand suite's own cases (``scenarios/understand/*.yaml``): messages invented for it, with what a reading must
hold. They are no client scenario (nothing is played), and half of them are held back: they are read and counted like the
others, but their messages, readings and grades are kept nowhere, so nothing can be changed by looking at them.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from conversation_lab.client.scenarios import ScenarioError
from conversation_lab.config import SCENARIOS_DIR

OWN_DIR = SCENARIOS_DIR / "understand"
#: Names the suite's ``groups`` takes beside the client's: both halves, or one.
OWN_GROUPS = ("own", "ownheld")
_ID = re.compile(r"^U[SR]-[0-9]{2}$")
_TAG = re.compile(r"^[a-z][a-z-]{1,24}$")
_FIELDS = frozenset(
    {
        "id",
        "half",
        "tag",
        "record",
        "talk",
        "say",
        "number",
        "missing",
        "none",
        "no_result",
        "shows",
        "settles",
        "verdicts",
        "referral",
        "no_referral",
        "second",
        "pick",
        "not_pick",
        "first",
        "kind",
    }
)
#: What an own case can be graded on, in the order the tables print it.
OWN_MEASURES = (
    "number",
    "no_figure",
    "missing",
    "no_result",
    "shows",
    "settles",
    "verdict",
    "referral",
    "no_referral",
    "second",
    "pick",
    "first",
    "kind",
)
#: The venture every own case is told in: plain, so that a case rests on its own lines.
VENTURE = {
    "name": "Corner Works",
    "oneLiner": "Small things made and done around town.",
    "stage": "business_model",
    "domain": "consumer",
    "goal": "Find out what is worth doing.",
}
FOUNDER = "Marit Solberg"


@dataclass(frozen=True)
class OwnCase:
    id: str
    held: bool
    tag: str
    say: str
    record: tuple[str, ...] = ()
    talk: tuple[tuple[str, str], ...] = ()
    expect: Mapping[str, Any] = field(default_factory=dict)

    @property
    def group(self) -> str:
        return "ownheld" if self.held else "own"

    @property
    def case_id(self) -> str:
        return f"{self.id}:1.1"


def _words(value: Any, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v.strip() for v in value):
        raise ScenarioError(f"{where}: not a list of strings")
    return tuple(value)


def _case(raw: Any, where: str) -> OwnCase:
    if not isinstance(raw, Mapping) or not {"id", "half", "tag", "say"} <= set(raw) or set(raw) - _FIELDS:
        raise ScenarioError(f"{where}: not a case")
    ident = str(raw["id"])
    if not _ID.match(ident) or raw["half"] not in ("open", "held") or not _TAG.match(str(raw["tag"])):
        raise ScenarioError(f"{where}: not a case")
    talk = raw.get("talk") or []
    if not all(isinstance(t, list) and len(t) == 2 and all(isinstance(x, str) for x in t) for t in talk):
        raise ScenarioError(f"{ident}: talk is pairs")
    expect = {k: v for k, v in raw.items() if k not in ("id", "half", "tag", "say", "record", "talk")}
    for key, value in expect.items():
        if key in ("missing", "none", "no_result", "settles", "no_referral"):
            if value is not True:
                raise ScenarioError(f"{ident}.{key}: only true is said")
        else:
            expect[key] = _words(value, f"{ident}.{key}")
    if not expect:
        raise ScenarioError(f"{ident}: nothing to grade")
    return OwnCase(
        id=ident,
        held=raw["half"] == "held",
        tag=str(raw["tag"]),
        say=str(raw["say"]),
        record=_words(raw["record"], f"{ident}.record") if raw.get("record") else (),
        talk=tuple((t[0], t[1]) for t in talk),
        expect=expect,
    )


def load_own(directory: Path = OWN_DIR) -> list[OwnCase]:
    out: list[OwnCase] = []
    for path in sorted(directory.glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        out += [_case(raw, path.name) for raw in doc["cases"]]
    ids = [c.id for c in out]
    if len(set(ids)) != len(ids):
        raise ScenarioError("an own case's id is used twice")
    return out


def own_case_json(c: OwnCase, day: dt.date) -> dict[str, Any]:
    """The case as lab-understand.ts reads it."""
    return {
        "id": c.case_id,
        "day": day.isoformat(),
        "channel": "text",
        "venture": VENTURE,
        "founder": FOUNDER,
        "record": [
            {"type": "fact", "title": f"Told {i}", "content": text, "daysAgo": 5 + i}
            for i, text in enumerate(c.record, start=1)
        ],
        "said": [],
        "intake": None,
        "history": [{"founder": f, "reply": r} for f, r in c.talk],
        "message": c.say,
    }


# Grading -----------------------------------------------------------------------------------------------------


def _is(value: float, wanted: str) -> bool:
    return abs(value - float(wanted.replace(",", ""))) < 0.006


def _holds(text: str, words: Sequence[str]) -> bool:
    low = text.lower()
    return any(re.search(rf"(?<!\w){re.escape(w.lower())}", low) for w in words)


#: A test of it: a number, and what each side of it means.
_SIDES = re.compile(
    r"\b(?:if|when)\b.*\b(?:if (?:fewer|less|not|none|it)|fewer|less|otherwise|else|below|under)\b"
    r"|\bor more\b.*\b(?:fewer|less|else|otherwise|below|under)\b|\bat least\b.*\b(?:fewer|less|else|otherwise|below|under|if not)\b"
)


def testable(text: str) -> bool:
    low = text.lower()
    counted = re.search(
        r"\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|half)\b", low
    )
    return counted is not None and _SIDES.search(low) is not None


def own_grade(c: OwnCase, u: Mapping[str, Any] | None) -> dict[str, bool]:
    """What a reading of the case got right, by measure; no reading gets nothing right but what it leaves unsaid."""
    e = c.expect
    u = u or {}
    out: dict[str, bool] = {}
    sums = [s for s in u.get("sums") or [] if isinstance(s.get("value"), int | float)]
    asked = [s for s in sums if s.get("asked") is True]
    result = u.get("result") if isinstance(u.get("result"), Mapping) else None
    if "number" in e:
        out["number"] = any(_is(float(s["value"]), n) for s in asked for n in e["number"])
    if "none" in e:
        out["no_figure"] = not asked
    if "missing" in e:
        out["missing"] = not asked and bool(u.get("missing"))
    if "no_result" in e:
        out["no_result"] = bool(u) and result is None
    if "shows" in e:
        out["shows"] = result is not None and _holds(str(result.get("shows") or ""), e["shows"])
    if "settles" in e:
        out["settles"] = result is not None and testable(str(result.get("settles") or ""))
    if "verdicts" in e:
        out["verdict"] = result is not None and result.get("verdict") in e["verdicts"]
    if "referral" in e:
        out["referral"] = u.get("referral") in e["referral"]
    if "no_referral" in e:
        out["no_referral"] = u.get("referral") is None
    if "second" in e:
        out["second"] = _holds(f"{u.get('ask') or ''} | {u.get('secondAsk') or ''}", e["second"]) and bool(
            u.get("secondAsk")
        )
    if "pick" in e:
        choice = u.get("choice") if isinstance(u.get("choice"), Mapping) else {}
        pick = str(choice.get("pick") or "")
        out["pick"] = _holds(pick, e["pick"]) and not _holds(pick, e.get("not_pick", ()))
    if "first" in e:
        points = [p for p in u.get("points") or [] if isinstance(p, str)]
        out["first"] = bool(points) and _holds(points[0], e["first"])
    if "kind" in e:
        out["kind"] = bool({u.get("kind"), *(u.get("also") or [])} & set(e["kind"]))
    return out
