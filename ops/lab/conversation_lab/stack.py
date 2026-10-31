"""The app on the runner: the API dev server (real models, local PostgreSQL, in-process jobs) and, for the
browser suites, `vite preview` of the production build proxying /api to it. Both write their output to the
private folder (sealed or deleted, never printed): a log line is not supposed to carry content, but a crash
trace might."""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

from conversation_lab.config import REPO, AppModels

API_PORT = 8787
WEB_PORT = 4173
#: pnpm by its full path (the runner's PATH resolves it once).
PNPM = shutil.which("pnpm") or "pnpm"


def api_env(
    base: Mapping[str, str],
    *,
    models: AppModels,
    database_url: str,
    speech: bool,
    region: str = "us-east-1",
    api_port: int = API_PORT,
    web_port: int = WEB_PORT,
    mock: bool = False,
) -> dict[str, str]:
    """The API's environment: the production model configuration (infra/cdk/config/production.json), the
    lab's database, generous turn limits, and speech (Polly + Transcribe) only when the suite calls. ``mock``
    (the harness's own dry run, no AWS) runs the deterministic mock model without speech instead."""
    env = dict(base)
    env.update(
        {
            "APP_ENV": "development",
            "DB_DRIVER": "pg",
            "DATABASE_URL": database_url,
            "MODEL_PROVIDER": "bedrock",
            "BEDROCK_REGION": region,
            "AWS_REGION": region,
            "MODEL_PRIMARY_ID": models.primary,
            "MODEL_FALLBACK_ID": models.fallback,
            "MODEL_EMBEDDINGS_ID": models.embeddings,
            "PORT": str(api_port),
            "SITE_ORIGIN": f"http://localhost:{web_port}",
            "LOCAL_DOWNLOAD_ORIGIN": f"http://localhost:{api_port}",
            # One founder sends every turn of a run; the per-person window (20 per 10 minutes) would stop it.
            "CORE_TURN_RATE_LIMIT": "1000",
            # The model-based safety screen (off in production until its evaluation, the safety suite): every suite
            # runs with it, so a prefilter hit in a real conversation is screened as it would be once it is on.
            "CORE_SAFETY_SCREEN": "on",
            "LOG_LEVEL": "info",
            "HOME_TENANT_SLUG": "ain",
            "LOCAL_AWS_SPEECH": "true" if speech else "false",
            "SPEECH_ENABLED": "true",
            "SPEECH_ENGINE": "neural",
            # The streamed reply's text and what the sentence gate left out, in the (sealed) API log: synthetic data
            # only, and the API ignores it in production.
            "LAB_TRACE_STREAM": "1",
        }
    )
    if mock:
        env.update({"MODEL_PROVIDER": "mock", "LOCAL_AWS_SPEECH": "false"})
    return env


def wait_for(url: str, *, timeout: float, ok: tuple[int, ...] = (200,)) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:  # noqa: S310 - localhost only
                if response.status in ok:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        if time.monotonic() > deadline:
            raise TimeoutError(f"{url} did not answer within {timeout:.0f} s")
        time.sleep(1.0)


@dataclass
class Stack:
    env: dict[str, str]
    log_dir: Path
    web: bool
    api_port: int = API_PORT
    web_port: int = WEB_PORT
    _procs: list[tuple[str, subprocess.Popen[bytes], IO[bytes]]] = field(default_factory=list)

    @property
    def api_url(self) -> str:
        return f"http://localhost:{self.api_port}"

    @property
    def web_url(self) -> str:
        return f"http://localhost:{self.web_port}"

    def _start(self, name: str, args: list[str], env: dict[str, str]) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log = (self.log_dir / f"{name}.log").open("ab")
        proc = subprocess.Popen(  # noqa: S603 - fixed argument lists
            args, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
        )
        self._procs.append((name, proc, log))

    def _start_api(self, env: dict[str, str]) -> None:
        self._start("api", [PNPM, "--filter", "@foundry/api", "exec", "tsx", "src/dev-server.ts"], env)
        wait_for(f"{self.api_url}/api/v1/health", timeout=180)

    def __enter__(self) -> Stack:
        try:
            self._start_api(self.env)
            if self.web:
                web_env = {**os.environ, "API_PROXY_TARGET": self.api_url}
                self._start(
                    "web",
                    [
                        PNPM,
                        "--filter",
                        "@foundry/web",
                        "exec",
                        "vite",
                        "preview",
                        "--port",
                        str(self.web_port),
                        "--strictPort",
                    ],
                    web_env,
                )
                wait_for(self.web_url, timeout=90)
        except BaseException:
            self.stop()
            raise
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def restart_api(self, env: dict[str, str]) -> None:
        """Stops the API process and starts it again with ``env`` on the same port (the face suite's LITE pass: the
        face's mode is the process's configuration). The web preview keeps proxying to it; sessions live in the
        database, so signed-in pages and clients carry on."""
        for entry in [e for e in self._procs if e[0] == "api"]:
            _terminate(entry[1], entry[2])
            self._procs.remove(entry)
        self.env = env
        self._start_api(env)

    def stop(self) -> None:
        for _name, proc, log in reversed(self._procs):
            _terminate(proc, log)
        self._procs.clear()


def _terminate(proc: subprocess.Popen[bytes], log: IO[bytes]) -> None:
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
    log.close()


def run_backfill(env: dict[str, str], log_dir: Path) -> str:
    """Embeds the seed with the embeddings model, as production's deploy does (apps/api lab-backfill.ts).
    Returns its one-line, counts-only report."""
    log_dir.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [PNPM, "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-backfill.ts"],
        cwd=REPO,
        env=env,
        capture_output=True,
        timeout=420,
        check=False,
    )
    (log_dir / "backfill.log").write_bytes(done.stdout + done.stderr)
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("lab-backfill: "):
            return line.removeprefix("lab-backfill: ")
    return f"failed (exit {done.returncode})"


def run_agenda_ventures(env: dict[str, str], log_dir: Path) -> dict[str, str]:
    """Adds the agenda suite's two synthetic ventures (apps/api lab-agenda-ventures.ts, local Postgres only).
    Returns {channel: founder's display name} for each venture it reported."""
    log_dir.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [PNPM, "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-agenda-ventures.ts"],
        cwd=REPO,
        env=env,
        capture_output=True,
        timeout=120,
        check=False,
    )
    (log_dir / "agenda-ventures.log").write_bytes(done.stdout + done.stderr)
    out: dict[str, str] = {}
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        found = re.match(r"^lab-agenda-ventures: venture=(\w+) channel=(chat|call) founder=(.+)$", line)
        if found:
            out[found.group(2)] = found.group(3).strip()
    return out


def run_memory_venture(env: dict[str, str], log_dir: Path) -> str | None:
    """Adds the dedicated synthetic venture for evals' remembered conversations to the lab's database (apps/api
    lab-memory-venture.ts, which refuses anything but a local Postgres). Returns the venture key, or None."""
    log_dir.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(  # noqa: S603 - fixed argument list
        [PNPM, "--filter", "@foundry/api", "exec", "tsx", "src/scripts/lab-memory-venture.ts"],
        cwd=REPO,
        env=env,
        capture_output=True,
        timeout=120,
        check=False,
    )
    (log_dir / "memory-venture.log").write_bytes(done.stdout + done.stderr)
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        found = re.match(r"^lab-memory-venture: key=([a-z0-9][a-z0-9_-]{0,62}) ", line)
        if found:
            return found.group(1)
    return None
