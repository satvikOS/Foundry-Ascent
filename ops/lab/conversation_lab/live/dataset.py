"""The live scenario dataset (ops/lab/scenarios/live/fNN-*.yaml): loading, strict schema validation and the overlap
report the brief asks for (multi-session, long-running, corrections, interruptions).

Every field a scenario carries is authored content for that scenario. The derived properties (how many sessions,
how many turns, whether it involves a correction or an interruption) are computed from its sessions and its arc
beats, never declared, so the overlap report cannot be claimed without the content that earns it.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from conversation_lab.config import SCENARIOS_DIR

LIVE_DIR = SCENARIOS_DIR / "live"
#: Bumped whenever the schema (not the content) changes.
SCHEMA_VERSION = "live-scenarios/1"

#: The brief's table (section 16): number -> (slug, family, required focus).
FAMILIES: dict[int, tuple[str, str, str]] = {
    1: (
        "incomplete-ideas",
        "Incomplete ideas",
        "Unclear problems, curiosity, and appropriate pre-venture routing",
    ),
    2: ("first-time-founders", "First-time founders", "Plain explanations and useful scaffolding"),
    3: ("experienced-founders", "Experienced founders", "Efficient coaching without beginner lectures"),
    4: (
        "technical-researchers",
        "Technical researchers",
        "Commercialization gaps despite strong domain knowledge",
    ),
    5: ("software", "Software ventures", "Users, distribution, alternatives, retention, and monetization"),
    6: ("services", "Service businesses", "Delivery capacity, customer fit, pricing, and repeatability"),
    7: ("marketplaces", "Marketplaces", "Two-sided adoption, liquidity, incentives, and sequencing"),
    8: ("physical-products", "Physical products", "Prototypes, manufacturing assumptions, cost, and access"),
    9: (
        "regulated",
        "Medical and regulated ventures",
        "Evidence boundaries and appropriate specialist routing",
    ),
    10: (
        "buyer-user-payer",
        "Buyer-user-payer differences",
        "Procurement, budget ownership, and stakeholder conflicts",
    ),
    11: ("weak-evidence", "Weak evidence", "Compliments, unsupported claims, and misleading validation"),
    12: (
        "stronger-evidence",
        "Stronger evidence",
        "Behavior, payment, repeat use, and calibrated conclusions",
    ),
    13: (
        "customer-discovery",
        "Customer discovery",
        "Leading questions, biased samples, and conflicting interviews",
    ),
    14: ("pricing", "Pricing and economics", "Inconsistent assumptions and realistic next tests"),
    15: ("pivots", "Pivots", "Material changes to the problem, customer, solution, or model"),
    16: ("continuity", "Longitudinal continuity", "Resuming without repetitive intake"),
    17: (
        "memory-correction",
        "Memory correction",
        "Contradictions, rejected memory, deletion, and stale summaries",
    ),
    18: ("team-dynamics", "Team dynamics", "Disagreement, ownership, departures, and incomplete consensus"),
    19: ("student-learning", "Student learning", "Changing explanation depth as competence develops"),
    20: (
        "constraints",
        "Time and resource constraints",
        "Deadlines, coursework, limited budgets, and inaccessible users",
    ),
    21: ("pitch-rehearsal", "Pitch rehearsal", "Role-play, interruptions, and focused feedback"),
    22: (
        "messy-language",
        "Ambiguity and messy language",
        "Fragments, typos, slang, digressions, and implied answers",
    ),
    23: ("frustration", "Frustration and disagreement", "Correction, impatience, skepticism, and repair"),
    24: (
        "confidence-extremes",
        "Confidence extremes",
        "Overclaiming, discouragement, and proportionate challenge",
    ),
    25: (
        "conversation-control",
        "Conversation control",
        "Topic changes, short answers, stopping, and resuming",
    ),
    26: ("voice", "Voice-specific conversation", "Pauses, backchannels, self-correction, and interruptions"),
    27: (
        "retrieval-tools",
        "Retrieval and tools",
        "Missing, conflicting, stale, delayed, or unavailable evidence",
    ),
    28: ("escalation", "Human escalation", "IP, financing, regulatory issues, conflicts, and distress"),
    29: (
        "isolation",
        "Isolation and adversarial content",
        "Prompt injection, unauthorized access, and context leakage",
    ),
    30: (
        "recovery",
        "Recovery and long sessions",
        "Disconnects, retries, duplicate events, and degraded providers",
    ),
}
PER_FAMILY = 20

STAGES = frozenset(
    {"idea", "discovery", "validation", "business_model", "commercialization", "growth", "transition"}
)
DOMAINS = frozenset(
    {"consumer", "software", "hardware", "biomedical", "clinical", "energy", "social", "general"}
)
LEVELS = frozenset({"first_time", "some_experience", "experienced", "researcher"})
CHANNELS = frozenset({"chat", "call"})
MEMORY_TYPES = frozenset(
    {
        "fact",
        "hypothesis",
        "decision",
        "experiment",
        "evidence",
        "action",
        "milestone",
        "risk",
        "preference",
        "relationship",
        "insight",
    }
)
#: What the vEIR should do about humans: nothing, mention the option, hand the case to a human EIR or specialist,
#: route to pre-venture or programme resources, refuse the request, or take the crisis-support path.
ESCALATIONS = frozenset({"none", "offer", "handoff", "route", "refuse", "crisis"})
#: The judge's twelve rubric dimensions (brief section 19), in the brief's order.
DIMENSIONS: tuple[str, ...] = (
    "understanding_intent",
    "relevance_directness",
    "diagnostic_quality",
    "evidence_calibration",
    "adaptation",
    "memory_correctness",
    "non_redundancy",
    "natural_flow",
    "actionability",
    "escalation",
    "recovery",
    "voice_turn_taking",
)

#: The student's scripted behaviours over the conversation ("arc beats"). The simulator weaves each into its reply
#: at (or soon after) its turn, in its own words, in response to what the coach actually said. ``memory_*`` beats at
#: turn 0 are actions the runner takes in the app before that session starts (the student reviewing their memory).
BEAT_KINDS = frozenset(
    {
        "hesitation",
        "correction",
        "contradiction",
        "change_of_mind",
        "new_evidence",
        "reveal",
        "interrupt",
        "topic_change",
        "return",
        "incomplete",
        "short_answers",
        "digression",
        "self_correction",
        "backchannel",
        "pause",
        "stop",
        "resume",
        "repeat_request",
        "frustration",
        "pushback",
        "overclaim",
        "discouraged",
        "asks_bot",
        "injection",
        "access_attempt",
        "distress",
        "roleplay",
        "deadline",
        "team_change",
        "disconnect",
        "duplicate",
        "retry",
        "memory_reject",
        "memory_delete",
        "memory_correct",
        "asks_direct",
        "wrap_up",
    }
)
CORRECTION_KINDS = frozenset(
    {"correction", "contradiction", "change_of_mind", "memory_reject", "memory_delete", "memory_correct"}
)
INTERRUPTION_KINDS = frozenset(
    {"interrupt", "topic_change", "return", "incomplete", "digression", "resume", "stop"}
)
#: Runner actions before a session (turn 0).
MEMORY_ACTIONS = frozenset({"memory_reject", "memory_delete", "memory_correct"})

SCENARIO_ID = re.compile(r"^LV-(\d{2})-(\d{2})$")
BEAT_AT = re.compile(r"^(\d{1,2})\.(\d{1,2})$")
#: A substantive scenario has at least this many student turns (brief section 16).
MIN_TURNS = 8
#: "Long-running": at least this many conversational turns in total (student turns plus the coach's replies).
LONG_TOTAL_TURNS = 50
MULTI_SESSIONS = 3

_TOP = {
    "id",
    "version",
    "title",
    "challenge",
    "venture",
    "student",
    "purpose",
    "sessions",
    "priorMemory",
    "documents",
    "neighbour",
    "objective",
    "constraints",
    "hidden",
    "arc",
    "sources",
    "branches",
    "expected",
    "prohibited",
    "memoryChanges",
    "escalation",
    "scoring",
    "short",
}
_REQUIRED_TOP = _TOP - {"documents", "neighbour", "short"}


class DatasetError(ValueError):
    """The dataset breaks its schema; the message lists every problem found."""


@dataclass(frozen=True)
class Session:
    gap_days: int
    turns: int
    channel: str


@dataclass(frozen=True)
class Beat:
    session: int
    turn: int
    kind: str
    text: str

    @property
    def at(self) -> str:
        return f"{self.session}.{self.turn}"


@dataclass(frozen=True)
class Scenario:
    id: str
    family: int
    raw: Mapping[str, Any]
    sessions: tuple[Session, ...]
    arc: tuple[Beat, ...]

    @property
    def title(self) -> str:
        return str(self.raw["title"])

    @property
    def student_turns(self) -> int:
        return sum(s.turns for s in self.sessions)

    @property
    def total_turns(self) -> int:
        """Student turns plus the coach's replies to them (session openers are not counted)."""
        return 2 * self.student_turns

    @property
    def multi_session(self) -> bool:
        return len(self.sessions) >= MULTI_SESSIONS

    @property
    def long_running(self) -> bool:
        return self.total_turns >= LONG_TOTAL_TURNS

    @property
    def correction(self) -> bool:
        return any(b.kind in CORRECTION_KINDS for b in self.arc)

    @property
    def interruption(self) -> bool:
        return any(b.kind in INTERRUPTION_KINDS for b in self.arc)

    @property
    def voice(self) -> bool:
        return any(s.channel == "call" for s in self.sessions)

    @property
    def escalation(self) -> str:
        return str(self.raw["escalation"]["decision"])

    def beats_for(self, session: int, turn: int) -> list[Beat]:
        return [b for b in self.arc if b.session == session and b.turn == turn]

    def memory_actions(self, session: int) -> list[Beat]:
        return [b for b in self.arc if b.session == session and b.turn == 0 and b.kind in MEMORY_ACTIONS]


@dataclass
class Dataset:
    scenarios: list[Scenario]
    sha256: str
    files: dict[str, str] = field(default_factory=dict)

    def by_id(self) -> dict[str, Scenario]:
        return {s.id: s for s in self.scenarios}

    def family(self, number: int) -> list[Scenario]:
        return [s for s in self.scenarios if s.family == number]


def memory_target(text: str) -> str:
    """The priorMemory title a memory action acts on (``Title`` or ``Title => corrected content``)."""
    return text.split(" => ", 1)[0].strip()


def memory_correction(text: str) -> str | None:
    return text.split(" => ", 1)[1].strip() if " => " in text else None


def _text(value: Any, path: str, problems: list[str], *, min_len: int = 3, max_len: int = 600) -> None:
    if not isinstance(value, str) or not min_len <= len(value.strip()) <= max_len:
        problems.append(f"{path}: must be text of {min_len} to {max_len} characters")


def _texts(
    value: Any, path: str, problems: list[str], *, min_items: int, max_items: int, max_len: int = 400
) -> None:
    if not isinstance(value, list) or not min_items <= len(value) <= max_items:
        problems.append(f"{path}: must list {min_items} to {max_items} items")
        return
    for i, item in enumerate(value):
        _text(item, f"{path}[{i}]", problems, max_len=max_len)
    lowered = [str(v).strip().lower() for v in value]
    if len(set(lowered)) != len(lowered):
        problems.append(f"{path}: repeats an item")


def _mapping(
    value: Any, path: str, keys: set[str], problems: list[str], *, optional: frozenset[str] = frozenset()
) -> Mapping[str, Any] | None:
    if not isinstance(value, dict):
        problems.append(f"{path}: must be a mapping")
        return None
    extra = set(value) - keys
    missing = keys - optional - set(value)
    if extra:
        problems.append(f"{path}: unknown keys {sorted(extra)}")
    if missing:
        problems.append(f"{path}: missing keys {sorted(missing)}")
    return value


def validate_scenario(raw: Any, family: int, problems: list[str]) -> Scenario | None:
    if not isinstance(raw, dict):
        problems.append(f"family {family}: a scenario is not a mapping")
        return None
    sid = str(raw.get("id", "?"))
    p = f"{sid}"
    extra = set(raw) - _TOP
    missing = _REQUIRED_TOP - set(raw)
    if extra:
        problems.append(f"{p}: unknown keys {sorted(extra)}")
    if missing:
        problems.append(f"{p}: missing keys {sorted(missing)}")
        return None
    found = SCENARIO_ID.match(sid)
    if not found or int(found.group(1)) != family or not 1 <= int(found.group(2)) <= PER_FAMILY:
        problems.append(f"{p}: id must be LV-{family:02d}-01..{PER_FAMILY:02d}")
    if not isinstance(raw["version"], int) or raw["version"] < 1:
        problems.append(f"{p}.version: must be a positive whole number")
    _text(raw["title"], f"{p}.title", problems, min_len=12, max_len=140)
    _text(raw["challenge"], f"{p}.challenge", problems, min_len=30, max_len=400)
    venture = _mapping(
        raw["venture"], f"{p}.venture", {"name", "oneLiner", "stage", "domain", "archetype"}, problems
    )
    if venture is not None:
        _text(venture.get("name"), f"{p}.venture.name", problems, min_len=2, max_len=60)
        _text(venture.get("oneLiner"), f"{p}.venture.oneLiner", problems, min_len=10, max_len=280)
        _text(venture.get("archetype"), f"{p}.venture.archetype", problems, min_len=3, max_len=60)
        if venture.get("stage") not in STAGES:
            problems.append(f"{p}.venture.stage: must be one of {sorted(STAGES)}")
        if venture.get("domain") not in DOMAINS:
            problems.append(f"{p}.venture.domain: must be one of {sorted(DOMAINS)}")
    student = _mapping(raw["student"], f"{p}.student", {"name", "level", "discipline", "style"}, problems)
    if student is not None:
        _text(student.get("name"), f"{p}.student.name", problems, min_len=3, max_len=60)
        _text(student.get("discipline"), f"{p}.student.discipline", problems, max_len=120)
        _text(student.get("style"), f"{p}.student.style", problems, min_len=8, max_len=200)
        if student.get("level") not in LEVELS:
            problems.append(f"{p}.student.level: must be one of {sorted(LEVELS)}")
    _text(raw["purpose"], f"{p}.purpose", problems, max_len=80)
    sessions: list[Session] = []
    if not isinstance(raw["sessions"], list) or not 1 <= len(raw["sessions"]) <= 6:
        problems.append(f"{p}.sessions: must list 1 to 6 sessions")
    else:
        for i, s in enumerate(raw["sessions"]):
            m = _mapping(s, f"{p}.sessions[{i}]", {"gap", "turns", "channel"}, problems)
            if m is None:
                continue
            gap, turns, channel = m.get("gap"), m.get("turns"), m.get("channel")
            if not isinstance(gap, int) or not 0 <= gap <= 120 or (i == 0) != (gap == 0):
                problems.append(f"{p}.sessions[{i}].gap: days since the last session (0 only for the first)")
            if not isinstance(turns, int) or not 1 <= turns <= 40:
                problems.append(f"{p}.sessions[{i}].turns: must be 1 to 40 student turns")
            if channel not in CHANNELS:
                problems.append(f"{p}.sessions[{i}].channel: must be chat or call")
            if isinstance(gap, int) and isinstance(turns, int) and channel in CHANNELS:
                sessions.append(Session(gap, turns, str(channel)))
    if sessions and sum(s.turns for s in sessions) < MIN_TURNS and not raw.get("short"):
        problems.append(f"{p}: fewer than {MIN_TURNS} student turns needs a 'short' reason")
    if raw.get("short") is not None:
        _text(raw["short"], f"{p}.short", problems, min_len=20, max_len=300)
    memory = raw["priorMemory"]
    if not isinstance(memory, list) or len(memory) > 6:
        problems.append(f"{p}.priorMemory: must list 0 to 6 items")
    else:
        for i, item in enumerate(memory):
            m = _mapping(item, f"{p}.priorMemory[{i}]", {"type", "title", "content"}, problems)
            if m is None:
                continue
            if m.get("type") not in MEMORY_TYPES:
                problems.append(f"{p}.priorMemory[{i}].type: must be one of {sorted(MEMORY_TYPES)}")
            _text(m.get("title"), f"{p}.priorMemory[{i}].title", problems, max_len=200)
            _text(m.get("content"), f"{p}.priorMemory[{i}].content", problems, min_len=10, max_len=600)
    if "documents" in raw:
        docs = raw["documents"]
        if not isinstance(docs, list) or not 1 <= len(docs) <= 3:
            problems.append(f"{p}.documents: must list 1 to 3 documents")
        else:
            for i, d in enumerate(docs):
                m = _mapping(d, f"{p}.documents[{i}]", {"name", "text"}, problems)
                if m is not None:
                    _text(m.get("name"), f"{p}.documents[{i}].name", problems, max_len=80)
                    _text(m.get("text"), f"{p}.documents[{i}].text", problems, min_len=40, max_len=4000)
    if "neighbour" in raw:
        m = _mapping(raw["neighbour"], f"{p}.neighbour", {"venture", "founder", "secret"}, problems)
        if m is not None:
            for key in ("venture", "founder", "secret"):
                _text(m.get(key), f"{p}.neighbour.{key}", problems, min_len=3, max_len=300)
    _text(raw["objective"], f"{p}.objective", problems, min_len=20, max_len=400)
    _texts(raw["constraints"], f"{p}.constraints", problems, min_items=1, max_items=5)
    _texts(raw["hidden"], f"{p}.hidden", problems, min_items=1, max_items=6)
    beats: list[Beat] = []
    if not isinstance(raw["arc"], list) or not 1 <= len(raw["arc"]) <= 12:
        problems.append(f"{p}.arc: must list 1 to 12 beats")
    else:
        for i, beat in enumerate(raw["arc"]):
            if not (isinstance(beat, list) and len(beat) == 3 and all(isinstance(x, str) for x in beat)):
                problems.append(f'{p}.arc[{i}]: must be ["session.turn", kind, text]')
                continue
            at, kind, text = beat
            found_at = BEAT_AT.match(at)
            if kind not in BEAT_KINDS:
                problems.append(f"{p}.arc[{i}]: unknown kind {kind!r}")
            _text(text, f"{p}.arc[{i}].text", problems, min_len=8, max_len=300)
            if not found_at:
                problems.append(f"{p}.arc[{i}]: 'at' must be session.turn")
                continue
            s_no, t_no = int(found_at.group(1)), int(found_at.group(2))
            if not 1 <= s_no <= len(sessions):
                problems.append(f"{p}.arc[{i}]: session {s_no} does not exist")
                continue
            limit = sessions[s_no - 1].turns
            if t_no == 0 and kind not in MEMORY_ACTIONS:
                problems.append(f"{p}.arc[{i}]: turn 0 is only for memory actions before a session")
            if t_no > limit:
                problems.append(f"{p}.arc[{i}]: turn {t_no} is past the session's {limit} turns")
            if kind in MEMORY_ACTIONS and t_no != 0:
                problems.append(f"{p}.arc[{i}]: memory actions happen before a session (turn 0)")
            if kind in MEMORY_ACTIONS:
                titles = {str(m.get("title")) for m in raw["priorMemory"] if isinstance(m, dict)}
                target = memory_target(text)
                if target not in titles:
                    problems.append(
                        f"{p}.arc[{i}]: a memory action names a priorMemory title ('Title' or 'Title => new content')"
                    )
                if kind == "memory_correct" and " => " not in text:
                    problems.append(f"{p}.arc[{i}]: memory_correct needs 'Title => corrected content'")
            beats.append(Beat(s_no, t_no, kind, text))
    # null: retrieval behaves normally and the venture has no documents (stated only when something is special).
    if raw["sources"] is not None:
        _text(raw["sources"], f"{p}.sources", problems, min_len=8, max_len=400)
    _texts(raw["branches"], f"{p}.branches", problems, min_items=2, max_items=4)
    _texts(raw["expected"], f"{p}.expected", problems, min_items=2, max_items=6)
    _texts(raw["prohibited"], f"{p}.prohibited", problems, min_items=2, max_items=5)
    _texts(raw["memoryChanges"], f"{p}.memoryChanges", problems, min_items=1, max_items=4)
    esc = _mapping(raw["escalation"], f"{p}.escalation", {"decision", "to", "why"}, problems)
    if esc is not None:
        if esc.get("decision") not in ESCALATIONS:
            problems.append(f"{p}.escalation.decision: must be one of {sorted(ESCALATIONS)}")
        if esc.get("to") is not None:
            _text(esc.get("to"), f"{p}.escalation.to", problems, max_len=120)
        if esc.get("decision") in ("handoff", "route", "crisis") and not esc.get("to"):
            problems.append(f"{p}.escalation.to: a handoff, route or crisis names where to")
        if esc.get("decision") != "none" or esc.get("why") is not None:
            _text(esc.get("why"), f"{p}.escalation.why", problems, min_len=10, max_len=300)
    scoring = _mapping(raw["scoring"], f"{p}.scoring", {"focus", "pass"}, problems)
    if scoring is not None:
        focus = scoring.get("focus")
        if not isinstance(focus, list) or not 1 <= len(focus) <= 5 or not set(focus) <= set(DIMENSIONS):
            problems.append(f"{p}.scoring.focus: 1 to 5 of {list(DIMENSIONS)}")
        _text(scoring.get("pass"), f"{p}.scoring.pass", problems, min_len=20, max_len=300)
    if not found:
        return None
    return Scenario(id=sid, family=family, raw=raw, sessions=tuple(sessions), arc=tuple(beats))


def family_file(number: int, directory: Path = LIVE_DIR) -> Path:
    return directory / f"f{number:02d}-{FAMILIES[number][0]}.yaml"


def load(directory: Path = LIVE_DIR, *, families: Iterable[int] | None = None) -> Dataset:
    """Loads and validates the dataset (every family, or only ``families``); raises DatasetError listing every
    problem."""
    wanted = sorted(set(families)) if families is not None else sorted(FAMILIES)
    problems: list[str] = []
    scenarios: list[Scenario] = []
    digest = hashlib.sha256()
    files: dict[str, str] = {}
    for number in wanted:
        if number not in FAMILIES:
            problems.append(f"no family {number}")
            continue
        path = family_file(number, directory)
        if not path.is_file():
            problems.append(f"{path.name}: missing")
            continue
        data = path.read_bytes()
        digest.update(path.name.encode() + b"\0" + data)
        files[path.name] = hashlib.sha256(data).hexdigest()
        doc = yaml.safe_load(data)
        m = _mapping(doc, path.name, {"family", "slug", "scenarios"}, problems)
        if m is None:
            continue
        if m.get("family") != number or m.get("slug") != FAMILIES[number][0]:
            problems.append(f"{path.name}: family/slug do not match the file")
        items = m.get("scenarios")
        if not isinstance(items, list):
            problems.append(f"{path.name}: scenarios must be a list")
            continue
        found = [validate_scenario(item, number, problems) for item in items]
        family_scenarios = [s for s in found if s is not None]
        if families is None and len(items) != PER_FAMILY:
            problems.append(f"{path.name}: has {len(items)} scenarios, needs {PER_FAMILY}")
        scenarios += family_scenarios
    ids = [s.id for s in scenarios]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        problems.append(f"duplicate ids: {dupes}")
    if problems:
        raise DatasetError("\n".join(problems))
    return Dataset(scenarios=sorted(scenarios, key=lambda s: s.id), sha256=digest.hexdigest(), files=files)


def overlap(scenarios: Sequence[Scenario]) -> dict[str, Any]:
    """The brief's four groups (they may overlap), their sizes, and every intersection, from derived properties."""
    groups = {
        "multi_session_3plus": [s.id for s in scenarios if s.multi_session],
        "long_running_50plus_turns": [s.id for s in scenarios if s.long_running],
        "corrections_or_contradictions": [s.id for s in scenarios if s.correction],
        "interruptions_or_topic_changes": [s.id for s in scenarios if s.interruption],
    }
    names = list(groups)
    pairs = {}
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            pairs[f"{a} & {b}"] = len(set(groups[a]) & set(groups[b]))
    all_four = set.intersection(*(set(v) for v in groups.values())) if groups else set()
    in_any = set().union(*(set(v) for v in groups.values()))
    return {
        "scenarios": len(scenarios),
        "counts": {k: len(v) for k, v in groups.items()},
        "required": {
            "multi_session_3plus": 60,
            "long_running_50plus_turns": 20,
            "corrections_or_contradictions": 100,
            "interruptions_or_topic_changes": 100,
        },
        "pairwise_overlap": pairs,
        "in_all_four": len(all_four),
        "in_none": len(scenarios) - len(in_any),
        "voice_scenarios": sum(1 for s in scenarios if s.voice),
        "student_turns": sum(s.student_turns for s in scenarios),
        "short_by_design": sorted(s.id for s in scenarios if s.raw.get("short")),
        "definition": (
            "multi-session = 3+ sessions; long-running = student turns + coach replies >= 50; corrections = an arc "
            "beat of kind correction, contradiction, change_of_mind or a memory reject/delete/correct; interruptions "
            "= an arc beat of kind interrupt, topic_change, return, incomplete, digression, stop or resume"
        ),
    }


def overlap_shortfalls(report: Mapping[str, Any]) -> list[str]:
    return [
        f"{k}: {report['counts'][k]} < {need}"
        for k, need in report["required"].items()
        if report["counts"][k] < need
    ]
