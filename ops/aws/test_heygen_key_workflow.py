"""Runs the HeyGen key sync's store step (.github/workflows/ops-heygen-key.yml) against a fake ``aws`` CLI (no AWS).

The fake answers as Secrets Manager does for a caller holding exactly GitHubDeployMediaKeyPolicy, including the
answers that are possible but not the happy path: for a secret that does not exist yet, a call authorized only on
``foundry-ascent/media/heygen-??????`` (DescribeSecret, PutSecretValue) may be answered AccessDeniedException rather
than ResourceNotFoundException, because no suffixed ARN exists to match; CreateSecret (pinned to the exact name) of
an existing secret answers ResourceExistsException; a secret scheduled for deletion refuses both writes with
InvalidRequestException. Every run must leave the secret equal to {"apiKey": <key>} or fail with a clear reason, and
never put the key on a command line or in the log.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "ops-heygen-key.yml"
SECRET_NAME = "foundry-ascent/media/heygen"
KEY = "hg_TEST_ONLY_not_a_key_0123456789abcdef"

pytestmark = pytest.mark.skipif(
    (shutil.which("bash") is None or shutil.which("jq") is None) and not os.environ.get("CI"),
    reason="needs bash and jq (CI always has both)",
)

FAKE_AWS = r'''
import json, os, sys
state_dir = os.environ["FAKE_AWS_STATE"]
def read(name, default=""):
    try:
        with open(os.path.join(state_dir, name)) as f:
            return f.read()
    except FileNotFoundError:
        return default
def write(name, text):
    with open(os.path.join(state_dir, name), "w") as f:
        f.write(text)
args = sys.argv[1:]
with open(os.path.join(state_dir, "calls"), "a") as f:
    f.write(json.dumps(args) + "\n")
def fail(code, message, operation):
    sys.stderr.write(f"\nAn error occurred ({code}) when calling the {operation} operation: {message}\n")
    sys.exit(254)
def option(name):
    return args[args.index(name) + 1] if name in args else None
def store():
    source = option("--secret-string")
    if not source or not source.startswith("file://"):
        fail("ValidationException", "the fake only accepts --secret-string file://", "fake")
    path = source[len("file://"):]
    write("mode", oct(os.stat(path).st_mode & 0o777))
    with open(path) as f:
        write("value", f.read())
    write("versions", str(int(read("versions", "0")) + 1))
arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:" + "foundry-ascent/media/heygen-AbCdEf"
state = read("state")
missing_error = read("missing_error", "AccessDeniedException")
if args[:2] == ["sts", "get-caller-identity"]:
    print("123456789012")
elif args[:2] == ["secretsmanager", "describe-secret"]:
    if state == "missing":
        fail(missing_error, "denied or not found: " + arn if missing_error == "AccessDeniedException" else "Secrets Manager can't find the specified secret.", "DescribeSecret")
    print("2026-11-07T00:00:00+00:00" if state == "deleted" else "None")
elif args[:2] == ["secretsmanager", "create-secret"]:
    if option("--name") != os.environ["EXPECTED_NAME"]:
        fail("AccessDeniedException", "not authorized: " + arn, "CreateSecret")
    if read("create_denied") == "yes":
        fail("AccessDeniedException", "not authorized to perform: secretsmanager:CreateSecret on " + arn, "CreateSecret")
    if state == "exists":
        fail("ResourceExistsException", "The operation failed because the secret " + option("--name") + " already exists.", "CreateSecret")
    if state == "deleted":
        fail("InvalidRequestException", "You can't create this secret because a secret with this name is already scheduled for deletion.", "CreateSecret")
    store()
    write("state", "exists")
    print(json.dumps({"ARN": arn, "Name": option("--name")}))
elif args[:2] == ["secretsmanager", "put-secret-value"]:
    if state == "missing":
        fail(missing_error, "denied or not found: " + arn, "PutSecretValue")
    if state == "deleted":
        fail("InvalidRequestException", "You can't perform this operation on the secret because it was marked for deletion.", "PutSecretValue")
    store()
    print(json.dumps({"ARN": arn, "VersionId": "v"}))
else:
    fail("InvalidAction", "the fake does not model " + " ".join(args[:2]), "fake")
'''


def step_script(name: str) -> str:
    """The `run: |` block of the named step, dedented as the runner sees it."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = lines.index(f"      - name: {name}")
    run = next(i for i in range(start + 1, len(lines)) if lines[i] == "        run: |")
    body: list[str] = []
    for line in lines[run + 1 :]:
        if line.strip() and not line.startswith("          "):
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


def run_store(tmp_path: Path, state: str, missing_error: str = "AccessDeniedException", create_denied: bool = False):
    fake_state = tmp_path / "aws-state"
    fake_state.mkdir()
    (fake_state / "state").write_text(state)
    (fake_state / "missing_error").write_text(missing_error)
    (fake_state / "create_denied").write_text("yes" if create_denied else "no")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "aws"
    fake.write_text(f"#!{sys.executable}\n{FAKE_AWS}")
    fake.chmod(0o755)
    runner_temp = tmp_path / "runner"
    runner_temp.mkdir()
    output = tmp_path / "github_output"
    output.write_text("")
    env = {
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "FAKE_AWS_STATE": str(fake_state),
        "EXPECTED_NAME": SECRET_NAME,
        "HEYGEN_KEY": f"  {KEY}\n",
        "SECRET_NAME": SECRET_NAME,
        "RUNNER_TEMP": str(runner_temp),
        "GITHUB_OUTPUT": str(output),
    }
    # The runner's `shell: bash`: bash --noprofile --norc -eo pipefail {0}.
    script = tmp_path / "store.sh"
    script.write_text(step_script("Store the key in Secrets Manager"))
    done = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    calls = [json.loads(line) for line in (fake_state / "calls").read_text().splitlines()] if (fake_state / "calls").exists() else []
    value = (fake_state / "value").read_text() if (fake_state / "value").exists() else None
    mode = (fake_state / "mode").read_text() if (fake_state / "mode").exists() else None
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines() if "=" in line)
    log = done.stdout + done.stderr
    # Never on a command line, never in the log, and the temporary file is gone.
    assert all(KEY not in arg for call in calls for arg in call), calls
    assert KEY not in log
    assert list(runner_temp.iterdir()) == []
    return done, calls, value, mode, outputs, (fake_state / "state").read_text()


@pytest.mark.parametrize("missing_error", ["AccessDeniedException", "ResourceNotFoundException"])
def test_the_first_run_creates_the_secret_however_a_missing_secret_is_reported(tmp_path: Path, missing_error: str) -> None:
    done, calls, value, mode, outputs, state = run_store(tmp_path, "missing", missing_error)
    assert done.returncode == 0, done.stdout + done.stderr
    assert outputs.get("action") == "created"
    assert value == json.dumps({"apiKey": KEY}, separators=(",", ":"))
    assert mode == oct(stat.S_IRUSR | stat.S_IWUSR)
    assert state == "exists"
    assert [c[:2] for c in calls] == [["secretsmanager", "create-secret"]]


def test_a_later_run_stores_a_new_version(tmp_path: Path) -> None:
    done, calls, value, mode, outputs, _ = run_store(tmp_path, "exists")
    assert done.returncode == 0, done.stdout + done.stderr
    assert outputs.get("action") == "updated"
    assert value == json.dumps({"apiKey": KEY}, separators=(",", ":"))
    assert mode == oct(stat.S_IRUSR | stat.S_IWUSR)
    assert [c[:2] for c in calls] == [["secretsmanager", "create-secret"], ["secretsmanager", "put-secret-value"]]
    assert ["--secret-id", SECRET_NAME] == calls[1][2:4]


def test_a_secret_scheduled_for_deletion_fails_with_the_way_out(tmp_path: Path) -> None:
    done, _, value, _, outputs, _ = run_store(tmp_path, "deleted")
    assert done.returncode == 1
    assert value is None and "action" not in outputs
    assert "scheduled for deletion" in done.stdout and "Cancel the deletion" in done.stdout


def test_any_other_refusal_fails_with_its_reason(tmp_path: Path) -> None:
    done, calls, value, _, outputs, _ = run_store(tmp_path, "missing", create_denied=True)
    assert done.returncode == 1
    assert value is None and "action" not in outputs
    assert "::error::Could not create" in done.stdout and "AccessDeniedException" in done.stdout
    assert [c[:2] for c in calls] == [["secretsmanager", "create-secret"]]
