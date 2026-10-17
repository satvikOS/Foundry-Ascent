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

#: Share of a suite's budget the app itself may spend (its own metering, hard-capped by the app's daily cap); the
#: rest is for the lab's own calls (judge, simulator, the founder's synthesized voice). The UI suite makes none.
APP_SHARE: dict[str, float] = {"recall": 0.85, "voice": 0.85, "matrix": 0.55, "ui": 1.0}

#: How a run's budget is split when several suites run (suite=all), by expected spend.
SUITE_WEIGHT: dict[str, int] = {"recall": 1, "voice": 1, "matrix": 2, "ui": 2}

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
    for model in (*simulator, *judge):
        if foundation_model_id(model) not in prices:
            raise ValueError(f"models.json has no price for {model}")
    return LabModels(simulator=simulator, judge=judge, prices=prices)


def polly_usd_per_million_characters(engine: str = "neural", path: Path = SPEECH_VOICES) -> float:
    """The price the app meters Polly at (packages/core/speech-voices.json), so both sides agree."""
    return float(json.loads(path.read_text(encoding="utf-8"))["usdPerMillionCharacters"][engine])


def suites_for(choice: str) -> list[str]:
    if choice == "all":
        return list(SUITES)
    if choice not in SUITES:
        raise ValueError(f"suite must be one of {', '.join((*SUITES, 'all'))}")
    return [choice]


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
