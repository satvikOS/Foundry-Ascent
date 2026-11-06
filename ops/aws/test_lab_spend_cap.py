"""The owner's spend cap on paid lab runs (ops-conversation-lab.yml, ops-live-evals.yml), run as the runner runs it.

The owner caps a paid run at USD 2: both workflows default ``budget_usd`` to 2 and their "Validate inputs" step refuses
any budget above 2 unless ``approved_over_cap`` is exactly ``I approve USD <budget_usd>`` (the budget as typed). The live
evaluation also defaults to a sample of 20 scenarios, which its plan estimates under the cap. Each test runs the
workflow's real step with bash (no AWS, no network).
"""

from __future__ import annotations

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
    LAB: {"SUITE": "recall", "MAX_SCENARIOS": "14", "SCENARIO_IDS": "", "REPEAT": "1", "FACE_MODE": "both",
          "PRODUCTION_ORIGIN": "", "BASELINE_RUN_ID": "", "PUBLIC_KEY": ""},
    LIVE: {"FAMILIES": "all", "SAMPLE": "20", "REPEATS": "1", "SEED": "1", "CONCURRENCY": "4", "PUBLIC_KEY": "",
           "DRY_RUN": "false"},
}


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
    tmp_path: Path, workflow: str, budget: str, approval: str = "", **extra: str
) -> tuple[int, str, str]:
    summary = tmp_path / "summary.md"
    summary.write_text("", encoding="utf-8")
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GITHUB_STEP_SUMMARY": str(summary),
        "BUDGET": budget,
        "APPROVED_OVER_CAP": approval,
        **VALID[workflow],
        **extra,
    }
    done = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", step_script(workflow, "Validate inputs")],
        env=env, capture_output=True, text=True, check=False,
    )
    return done.returncode, done.stdout + done.stderr, summary.read_text(encoding="utf-8")


def input_default(workflow: str, name: str) -> str:
    match = re.search(rf"\n      {name}:\n(?:        .*\n)*?        default: '([^']*)'\n", text(workflow))
    assert match, f"{workflow}: no default for {name}"
    return match.group(1)


@pytest.mark.parametrize("workflow", [LAB, LIVE])
def test_the_default_budget_is_the_owner_cap(workflow: str) -> None:
    assert input_default(workflow, "budget_usd") == "2"
    assert input_default(workflow, "approved_over_cap") == ""


def test_the_live_evaluation_samples_20_scenarios_by_default() -> None:
    assert input_default(LIVE, "sample") == "20"


@pytest.mark.parametrize("workflow", [LAB, LIVE])
@pytest.mark.parametrize("budget", ["0.5", "1.5", "2", "2.0", "2.00"])
def test_a_budget_within_the_cap_needs_no_approval(tmp_path: Path, workflow: str, budget: str) -> None:
    rc, out, summary = validate(tmp_path, workflow, budget)
    assert rc == 0, out
    assert summary == ""


@pytest.mark.parametrize("workflow", [LAB, LIVE])
@pytest.mark.parametrize(
    "approval",
    ["", "yes", "I approve", "I approve USD 2", "I approve USD 7.0", "i approve usd 7", " I approve USD 7",
     "I approve USD 7 ", "I approve USD 70", "I approve USD 7\nI approve USD 7"],
)
def test_a_budget_above_the_cap_is_refused_without_the_exact_approval(tmp_path: Path, workflow: str, approval: str) -> None:
    rc, out, summary = validate(tmp_path, workflow, "7", approval)
    assert rc == 1
    assert 'approved_over_cap must be exactly \\"I approve USD 7\\"' not in out  # the message is a plain quote
    assert 'approved_over_cap must be exactly "I approve USD 7"' in out
    assert summary == ""


@pytest.mark.parametrize("workflow", [LAB, LIVE])
@pytest.mark.parametrize("budget", ["2.01", "7", "12.5"])
def test_the_owner_approval_of_that_exact_budget_lets_it_run_and_is_recorded(
    tmp_path: Path, workflow: str, budget: str
) -> None:
    rc, out, summary = validate(tmp_path, workflow, budget, f"I approve USD {budget}")
    assert rc == 0, out
    assert summary == f"Budget USD {budget} is above the USD 2 cap: approved by approved_over_cap.\n"


def test_a_live_dry_run_may_estimate_above_the_cap_without_approval(tmp_path: Path) -> None:
    """A dry run (the live evaluation's default) calls no model: it only plans and estimates."""
    rc, out, summary = validate(tmp_path, LIVE, "7", DRY_RUN="true")
    assert rc == 0, out
    assert summary == ""
    rc, _, _ = validate(tmp_path, LIVE, "7", DRY_RUN="false")
    assert rc == 1


@pytest.mark.parametrize(("workflow", "ceiling"), [(LAB, "51"), (LIVE, "201")])
def test_an_approval_never_lifts_the_hard_ceiling(tmp_path: Path, workflow: str, ceiling: str) -> None:
    rc, _, _ = validate(tmp_path, workflow, ceiling, f"I approve USD {ceiling}")
    assert rc == 1


def test_the_runbook_documents_the_cap_and_the_approval() -> None:
    runbook = (REPO / "docs" / "runbooks" / "conversation-lab.md").read_text(encoding="utf-8")
    assert "### Spend cap" in runbook
    assert "I approve USD <budget_usd>" in runbook
    for workflow in (LAB, LIVE):
        assert "approved_over_cap" in text(workflow)
        assert '"I approve USD <budget_usd>"' in text(workflow)
