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
#: E-crisis corpus; conversation_lab/safety.py), ``face`` (the HeyGen LiveAvatar FULL stock face against the
#: vendor's free sandbox, with the vendor key; conversation_lab/face.py) and ``models`` (the candidate reasoning,
#: embedding and rerank models, before the app uses any; conversation_lab/models_bench.py).
#: ``understand`` compares the models the understand call of a turn may run on (conversation_lab/understand_bench.py).
EXTRA_SUITES: tuple[str, ...] = ("agenda", "safety", "face", "models", "live", "understand")

#: Share of a suite's budget the app itself may spend (its own metering, hard-capped by the app's daily cap); the
#: rest is for the lab's own calls (judge, simulator, the founder's synthesized voice). The UI suite makes none, nor
#: does the safety suite, whose every call is a screen call on the app's models (lab-safety-screen.ts), nor the face
#: suite (its vendor is the free sandbox; the app meters its calls, and the face at the vendor's list price), nor the
#: models suite (its every call is the script's own, lab-models.ts).
APP_SHARE: dict[str, float] = {
    "recall": 0.85,
    "voice": 0.85,
    "matrix": 0.55,
    "ui": 1.0,
    "agenda": 0.85,
    "safety": 1.0,
    "face": 1.0,
    "models": 1.0,
    "understand": 1.0,
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
    "models": 1,
    "understand": 1,
    "live": 3,
}

#: Largest budget the workflow accepts for one run, in USD (the app's daily cap allows at most 100).
MAX_BUDGET_USD = 50.0
#: Most a models run may be given, whatever was approved: it compares candidates, at an expected USD 0.25
#: (apps/api lab-models.ts refuses more as well).
MODELS_MAX_BUDGET_USD = 2.0
#: The same for an understand run (apps/api lab-understand.ts refuses more as well): the owner's cap on a paid run.
UNDERSTAND_MAX_BUDGET_USD = 2.0


@dataclass(frozen=True)
class BackgroundModels:
    """The background purposes' own models (``models.background``): the safety screen, evaluations, ingestion and
    seeding, on a cheaper model than the coach's."""

    primary: str
    fallback: str
    purposes: tuple[str, ...]


@dataclass(frozen=True)
class UnderstandSettings:
    """The understand call of a turn (``models.understand``, docs/architecture/understand.md): whether it is made, its own
    model and whether that reasons first. Absent from production.json: the API's default, off."""

    enabled: bool
    model_id: str | None = None
    think: str | None = None

    def env(self) -> dict[str, str]:
        return {
            "CORE_UNDERSTAND": "on" if self.enabled else "off",
            **({"MODEL_UNDERSTAND_ID": self.model_id} if self.model_id else {}),
            **({"MODEL_UNDERSTAND_THINK": self.think} if self.think else {}),
        }


@dataclass(frozen=True)
class AppModels:
    """The app's effective models, exactly as infra/cdk/src/lib/models.ts `effectiveModels` derives them: the coach
    (``primary``, ``fallback``: every purpose a founder reads) and the background route, when there is one."""

    primary: str
    fallback: str
    embeddings: str
    background: BackgroundModels | None = None
    understand: UnderstandSettings | None = None

    def env(self) -> dict[str, str]:
        """The gateway's runtime-contract variables (packages/ai router.ts ``modelGatewayConfigFromEnv``)."""
        background = self.background
        return {
            "MODEL_PRIMARY_ID": self.primary,
            "MODEL_FALLBACK_ID": self.fallback,
            "MODEL_EMBEDDINGS_ID": self.embeddings,
            "MODEL_BACKGROUND_PRIMARY_ID": background.primary if background else "",
            "MODEL_BACKGROUND_FALLBACK_ID": background.fallback if background else "",
            "MODEL_BACKGROUND_PURPOSES": ",".join(background.purposes) if background else "",
            **(self.understand.env() if self.understand else {}),
        }

    def for_purpose(self, purpose: str) -> tuple[str, str]:
        """(primary, fallback) the app serves ``purpose`` with."""
        if self.background is not None and purpose in self.background.purposes:
            return self.background.primary, self.background.fallback
        return self.primary, self.fallback


def app_models(path: Path = PRODUCTION_CONFIG) -> AppModels:
    models = json.loads(path.read_text(encoding="utf-8"))["models"]
    raw = models.get("background")
    background = (
        BackgroundModels(primary=raw["primary"], fallback=raw["fallback"], purposes=tuple(raw["purposes"]))
        if isinstance(raw, dict)
        else None
    )
    asked = models.get("understand")
    understand = (
        UnderstandSettings(
            enabled=asked.get("enabled") is True,
            model_id=asked.get("modelId"),
            think=asked.get("think"),
        )
        if isinstance(asked, dict)
        else None
    )
    luna = models.get("luna") or {}
    if luna.get("enabled") is True:
        return AppModels(
            primary=luna["modelId"],
            fallback=models["primary"],
            embeddings=models["embeddings"],
            background=background,
            understand=understand,
        )
    return AppModels(
        primary=models["primary"],
        fallback=models["fallback"],
        embeddings=models["embeddings"],
        background=background,
        understand=understand,
    )


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
    #: Alternative coach models the lab may run the app's coach on for an A/B (``live.coach``; never production's).
    live_coach: tuple[str, ...] = ()
    #: The client suite's judges, in order (the first of another family than the coach's), and the coach models its runs
    #: may put the lab's API process on (``client`` in models.json; never production's).
    client_judge: tuple[str, ...] = ()
    client_coach: tuple[str, ...] = ()
    #: The models the understand call is compared on (``understand`` in models.json), each with its reasoning efforts.
    understand: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @property
    def understand_models(self) -> tuple[str, ...]:
        return tuple(model for model, _ in self.understand)


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
    live_coach = tuple(live.get("coach") or ())
    client = raw.get("client") or {}
    client_judge = tuple(client.get("judge") or ())
    client_coach = tuple(client.get("coach") or ())
    understand = tuple((str(c["id"]), tuple(c["efforts"])) for c in raw.get("understand") or ())
    for model in (
        *(model for model, _ in understand),
        *simulator,
        *judge,
        *live_simulator,
        *live_judge,
        *live_coach,
        *client_judge,
        *client_coach,
    ):
        if foundation_model_id(model) not in prices:
            raise ValueError(f"models.json has no price for {model}")
    return LabModels(
        simulator=simulator,
        judge=judge,
        prices=prices,
        live_simulator=live_simulator,
        live_judge=live_judge,
        live_coach=live_coach,
        client_judge=client_judge,
        client_coach=client_coach,
        understand=understand,
    )


#: The client suite's ``coach_think``: ``default`` (the deployment's own, off unless it says otherwise) or the API
#: process's CORE_THINK (packages/core orchestrator/think.ts): which typed turns let Nova 2 reason before it answers.
DEFAULT_THINK = "default"
THINK_CHOICES: tuple[str, ...] = (DEFAULT_THINK, "off", "judgement", "typed")

#: The client suite's ``understand``: ``default`` (the deployment's own, off unless it says otherwise) or the API process's
#: CORE_UNDERSTAND (packages/core orchestrator/understand.ts); ``understand_model``: its MODEL_UNDERSTAND_ID.
DEFAULT_UNDERSTAND = "default"
UNDERSTAND_CHOICES: tuple[str, ...] = (DEFAULT_UNDERSTAND, "off", "on")


def understand_env(choice: str, model: str, lab: LabModels) -> dict[str, str]:
    """The API process's variables for the client suite's inputs; raises ValueError on one it does not offer."""
    if choice not in UNDERSTAND_CHOICES:
        raise ValueError(f"understand must be one of {', '.join(UNDERSTAND_CHOICES)}")
    named = "" if model in ("", DEFAULT_UNDERSTAND) else model
    if named and named not in lab.understand_models:
        raise ValueError(
            f"understand_model must be {DEFAULT_UNDERSTAND} or one of {', '.join(lab.understand_models)}"
        )
    if named and choice != "on":
        raise ValueError("understand_model is for understand=on")
    if choice == DEFAULT_UNDERSTAND:
        return {}
    return {"CORE_UNDERSTAND": choice, **({"MODEL_UNDERSTAND_ID": named} if named else {})}


#: The ``coach_model`` input that keeps the production model configuration.
DEFAULT_COACH = "default"


def coach_app_models(
    choice: str, lab: LabModels, app: AppModels | None = None, *, offered: Sequence[str] | None = None
) -> AppModels:
    """The app's models for a lab run: production's (``default``), or one of ``offered`` (``live.coach`` in models.json;
    the client suite offers ``client.coach``) as both primary and fallback, so the A/B arm is that model alone (a failure is counted, never answered by another model);
    the background route stays production's (the safety screen is no part of the coach). Production is never changed:
    this is the lab's API process environment only (conversation_lab/stack.py)."""
    base = app or app_models()
    if choice in ("", DEFAULT_COACH):
        return base
    known = tuple(lab.live_coach if offered is None else offered)
    if choice not in known:
        raise ValueError(
            f"coach_model must be {DEFAULT_COACH} or one of {', '.join(known) or '(none listed)'}"
        )
    return AppModels(
        primary=choice,
        fallback=choice,
        embeddings=base.embeddings,
        background=base.background,
        understand=base.understand,
    )


def judges_for(coach_model: str, candidates: Sequence[str]) -> tuple[str, ...]:
    """The judge candidates from another model family than the coach's, in order (evaluator independence: a Claude
    coach is judged by Llama 4 Maverick, then Nova Premier). When every candidate shares the coach's family, all of
    them (the summary then reports ``judge_independent: false``)."""
    family = model_family(coach_model)
    other = tuple(m for m in candidates if model_family(m) != family)
    return other or tuple(candidates)


#: ``judge_model`` choices: ``auto`` (independent of this run's coach; an A/B arm, any coach_model but default, is
#: judged as ``ab``), ``ab`` (independent of every A/B arm: production's coach and every ``live.coach`` model, so both
#: arms of a comparison are graded by the same model), or one ``live.judge`` id.
JUDGE_AUTO = "auto"
JUDGE_AB = "ab"


def ab_arm_models(lab: LabModels, app: AppModels | None = None) -> tuple[str, ...]:
    """Every coach an A/B compares: production's primary and each ``live.coach`` model."""
    base = app or app_models()
    return (base.primary, *lab.live_coach)


def live_judges(
    coach_choice: str, judge_choice: str, lab: LabModels, app: AppModels | None = None
) -> tuple[str, str, tuple[str, ...]]:
    """(policy, coach model, judge candidates in order) for a live run. An A/B pins a judge independent of every arm
    (review of coaching v2: Claude Haiku grading the Nova arm and Llama grading the Claude arms mixed the coach with the
    judge's calibration): with Nova and Claude arms that is Llama 4 Maverick alone, never a Nova fallback, and a run
    whose pinned judge cannot answer stops instead of grading with another. Refuses a named judge of the coach's
    family."""
    base = app or app_models()
    coach = coach_app_models(coach_choice, lab, base).primary
    policy = judge_choice or JUDGE_AUTO
    if policy == JUDGE_AUTO and coach_choice not in ("", DEFAULT_COACH):
        policy = JUDGE_AB
    if policy == JUDGE_AUTO:
        return policy, coach, judges_for(coach, lab.live_judge)
    if policy == JUDGE_AB:
        arms = {model_family(m) for m in ab_arm_models(lab, base)}
        judges = tuple(m for m in lab.live_judge if model_family(m) not in arms)
        if not judges:
            raise ValueError(
                "no live.judge candidate is of another family than every A/B arm "
                f"({', '.join(sorted(arms))}); add one to ops/lab/models.json"
            )
        return policy, coach, judges
    if policy not in lab.live_judge:
        raise ValueError(
            f"judge_model must be {JUDGE_AUTO}, {JUDGE_AB} or one of {', '.join(lab.live_judge)}"
        )
    if model_family(policy) == model_family(coach):
        raise ValueError(f"judge_model {policy} is of the coach's own family ({model_family(coach)})")
    return policy, coach, (policy,)


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
    most = MAX_BUDGET_USD
    if "models" in suites:
        most = MODELS_MAX_BUDGET_USD
    if "understand" in suites:
        most = UNDERSTAND_MAX_BUDGET_USD
    if not 0 < total_usd <= most:
        raise ValueError(f"budget must be more than 0 and at most {most:g} USD")
    weights = sum(SUITE_WEIGHT[s] for s in suites)
    return {s: floor_cents(total_usd * SUITE_WEIGHT[s] / weights) for s in suites}


#: The live suite's app share when the coach runs on a Claude model (``coach_model``): its turns cost about 3.5 times
#: Nova 2 Lite's (conversation_lab/live/plan.py ``coach_cost_factor``), so the app's part of the estimate is about 90%.
LIVE_APP_SHARE_CLAUDE_COACH = 0.9


def budget_parts(suite: str, budget_usd: float, app_share: float | None = None) -> tuple[float, float]:
    """(app share, lab share) of a suite's budget (``app_share`` overrides the suite's own, e.g. for a Claude coach)."""
    share = APP_SHARE[suite] if app_share is None else app_share
    app = floor_cents(budget_usd * share)
    return app, max(0.0, round(budget_usd - app, 2))


#: The client's own test (conversation_lab/client), on its own like the other extra suites: the coach's turns, then the
#: judge of the client's questions and the small adversarial set's simulator.
EXTRA_SUITES += ("client",)
APP_SHARE["client"] = 0.65
SUITE_WEIGHT["client"] = 1
