"""What a client run is expected to cost, before anything runs: a run whose estimate is above its budget is refused with
the numbers and the groups to choose from, never cut short in the middle.

The figures are the first live run's on Nova 2 Lite (2026-11-25, 170 turns, 86 conversations ended), rounded up; another
coach is scaled by its list price against Nova's (never below it: ``live/plan.py`` ``coach_cost_factor``). The judge is
priced by its own tokens.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from conversation_lab.client.scenarios import GROUPS, Scenario, ScenarioError
from conversation_lab.config import DEFAULT_THINK, Price, foundation_model_id
from conversation_lab.live.plan import COACH_BASELINE_MODEL, coach_cost_factor

#: A turn (its reply and its fields), and the recap and distillation of a conversation that another one follows, in USD
#: on the baseline coach. The last conversation of a scenario is not ended, so nothing is spent on a recap nobody reads.
TURN_USD = 0.0036
FOLLOWED_SESSION_USD = 0.0068
SEED_USD = 0.002
#: One judge call, one calibration call, one simulated line: tokens in and out.
JUDGE_TOKENS = (2_300, 280)
CALIBRATION_TOKENS = (1_750, 280)
SIMULATOR_TOKENS = (560, 40)
#: Output tokens a turn that lets the coach reason first is planned at beside its own (Nova 2's low effort; its request
#: allows 2,000), and the share of the typed turns that do.
THINK_TOKENS = 700
THINK_SHARE = {"judgement": 0.5, "typed": 1.0}
#: The most a run is planned at: what is left to USD 2 is for what an estimate does not see.
PLAN_LIMIT_USD = 1.8


@dataclass(frozen=True)
class Estimate:
    scenarios: int
    turns: int
    judged: int
    app_usd: float
    lab_usd: float

    @property
    def total_usd(self) -> float:
        return round(self.app_usd + self.lab_usd, 4)

    @property
    def app_share(self) -> float:
        """The app's part of the budget, so that both sides have the same room above their estimate."""
        share = self.app_usd / self.total_usd if self.total_usd else 0.65
        return round(min(0.9, max(0.4, share)), 3)

    def public(self) -> dict[str, float | int]:
        return {
            "scenarios": self.scenarios,
            "turns": self.turns,
            "judged": self.judged,
            "app_usd": round(self.app_usd, 4),
            "lab_usd": round(self.lab_usd, 4),
            "total_usd": self.total_usd,
        }


def _tokens_usd(price: Price, tokens: tuple[int, int]) -> float:
    return (tokens[0] * price.input + tokens[1] * price.output) / 1_000_000


def judged_turns(s: Scenario) -> int:
    return s.repeat * sum(1 for x in s.sessions for t in x.turns if t.q or t.judge)


def typed_turns(s: Scenario) -> int:
    return s.repeat * sum(len(x.turns) for x in s.sessions if x.channel != "call")


def followed_sessions(s: Scenario) -> int:
    """Conversations that are ended because another one of the scenario follows."""
    return len(s.sessions) * s.repeat - 1


def estimate(
    scenarios: Sequence[Scenario],
    *,
    prices: Mapping[str, Price],
    coach: str | None,
    judge: str | None,
    simulator: str | None,
    calibration_cases: int = 0,
    think: str = DEFAULT_THINK,
) -> Estimate:
    factor = coach_cost_factor(prices, coach)
    turns = sum(s.turns for s in scenarios)
    followed = sum(followed_sessions(s) for s in scenarios)
    judged = sum(judged_turns(s) for s in scenarios)
    simulated = sum(s.repeat * sum(1 for x in s.sessions for t in x.turns if t.intent) for s in scenarios)
    lab = 0.0
    if judge is not None:
        price = prices[foundation_model_id(judge)]
        lab += judged * _tokens_usd(price, JUDGE_TOKENS)
        lab += calibration_cases * _tokens_usd(price, CALIBRATION_TOKENS)
    if simulator is not None:
        lab += simulated * _tokens_usd(prices[foundation_model_id(simulator)], SIMULATOR_TOKENS)
    app = (turns * TURN_USD + followed * FOLLOWED_SESSION_USD) * factor + SEED_USD
    if think in THINK_SHARE:
        thought = sum(typed_turns(s) for s in scenarios) * THINK_SHARE[think] * THINK_TOKENS
        output = prices[foundation_model_id(coach or COACH_BASELINE_MODEL)].output
        # The ``us.`` profile is billed 10% above the global rate the price list holds.
        app += thought * output * 1.1 / 1_000_000
    return Estimate(len(scenarios), turns, judged, round(app, 4), round(lab, 4))


def parse_groups(text: str) -> tuple[str, ...]:
    """``numbers,news`` -> the groups, in run order; empty: every group."""
    named = [g.strip() for g in (text or "").split(",") if g.strip()]
    unknown = sorted(set(named) - set(GROUPS))
    if unknown:
        raise ScenarioError(f"unknown groups: {', '.join(unknown)} (of {', '.join(GROUPS)})")
    return tuple(g for g in GROUPS if g in named)


def in_groups(scenarios: Sequence[Scenario], groups: Sequence[str]) -> list[Scenario]:
    return [s for s in scenarios if not groups or s.group in groups]


def refusal(
    found: Estimate,
    budget_usd: float,
    scenarios: Sequence[Scenario],
    *,
    prices: Mapping[str, Price],
    coach: str | None,
    judge: str | None,
    think: str = DEFAULT_THINK,
) -> str | None:
    """Why the run must not start (its estimate does not fit), in numbers and group names; None when it may."""
    limit = min(budget_usd, PLAN_LIMIT_USD)
    if found.total_usd <= limit:
        return None
    parts = []
    for group in GROUPS:
        mine = [s for s in scenarios if s.group == group]
        if mine:
            one = estimate(mine, prices=prices, coach=coach, judge=judge, simulator=None, think=think)
            parts.append(f"{group} {one.total_usd:.2f}")
    return (
        f"the {found.turns} turns and {found.judged} judged replies of {found.scenarios} scenarios are estimated at USD "
        f"{found.total_usd:.2f} (app {found.app_usd:.2f}, judge and simulator {found.lab_usd:.2f}), above the USD "
        f"{limit:.2f} a run is planned at. Choose groups (--groups): {', '.join(parts)}"
    )
