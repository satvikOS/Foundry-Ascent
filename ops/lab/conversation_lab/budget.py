"""The spend guard: a run never spends more than its budget.

Two meters, each with its own share of the suite's budget:

* the app's own metering (the usage ledger behind ``GET /admin/usage``: model turns, distillation, embeddings,
  Amazon Polly characters and Amazon Transcribe seconds, priced exactly as production prices them). The lab sets
  the app's daily platform cap to the app share before anything runs, so the app itself refuses the turn that
  would go over (``spend_cap_reached``); the guard also stops scheduling new scenarios before that.
* the lab's own calls (simulator, judge, the founder's synthesized voice), metered here from the token and
  character counts each response reports, at the prices in ops/lab/models.json and packages/core/
  speech-voices.json, rounded up to the micro-dollar like the app's ledger. A call is refused before it is made
  when its worst case (the most it can be billed: its input plus ``max_tokens`` of output) would not fit.

The ledger file holds model ids, purposes, counts and dollars only (public-safe).
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from conversation_lab.config import Price


def micro_ceil(usd: float) -> float:
    """Rounds up to the micro-dollar (the app's numeric(10, 6) ledger), so tiny calls never round to zero."""
    if usd <= 0:
        return 0.0
    return math.ceil(usd * 1_000_000 - 1e-6) / 1_000_000


def token_cost(price: Price, input_tokens: int, output_tokens: int) -> float:
    return micro_ceil((max(0, input_tokens) * price.input + max(0, output_tokens) * price.output) / 1_000_000)


def estimate_tokens(text: str) -> int:
    """A deliberately high token estimate (about 3 characters a token; real English is closer to 4)."""
    return math.ceil(len(text) / 3) + 16


@dataclass(frozen=True)
class Charge:
    kind: str  # "bedrock" | "polly"
    purpose: str  # "probe" | "simulator" | "judge" | "voice"
    model: str
    units_in: int  # tokens, or characters for Polly
    units_out: int
    usd: float


class BudgetExceededError(Exception):
    """The next step would go over the budget. ``side`` is ``app`` or ``lab``."""

    def __init__(self, side: str) -> None:
        super().__init__(f"budget reached ({side})")
        self.side = side


class Ledger:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._charges: list[Charge] = []
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)

    def add(self, charge: Charge) -> None:
        self._charges.append(charge)
        if self._path is not None:
            with self._path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(asdict(charge)) + "\n")

    @property
    def charges(self) -> list[Charge]:
        return list(self._charges)

    @property
    def total(self) -> float:
        return round(sum(round(c.usd * 1_000_000) for c in self._charges) / 1_000_000, 6)

    def by_purpose(self) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for c in self._charges:
            row = out.setdefault(c.purpose, {"calls": 0, "usd": 0.0, "units_in": 0, "units_out": 0})
            row["calls"] += 1
            row["usd"] = round(row["usd"] + c.usd, 6)
            row["units_in"] += c.units_in
            row["units_out"] += c.units_out
        return out


class SpendGuard:
    def __init__(self, *, app_budget: float, lab_budget: float, ledger: Ledger) -> None:
        self.app_budget = app_budget
        self.lab_budget = lab_budget
        self.ledger = ledger
        self._app_spent: Callable[[], float] = lambda: 0.0
        self.stopped_by: str | None = None
        #: The app's spend as last read (kept when the app can no longer be asked).
        self.last_app_usd = 0.0

    def attach_app(self, reader: Callable[[], float]) -> None:
        """``reader`` returns what the app has metered since the run started, in USD."""
        self._app_spent = reader

    def app_spent(self) -> float:
        self.last_app_usd = max(0.0, round(self._app_spent(), 6))
        return self.last_app_usd

    def check_app(self, reserve: float = 0.0) -> float:
        """Raises when the app has spent (or with ``reserve`` would spend) its share; returns its spend."""
        spent = self.app_spent()
        if spent + reserve >= self.app_budget:
            self.stopped_by = "app"
            raise BudgetExceededError("app")
        return spent

    def reserve_lab(self, worst_case_usd: float) -> None:
        if self.ledger.total + worst_case_usd > self.lab_budget:
            self.stopped_by = "lab"
            raise BudgetExceededError("lab")

    def snapshot(self) -> dict[str, float]:
        app = self.app_spent()
        lab = self.ledger.total
        return {
            "app_usd": app,
            "lab_usd": lab,
            "total_usd": round(app + lab, 6),
            "app_budget_usd": self.app_budget,
            "lab_budget_usd": self.lab_budget,
        }
