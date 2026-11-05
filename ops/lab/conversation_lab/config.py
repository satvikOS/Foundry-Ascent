"""Where things are, which models run, and how a run's budget is split (standard library only: the workflow's
plan job imports this module before any dependency is installed)."""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LAB_DIR = REPO / "ops" / "lab"
SCENARIOS_DIR = LAB_DIR / "scenarios"
MODELS_FILE = LAB_DIR / "models.json"
PRODUCTION_CONFIG = REPO / "infra" / "cdk" / "config" / "production.json"
SPEECH_VOICES = REPO / "packages" / "core" / "speech-voices.json"

SUITES: tuple[str, ...] = ("recall", "voice", "matrix", "ui")
#: Suites run on their own, never as part of ``all``: ``agenda`` (a regression: one dominant past-dated notebook
#: commitment; conversation_lab/agenda.py), ``safety`` (the model-based safety screen on the app's models over the
#: E-crisis corpus; conversation_lab/safety.py) and ``face`` (the HeyGen LiveAvatar FULL stock face against the
#: vendor's free sandbox, with the vendor key; conversation_lab/face.py).
EXTRA_SUITES: tuple[str, ...] = ("agenda", "safety", "face", "live")

#: Share of a suite's budget the app itself may spend (its own metering, hard-capped by the app's daily cap); the
#: rest is for the lab's own calls (judge, simulator, the founder's synthesized voice). The UI suite makes none, nor
#: does the safety suite, whose every call is a screen call on the app's models (lab-safety-screen.ts), nor the face
#: suite (its vendor is the free sandbox; the app meters its calls, and the face at the vendor's list price).
APP_SHARE: dict[str, float] = {
    "recall": 0.85,
    "voice": 0.85,
    "matrix": 0.55,
    "ui": 1.0,
    "agenda": 0.85,
    "safety": 1.0,
    "face": 1.0,
    # The live suite: the coach's turns are about three quarters of the estimate (conversation_lab/live/plan.py); the
    # simulator and the judge (lab) the rest.
    "live": 0.75,
}

#: How a run's budget is split when several suites run (suite=all), by expected spend.
SUITE_WEIGHT: dict[str, int] = {
    "recall": 1,
    "voice": 1,
    "matrix": 2,
    "ui": 2,
    "agenda": 1,
    "safety": 1,
    "face": 1,
    "live": 3,
}

#: Largest budget the workflow accepts for one run, in USD (the app's daily cap allows at most 100).
MAX_BUDGET_USD = 50.0


@dataclass(frozen=True)
class AppModels:
    """The app's effective models, exactly as infra/cdk/src/lib/models.ts `effectiveModels` derives them."""

    primary: str
    fallback: str
    embeddings: str


def app_models(path: Path = PRODUCTION_CONFIG) -> AppModels:
    models = json.loads(path.read_text(encoding="utf-8"))["models"]
    luna = models.get("luna") or {}
    if luna.get("enabled") is True:
        return AppModels(primary=luna["modelId"], fallback=models["primary"], embeddings=models["embeddings"])
    return AppModels(primary=models["primary"], fallback=models["fallback"], embeddings=models["embeddings"])


@dataclass(frozen=True)
class Price:
    """USD per million input and output tokens."""

    input: float
    output: float


@dataclass(frozen=True)
class LabModels:
    simulator: tuple[str, ...]
    judge: tuple[str, ...]
    prices: dict[str, Price]
    #: The live suite's own candidates (``live`` in models.json): other model families than the app's first.
    live_simulator: tuple[str, ...] = ()
    live_judge: tuple[str, ...] = ()


def foundation_model_id(model_id: str) -> str:
    """`us.amazon.nova-pro-v1:0` -> `amazon.nova-pro-v1:0` (the price key)."""
    for prefix in ("us.", "global.", "eu.", "apac."):
        if model_id.startswith(prefix):
            return model_id[len(prefix) :]
    return model_id


def lab_models(path: Path = MODELS_FILE) -> LabModels:
    raw = json.loads(path.read_text(encoding="utf-8"))
    prices = {k: Price(float(v["input"]), float(v["output"])) for k, v in raw["usdPerMillionTokens"].items()}
    simulator = tuple(raw["simulator"])
    judge = tuple(raw["judge"])
    live = raw.get("live") or {}
    live_simulator = tuple(live.get("simulator") or ())
    live_judge = tuple(live.get("judge") or ())
    for model in (*simulator, *judge, *live_simulator, *live_judge):
        if foundation_model_id(model) not in prices:
            raise ValueError(f"models.json has no price for {model}")
    return LabModels(
        simulator=simulator,
        judge=judge,
        prices=prices,
        live_simulator=live_simulator,
        live_judge=live_judge,
    )


def model_family(model_id: str) -> str:
    """`us.anthropic.claude-…` -> `anthropic`; `mock` -> `mock` (the provider is the family that matters for
    evaluator independence)."""
    base = foundation_model_id(model_id)
    return base.split(".", 1)[0] if "." in base else base


def polly_usd_per_million_characters(engine: str = "neural", path: Path = SPEECH_VOICES) -> float:
    """The price the app meters Polly at (packages/core/speech-voices.json), so both sides agree."""
    return float(json.loads(path.read_text(encoding="utf-8"))["usdPerMillionCharacters"][engine])


def suites_for(choice: str) -> list[str]:
    if choice == "all":
        return list(SUITES)
    if choice not in (*SUITES, *EXTRA_SUITES):
        raise ValueError(f"suite must be one of {', '.join((*SUITES, *EXTRA_SUITES, 'all'))}")
    return [choice]


#: The face suite's in-app call arm, by the app's face mode (``--face-mode``, the workflow's ``face_mode``): ``full``
#: (a stock avatar voices our admitted text), ``lite`` (the avatar lip-syncs our Polly audio, sent over the server's
#: speak socket) or ``both`` (the default: FULL first with every sandbox check, then the API restarted in LITE for
#: the same call arm, so the two are compared side by side with Polly alone). ``lite-probe`` runs no call arm: only the
#: LITE protocol probe (apps/web/e2e/lab/lite-probe.lab.ts, conversation_lab/lite_probe.py), raw LITE sandbox sessions
#: whose ``ws_url`` the lab's page drives itself (the API keeps its FULL sandbox configuration; the probe mints them).
FACE_MODES: tuple[str, ...] = ("both", "full", "lite", "lite-probe")


def face_passes(choice: str) -> list[str]:
    """The face suite's passes, in order (``both``: FULL, then LITE; ``lite-probe``: the probe alone)."""
    if choice not in FACE_MODES:
        raise ValueError(f"face mode must be one of {', '.join(FACE_MODES)}")
    return ["full", "lite"] if choice == "both" else [choice]


def floor_cents(value: float) -> float:
    return math.floor(value * 100 + 1e-9) / 100


def split_budget(total_usd: float, suites: Sequence[str]) -> dict[str, float]:
    """Each suite's hard cap, in proportion to its weight, rounded down to the cent (the sum never exceeds the
    total)."""
    if not 0 < total_usd <= MAX_BUDGET_USD:
        raise ValueError(f"budget must be more than 0 and at most {MAX_BUDGET_USD:g} USD")
    weights = sum(SUITE_WEIGHT[s] for s in suites)
    return {s: floor_cents(total_usd * SUITE_WEIGHT[s] / weights) for s in suites}


def budget_parts(suite: str, budget_usd: float) -> tuple[float, float]:
    """(app share, lab share) of a suite's budget."""
    app = floor_cents(budget_usd * APP_SHARE[suite])
    return app, max(0.0, round(budget_usd - app, 2))
