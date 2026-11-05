"""Runs the ElevenLabs key workflow's steps (.github/workflows/ops-elevenlabs-key.yml) against fakes (no AWS, no vendor).

``sync``'s store step runs against the fake ``aws`` CLI of the HeyGen key test (it answers as Secrets Manager does for
a caller holding exactly GitHubDeployMediaKeyPolicy): every run leaves the secret equal to {"apiKey": <key>} or fails
with a clear reason. ``check``'s read step runs against a fake ``curl`` that answers as ElevenLabs'
``GET /v1/user/subscription`` would: it reports the tier and the characters left, and nothing else of the answer, even
when the answer carries other fields or a hostile tier. Neither ever puts the key on a command line or in the log.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from test_heygen_key_workflow import FAKE_AWS

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "ops-elevenlabs-key.yml"
SECRET_NAME = "foundry-ascent/media/elevenlabs"
KEY = "sk_TEST_ONLY_not_a_key_0123456789abcdef"

pytestmark = pytest.mark.skipif(
    (shutil.which("bash") is None or shutil.which("jq") is None) and not os.environ.get("CI"),
    reason="needs bash and jq (CI always has both)",
)

FAKE_CURL = r'''
import json, os, sys
state = os.environ["FAKE_CURL_STATE"]
args = sys.argv[1:]
with open(os.path.join(state, "calls"), "a") as f:
    f.write(json.dumps(args) + "\n")
def option(name):
    return args[args.index(name) + 1] if name in args else None
header = option("-H")
if not header or not header.startswith("@"):
    sys.exit(2)
with open(header[1:]) as f:
    sent = f.read()
with open(os.path.join(state, "header_mode"), "w") as f:
    f.write(oct(os.stat(header[1:]).st_mode & 0o777))
with open(os.path.join(state, "header"), "w") as f:
    f.write(sent)
if os.environ.get("FAKE_CURL_UNREACHABLE") == "yes":
    sys.stderr.write("curl: (6) Could not resolve host: api.elevenlabs.io\n")
    sys.exit(6)
with open(option("-o"), "w") as f:
    f.write(os.environ["FAKE_CURL_BODY"])
sys.stdout.write(os.environ.get("FAKE_CURL_STATUS", "200"))
'''


def step_script(name: str, job: str) -> str:
    """The `run: |` block of the named step of `job`, dedented as the runner sees it."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = lines.index(f"  {job}:")
    step = lines.index(f"      - name: {name}", start)
    run = next(i for i in range(step + 1, len(lines)) if lines[i] == "        run: |")
    body: list[str] = []
    for line in lines[run + 1 :]:
        if line.strip() and not line.startswith("          "):
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


def step_env() -> dict[str, str]:
    """The check's jq filters, as the workflow gives them to its step (single-quoted YAML scalars)."""
    found = re.findall(r"^\s+((?:TIER|LEFT)_FILTER): '(.*)'$", WORKFLOW.read_text(encoding="utf-8"), re.MULTILINE)
    assert [name for name, _ in found] == ["TIER_FILTER", "LEFT_FILTER"], found
    return {name: value.replace("''", "'") for name, value in found}


def run(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", script],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_sync_stores_the_key_in_its_secret_without_exposing_it(tmp_path: Path) -> None:
    state = tmp_path / "aws-state"
    state.mkdir()
    (state / "state").write_text("missing")
    (state / "missing_error").write_text("AccessDeniedException")
    (state / "create_denied").write_text("no")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "aws").write_text(f"#!{sys.executable}\n{FAKE_AWS}")
    (bindir / "aws").chmod(0o755)
    runner = tmp_path / "runner"
    runner.mkdir()
    output = tmp_path / "out"
    output.write_text("")
    script = tmp_path / "store.sh"
    script.write_text(step_script("Store the key in Secrets Manager", "sync"))
    env = {
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "FAKE_AWS_STATE": str(state),
        "EXPECTED_NAME": SECRET_NAME,
        "ELEVENLABS_KEY": f"  {KEY}\n",
        "SECRET_NAME": SECRET_NAME,
        "RUNNER_TEMP": str(runner),
        "GITHUB_OUTPUT": str(output),
    }
    for expected in ("created", "updated"):
        done = run(str(script), env)
        assert done.returncode == 0, done.stdout + done.stderr
        assert f"action={expected}" in output.read_text()
        assert (state / "value").read_text() == json.dumps({"apiKey": KEY}, separators=(",", ":"))
        assert (state / "mode").read_text() == oct(stat.S_IRUSR | stat.S_IWUSR)
        assert KEY not in done.stdout + done.stderr
        assert list(runner.iterdir()) == []
    calls = [json.loads(line) for line in (state / "calls").read_text().splitlines()]
    assert all(KEY not in arg for call in calls for arg in call)
    assert ["--name", SECRET_NAME] == calls[0][2:4]


def check(tmp_path: Path, body: object, status: str = "200", unreachable: bool = False):
    state = tmp_path / "curl-state"
    state.mkdir()
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "curl").write_text(f"#!{sys.executable}\n{FAKE_CURL}")
    (bindir / "curl").chmod(0o755)
    runner = tmp_path / "runner"
    runner.mkdir()
    output = tmp_path / "out"
    output.write_text("")
    script = tmp_path / "check.sh"
    script.write_text(step_script("Read the plan", "check"))
    env = {
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "FAKE_CURL_STATE": str(state),
        "FAKE_CURL_BODY": body if isinstance(body, str) else json.dumps(body),
        "FAKE_CURL_STATUS": status,
        "FAKE_CURL_UNREACHABLE": "yes" if unreachable else "no",
        "ELEVENLABS_KEY": f"{KEY}\n",
        "API_ORIGIN": "https://api.elevenlabs.io",
        "RUNNER_TEMP": str(runner),
        "GITHUB_OUTPUT": str(output),
        **step_env(),
    }
    done = run(str(script), env)
    log = done.stdout + done.stderr
    calls = [json.loads(line) for line in (state / "calls").read_text().splitlines()]
    # Never on a command line, never in the log, and the header file is gone.
    assert all(KEY not in arg for call in calls for arg in call)
    assert KEY not in log
    assert list(runner.iterdir()) == []
    assert (state / "header").read_text() == f"xi-api-key: {KEY}\n"
    assert (state / "header_mode").read_text() == oct(stat.S_IRUSR | stat.S_IWUSR)
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines() if "=" in line)
    return done, log, outputs, calls


def test_check_reports_only_the_tier_and_the_characters_left(tmp_path: Path) -> None:
    body = {
        "tier": "creator",
        "character_count": 12_345,
        "character_limit": 110_000,
        "next_character_count_reset_unix": 1_765_000_000,
        "voice_limit": 30,
        "status": "active",
        "invoice": {"email": "someone@example.com"},
    }
    done, log, outputs, calls = check(tmp_path, body)
    assert done.returncode == 0, log
    assert outputs == {"tier": "creator", "left": "97655"}
    assert "Plan: creator. Characters left this period: 97655." in log
    # Nothing else of the answer reaches the log.
    for other in ("someone@example.com", "1765000000", "110000", "12345", "active", "voice_limit"):
        assert other not in log
    assert calls[0][-1] == "https://api.elevenlabs.io/v1/user/subscription"
    assert "--proto" in calls[0] and "=https" in calls[0]


def test_check_never_prints_what_it_cannot_vouch_for(tmp_path: Path) -> None:
    done, log, outputs, _ = check(
        tmp_path, {"tier": "<script>alert(1)</script> | x", "character_count": "many", "character_limit": None}
    )
    assert done.returncode == 0, log
    assert outputs == {"tier": "scriptalert1scriptx", "left": ""}
    assert "<script>" not in log and "not reported" in log


def test_check_fails_with_the_status_only(tmp_path: Path) -> None:
    done, log, outputs, _ = check(tmp_path, {"detail": {"status": "invalid_api_key", "message": "secret"}}, status="401")
    assert done.returncode == 1
    assert "HTTP 401" in log and "invalid_api_key" not in log and "secret" not in log
    assert outputs == {}


def test_check_reports_an_unreachable_vendor(tmp_path: Path) -> None:
    done, log, outputs, _ = check(tmp_path, {}, unreachable=True)
    assert done.returncode == 1
    assert "could not be reached" in log and "resolve host" not in log
    assert outputs == {}
