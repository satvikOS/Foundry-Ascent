"""The owner's spend cap on paid lab runs (ops-conversation-lab.yml, ops-live-evals.yml), run as the runner runs it.

The owner caps a paid run at USD 2: both workflows default ``budget_usd`` to 2 and their "Validate inputs" step refuses
any budget above 2 unless ``approved_over_cap`` is ``I approve USD <budget_usd> <code>``, the code an HMAC of the budget
and today's UTC date under the secret ``OWNER_SPEND_KEY`` (scripts/approve-spend.sh makes it). Knowing the format is
not enough: without the owner's key nobody can make the code. The live evaluation also defaults to a sample of 20
scenarios, which its plan estimates under the cap. Each test runs the workflow's real step (and the owner's script)
with bash (no AWS, no network).
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"
LAB = "ops-conversation-lab.yml"
LIVE = "ops-live-evals.yml"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None and not os.environ.get("CI"),
    reason="needs bash (CI always has it)",
)

# Inputs that pass every other check of each workflow's validation step.
VALID = {
    LAB: {
        "SUITE": "recall",
        "MAX_SCENARIOS": "14",
        "SCENARIO_IDS": "",
        "REPEAT": "1",
        "FACE_MODE": "both",
        "PRODUCTION_ORIGIN": "",
        "BASELINE_RUN_ID": "",
        "PUBLIC_KEY": "",
    },
    LIVE: {
        "FAMILIES": "all",
        "SAMPLE": "20",
        "REPEATS": "1",
        "SEED": "1",
        "CONCURRENCY": "4",
        "PUBLIC_KEY": "",
        "DRY_RUN": "false",
    },
}


KEY = "0f" * 32  # a stand-in for the owner's OWNER_SPEND_KEY
SCRIPT = REPO / "scripts" / "approve-spend.sh"


def today() -> str:
    return datetime.datetime.now(datetime.UTC).date().isoformat()


def code(budget: str, day: str | None = None, key: str = KEY) -> str:
    message = f"foundry-ascent spend approval|USD {budget}|{day or today()}".encode()
    return (
        f"I approve USD {budget} "
        + hmac.new(key.encode(), message, hashlib.sha256).hexdigest()[:20]
    )


def text(workflow: str) -> str:
    return (WORKFLOWS / workflow).read_text(encoding="utf-8")


def step_script(workflow: str, name: str) -> str:
    """The `run: |` block of the named step, dedented as the runner sees it."""
    lines = text(workflow).splitlines()
    start = lines.index(f"      - name: {name}")
    run = next(i for i in range(start + 1, len(lines)) if lines[i] == "        run: |")
    body: list[str] = []
    for line in lines[run + 1 :]:
        if line.strip() and not line.startswith("          "):
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


def validate(
    tmp_path: Path,
    workflow: str,
    budget: str,
    approval: str = "",
    key: str = KEY,
    **extra: str,
) -> tuple[int, str, str]:
    summary = tmp_path / "summary.md"
    summary.write_text("", encoding="utf-8")
    event = tmp_path / "event.json"
    event.write_text(
        json.dumps({"inputs": {"budget_usd": budget, "approved_over_cap": approval}}),
        encoding="utf-8",
    )
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GITHUB_STEP_SUMMARY": str(summary),
        "GITHUB_EVENT_PATH": str(event),
        "BUDGET": budget,
        "OWNER_SPEND_KEY": key,
        **VALID[workflow],
        **extra,
    }
    done = subprocess.run(
        [
            "bash",
            "-e",
            "-o",
            "pipefail",
            "-c",
            step_script(workflow, "Validate inputs"),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return (
        done.returncode,
        done.stdout + done.stderr,
        summary.read_text(encoding="utf-8"),
    )


def input_default(workflow: str, name: str) -> str:
    match = re.search(
        rf"\n      {name}:\n(?:        .*\n)*?        default: '([^']*)'\n",
        text(workflow),
    )
    assert match, f"{workflow}: no default for {name}"
    return match.group(1)


@pytest.mark.parametrize("workflow", [LAB, LIVE])
def test_the_default_budget_is_the_owner_cap(workflow: str) -> None:
    assert input_default(workflow, "budget_usd") == "2"
    assert input_default(workflow, "approved_over_cap") == ""


def test_the_live_evaluation_samples_8_scenarios_by_default() -> None:
    # On production's Claude Haiku 4.5 coach (ADR-0022) 8 scenarios fit the USD 2 cap (estimate USD 1.70, USD 1.91 on the
    # fallback simulator and judge); 20 did on Nova 2 Lite.
    assert input_default(LIVE, "sample") == "8"


@pytest.mark.parametrize("workflow", [LAB, LIVE])
@pytest.mark.parametrize("budget", ["0.5", "1.5", "2", "2.0", "2.00"])
def test_a_budget_within_the_cap_needs_no_approval(
    tmp_path: Path, workflow: str, budget: str
) -> None:
    rc, out, summary = validate(tmp_path, workflow, budget)
    assert rc == 0, out
    assert summary == ""


@pytest.mark.parametrize("workflow", [LAB, LIVE])
@pytest.mark.parametrize(
    "approval",
    [
        "",
        "yes",
        "I approve",
        "I approve USD 7",  # the old guessable phrase is no approval
        "I approve USD 7 0000000000000000000",  # a made-up code
        code("2"),
        code("70"),
        code("7.0"),
        code("7", key="1e" * 32),  # another budget or another key
        code("7", day="2026-01-01"),  # yesterday's or any other day's
        code("7") + " ",
        " " + code("7"),
        code("7").upper(),
        code("7")[:-1],
        code("7") + "\n" + code("7"),
    ],
)
def test_a_budget_above_the_cap_is_refused_without_the_owners_code(
    tmp_path: Path, workflow: str, approval: str
) -> None:
    rc, out, summary = validate(tmp_path, workflow, "7", approval)
    assert rc == 1
    assert "needs the owner's approval code for this budget" in out
    assert code("7") not in out  # a refusal never prints what would pass
    assert "I approve USD" not in out
    assert summary == ""


@pytest.mark.parametrize("workflow", [LAB, LIVE])
def test_without_the_owners_key_every_budget_above_the_cap_is_refused(
    tmp_path: Path, workflow: str
) -> None:
    for key in ("", "short"):
        rc, out, summary = validate(
            tmp_path,
            workflow,
            "7",
            code("7", key=key) if key else "I approve USD 7",
            key=key,
        )
        assert rc == 1
        assert "secret OWNER_SPEND_KEY) is not set" in out
        assert summary == ""


@pytest.mark.parametrize("workflow", [LAB, LIVE])
@pytest.mark.parametrize("budget", ["2.01", "7", "12.5"])
def test_the_owners_code_for_that_budget_today_lets_it_run_and_is_recorded(
    tmp_path: Path, workflow: str, budget: str
) -> None:
    rc, out, summary = validate(tmp_path, workflow, budget, code(budget))
    assert rc == 0, out
    assert (
        summary
        == f"Budget USD {budget} is above the USD 2 cap: approved by the owner's code for this budget and day.\n"
    )
    assert code(budget) not in out + summary


@pytest.mark.parametrize("workflow", [LAB, LIVE])
def test_the_approval_never_reaches_the_steps_environment(workflow: str) -> None:
    """Step env values are printed in the public log; the approval is read from the event file instead."""
    assert "${{ inputs.approved_over_cap }}" not in text(workflow)
    assert "OWNER_SPEND_KEY: ${{ secrets.OWNER_SPEND_KEY }}" in text(workflow)


def test_the_owners_script_makes_the_code_the_workflows_accept(tmp_path: Path) -> None:
    done = subprocess.run(
        ["bash", str(SCRIPT), "7"],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "OWNER_SPEND_KEY": KEY},
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    line = done.stdout.strip()
    assert line == code("7")
    for workflow in (LAB, LIVE):
        rc, out, _ = validate(tmp_path, workflow, "7", line)
        assert rc == 0, out


@pytest.mark.parametrize("budget", ["", "2", "1.5", "201", "7.123", "abc"])
def test_the_owners_script_refuses_a_budget_that_needs_no_approval_or_is_out_of_range(
    budget: str,
) -> None:
    done = subprocess.run(
        ["bash", str(SCRIPT), budget],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "OWNER_SPEND_KEY": KEY},
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 2
    assert done.stdout == ""


def test_a_live_dry_run_may_estimate_above_the_cap_without_approval(
    tmp_path: Path,
) -> None:
    """A dry run (the live evaluation's default) calls no model: it only plans and estimates."""
    rc, out, summary = validate(tmp_path, LIVE, "7", DRY_RUN="true")
    assert rc == 0, out
    assert summary == ""
    rc, _, _ = validate(tmp_path, LIVE, "7", DRY_RUN="false")
    assert rc == 1


@pytest.mark.parametrize(("workflow", "ceiling"), [(LAB, "51"), (LIVE, "201")])
def test_an_approval_never_lifts_the_hard_ceiling(
    tmp_path: Path, workflow: str, ceiling: str
) -> None:
    rc, _, _ = validate(tmp_path, workflow, ceiling, code(ceiling))
    assert rc == 1


def test_the_runbook_documents_the_cap_and_the_approval() -> None:
    runbook = (REPO / "docs" / "runbooks" / "conversation-lab.md").read_text(
        encoding="utf-8"
    )
    assert "### Spend cap" in runbook
    assert "I approve USD <budget_usd> <code>" in runbook
    assert "foundry-ascent spend approval|USD <budget_usd>|" in runbook
    assert "scripts/approve-spend.sh" in runbook
    assert not re.search(
        r"approved_over_cap='I approve", runbook
    )  # no ready-to-paste approval for agents
    for workflow in (LAB, LIVE):
        assert "approved_over_cap" in text(workflow)
        assert "scripts/approve-spend.sh" in text(workflow)
