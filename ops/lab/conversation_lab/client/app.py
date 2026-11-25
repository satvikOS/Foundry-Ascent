"""What the client suite needs from the lab's app besides a founder's own API: the seeded ventures, the turn exactly as
the API returns it (guidance, evidence, usage), the founder's intake, and the path's own clock when a conversation ages.
"""

from __future__ import annotations

import contextlib
import json
import re
import subprocess
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from conversation_lab.client.scenarios import Scenario
from conversation_lab.config import REPO
from conversation_lab.live.lab import LabApp

SEED_SCRIPT = "src/scripts/lab-client-ventures.ts"


@dataclass(frozen=True)
class Seeded:
    venture_id: str
    founder_id: str


def venture_key(scenario_id: str) -> str:
    return scenario_id.lower()


def seed_plan(scenarios: Sequence[Scenario]) -> list[dict[str, Any]]:
    """One venture, founder, record and (when the scenario has one) neighbour per scenario."""
    out = []
    for s in scenarios:
        key = venture_key(s.id)
        v = s.venture
        out.append(
            {
                "key": key,
                "name": v["name"],
                "oneLiner": v["oneLiner"],
                "stage": v["stage"],
                "domain": v["domain"],
                "goal": v["goal"],
                "founderKey": key,
                "founderName": s.founder,
                "record": [
                    {"type": r.type, "title": r.title, "content": r.content, "daysAgo": r.days_ago}
                    for r in s.record
                ],
            }
        )
        if s.neighbour is not None:
            n = s.neighbour
            out.append(
                {
                    "key": f"{key}-nb",
                    "name": n["venture"],
                    "oneLiner": f"Another venture of the same cohort ({n['venture']})",
                    "stage": "validation",
                    "domain": "general",
                    "goal": "A separate venture, used to test isolation",
                    "founderKey": f"{key}-nb",
                    "founderName": n["founder"],
                    "record": [
                        {
                            "type": "fact",
                            "title": "Confidential venture note",
                            "content": n["secret"],
                            "daysAgo": 20,
                        }
                    ],
                }
            )
    return out


_SEED_LINE = re.compile(
    r"^lab-client-ventures: key=([a-z0-9-]+) venture=([0-9a-f-]{36}) founder=([0-9a-f-]{36})$"
)


def parse_seed(text: str) -> dict[str, Seeded]:
    out = {}
    for line in text.splitlines():
        found = _SEED_LINE.match(line.strip())
        if found:
            out[found.group(1)] = Seeded(found.group(2), found.group(3))
    return out


def run_seed(
    env: Mapping[str, str], log_dir: Path, scenarios: Sequence[Scenario], *, pnpm: str
) -> dict[str, Seeded]:
    """apps/api lab-client-ventures.ts on the lab's local database (it refuses any other). Scenario id -> ids."""
    log_dir.mkdir(parents=True, exist_ok=True)
    plan = log_dir / "client-seed-plan.json"
    plan.write_text(json.dumps(seed_plan(scenarios)), encoding="utf-8")
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [pnpm, "--filter", "@foundry/api", "exec", "tsx", SEED_SCRIPT, "--plan", str(plan)],
        cwd=REPO,
        env=dict(env),
        capture_output=True,
        timeout=300,
        check=False,
    )
    (log_dir / "client-seed.log").write_bytes(done.stdout + done.stderr)
    by_key = parse_seed(done.stdout.decode("utf-8", "replace"))
    return {s.id: by_key[venture_key(s.id)] for s in scenarios if venture_key(s.id) in by_key}


class ClientApp(LabApp):
    """The live suite's app port, with the venture's path aged with its conversations."""

    def age_path(self, venture_id: str, days: int) -> str | None:
        """Moves the venture's path (its steps' due dates and times) back with the conversations that made it."""
        try:
            done = subprocess.run(  # noqa: S603 - fixed argument list
                [
                    self.pnpm,
                    "--filter",
                    "@foundry/api",
                    "exec",
                    "tsx",
                    SEED_SCRIPT,
                    "--age-path",
                    venture_id,
                    "--days",
                    str(days),
                ],
                cwd=REPO,
                env=self.env,
                capture_output=True,
                timeout=90,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "timeout"
        with self._lock, (self.log_dir / "client-aging.log").open("ab") as fh:
            fh.write(done.stdout + done.stderr)
        return None if done.returncode == 0 else f"exit_{done.returncode}"


def raw_turn(client: Any, session_id: str, turn_id: str | None) -> dict[str, Any] | None:
    """The stored turn as the API returns it (``guidance`` and ``evidence`` included), or None."""
    if turn_id is None:
        return None
    with contextlib.suppress(Exception):
        data = client.request("GET", f"/sessions/{session_id}").json()
        turns = data.get("turns") if isinstance(data, dict) else None
        for turn in turns or []:
            if isinstance(turn, dict) and turn.get("id") == turn_id:
                return turn
    return None


def founder_intake(s: Scenario) -> dict[str, Any] | None:
    """The scenario's intake, else what its founder is (studies, first venture); None in the client's own protocol,
    where the tool starts from an empty account."""
    if s.group == "protocol":
        return None
    if s.intake:
        return dict(s.intake)
    out: dict[str, Any] = {}
    if s.studies:
        out["studies"] = s.studies
    if s.first_time:
        out["experience"] = "first_time"
    return out or None


def save_profile(client: Any, venture_id: str, s: Scenario) -> str:
    """The founder's own profile page, as they would fill it (their studies and whether this is their first venture)."""
    from foundry_evals.client import ApiError, ApiUnreachableError

    background = ". ".join(x for x in (s.studies[:120], "First-time founder" if s.first_time else "") if x)
    try:
        client.request(
            "PATCH",
            f"/ventures/{venture_id}/student-profile",
            json_body={
                "expectedVersion": 0,
                "profile": {
                    "background": background,
                    "learningGoal": "",
                    "constraints": "",
                    "depth": "balanced",
                    "masteredConcepts": [],
                },
            },
            idempotency_key=str(uuid.uuid4()),
        )
    except ApiError as exc:
        return f"refused_{exc.status}"
    except ApiUnreachableError:
        return "unreachable"
    return "saved"


def save_intake(client: Any, venture_id: str, intake: Mapping[str, Any]) -> str:
    """The founder's intake, through the path API; what happened, as a code (an app without it: ``unavailable``)."""
    from foundry_evals.client import ApiError, ApiUnreachableError

    try:
        path = client.request("GET", f"/ventures/{venture_id}/path").json()
        version = int(path.get("version") or 0) if isinstance(path, dict) else 0
        for method in ("PUT", "POST"):
            try:
                client.request(
                    method,
                    f"/ventures/{venture_id}/path/intake",
                    json_body={"expectedVersion": version, "intake": dict(intake)},
                    idempotency_key=str(uuid.uuid4()),
                )
            except ApiError as exc:
                if exc.status in (404, 405):
                    continue
                return f"refused_{exc.status}"
            return "saved"
    except ApiError as exc:
        return "unavailable" if exc.status in (404, 405) else f"refused_{exc.status}"
    except (ApiUnreachableError, ValueError, AttributeError):
        return "unreachable"
    return "unavailable"
