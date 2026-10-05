from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from foundry_evals.client import (
    DEFAULT_TIMEOUT_SECONDS,
    ApiError,
    ApiUnreachableError,
    FoundryClient,
    RetryPolicy,
    body_headers,
    normalize_base_url,
    parse_session_cookie,
)
from tests.fake_api import OWNER_CODE, FakeFoundryApi
from tests.sse_helpers import blocked_stream, completed_stream, error_stream

BASE = "https://d111.cloudfront.example"


def client_for(handler: Any, sleeps: list[float] | None = None) -> FoundryClient:
    recorder = sleeps if sleeps is not None else []
    return FoundryClient(
        BASE,
        transport=httpx.MockTransport(handler),
        sleep=recorder.append,
        retry=RetryPolicy(max_attempts=5, budget_seconds=60, base_delay=0.5, max_delay=4),
    )


def problem(status: int, code: str, retry_after: int | None = None) -> httpx.Response:
    payload: dict[str, Any] = {"type": "t", "title": code, "status": status, "code": code, "requestId": "r1"}
    headers = {"content-type": "application/problem+json"}
    if retry_after is not None:
        payload["retryAfterSeconds"] = retry_after
    return httpx.Response(status, content=json.dumps(payload).encode(), headers=headers)


class TestHelpers:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("https://x.example", "https://x.example"),
            ("https://x.example/", "https://x.example"),
            ("https://x.example/api/v1/", "https://x.example"),
            ("http://localhost:8787", "http://localhost:8787"),
        ],
    )
    def test_normalize_base_url(self, raw: str, expected: str) -> None:
        assert normalize_base_url(raw) == expected

    @pytest.mark.parametrize("raw", ["x.example", "ftp://x.example", "https://x.example/?a=1"])
    def test_normalize_base_url_rejects(self, raw: str) -> None:
        with pytest.raises(ValueError, match="base URL"):
            normalize_base_url(raw)

    def test_body_headers(self) -> None:
        body = b'{"a":1}'
        headers = body_headers("POST", body)
        assert headers["x-requested-with"] == "foundry-ascent"
        assert headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()
        assert body_headers("GET", b"") == {}
        assert body_headers("DELETE", b"")["x-amz-content-sha256"] == hashlib.sha256(b"").hexdigest()

    def test_parse_session_cookie(self) -> None:
        assert parse_session_cookie(
            ["other=1; Path=/", "fa_session=abc.def; Max-Age=60; Path=/api; HttpOnly"]
        ) == (True, "abc.def")
        assert parse_session_cookie(
            ["fa_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/api"]
        ) == (True, None)
        assert parse_session_cookie(["other=1"]) == (False, None)


class TestRequests:
    def test_sign_in_cookie_csrf_and_payload_hash(self) -> None:
        api = FakeFoundryApi()
        client = FoundryClient(BASE, transport=api.transport())
        me = client.sign_in(SecretStr(OWNER_CODE))
        assert "platform_admin" in me.roles
        assert client.signed_in
        assert "fa_session" not in repr(client)
        client.me()
        sign_in, me_request = api.requests[-2], api.requests[-1]
        assert sign_in.headers["x-requested-with"] == "foundry-ascent"
        assert sign_in.headers["x-amz-content-sha256"] == hashlib.sha256(sign_in.content).hexdigest()
        assert "cookie" not in sign_in.headers
        assert me_request.headers["cookie"].startswith("fa_session=")
        assert "x-amz-content-sha256" not in me_request.headers
        assert me_request.headers["x-request-id"].startswith("evals-")
        client.sign_out()
        assert not client.signed_in

    def test_cookie_is_sent_over_plain_http_localhost(self) -> None:
        api = FakeFoundryApi()
        client = FoundryClient("http://localhost:8787", transport=api.transport())
        client.sign_in(SecretStr(OWNER_CODE))
        client.me()
        assert api.requests[-1].headers["cookie"].startswith("fa_session=")

    def test_database_resuming_is_retried_with_retry_after(self) -> None:
        sleeps: list[float] = []
        api = FakeFoundryApi(resuming_responses=2)
        client = FoundryClient(BASE, transport=api.transport(), sleep=sleeps.append)
        client.sign_in(SecretStr(OWNER_CODE))
        assert sleeps == [1.0, 1.0]

    def test_resuming_gives_up_after_budget(self) -> None:
        sleeps: list[float] = []
        client = client_for(lambda _r: problem(503, "database_resuming", retry_after=2), sleeps)
        with pytest.raises(ApiError) as info:
            client.me()
        assert info.value.code == "database_resuming"
        assert len(sleeps) == 4  # max_attempts - 1

    def test_post_without_idempotency_key_is_not_retried_on_502(self) -> None:
        calls: list[int] = []

        def handler(_r: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(502)

        with pytest.raises(ApiError) as info:
            client_for(handler).request("POST", "/auth/sign-out")
        assert info.value.status == 502
        assert calls == [1]

    def test_get_is_retried_on_transport_errors(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) < 3:
                raise httpx.ConnectError("boom", request=request)
            return httpx.Response(200, json={"status": "ok", "version": "v", "db": "awake", "time": "t"})

        assert client_for(handler).health().db == "awake"
        assert len(attempts) == 3

    def test_health_without_db_observation(self) -> None:
        # The public route never queries the database: `db` is absent until the instance has observed it.
        health = client_for(
            lambda _r: httpx.Response(200, json={"status": "ok", "version": "abc", "time": "t"})
        ).health()
        assert health.db is None
        assert health.version == "abc"

    def test_wait_until_ready_does_not_require_db_awake(self) -> None:
        sleeps: list[float] = []
        api = FakeFoundryApi()
        client = FoundryClient(BASE, transport=api.transport(), sleep=sleeps.append)
        assert client.wait_until_ready().version == "test-1"
        assert sleeps == []

    def test_wait_until_ready_polls_while_db_unavailable(self) -> None:
        sleeps: list[float] = []
        api = FakeFoundryApi(health_db=("unavailable", "unavailable", "resuming"))
        client = FoundryClient(BASE, transport=api.transport(), sleep=sleeps.append)
        assert client.wait_until_ready().db == "resuming"
        assert sleeps == [5.0, 5.0]

    def test_wait_until_ready_gives_up(self) -> None:
        sleeps: list[float] = []
        api = FakeFoundryApi(health_db=("unavailable",))
        client = FoundryClient(BASE, transport=api.transport(), sleep=sleeps.append)
        with pytest.raises(ApiUnreachableError, match="ready"):
            client.wait_until_ready(max_wait_seconds=10)
        assert sleeps == [5.0, 5.0]

    def test_default_timeout_outlasts_the_api_resume_budget(self) -> None:
        # 40 s API resume budget < 60 s CloudFront origin timeout < client timeout.
        assert DEFAULT_TIMEOUT_SECONDS > 60

    def test_api_error_never_carries_the_body(self) -> None:
        def handler(_r: httpx.Request) -> httpx.Response:
            return httpx.Response(500, content=b"secret internal detail", headers={"x-request-id": "rid-9"})

        with pytest.raises(ApiError) as info:
            client_for(handler).request("GET", "/me")
        assert "secret" not in str(info.value)
        assert info.value.request_id == "rid-9"

    def test_access_code_is_secret(self) -> None:
        api = FakeFoundryApi()
        client = FoundryClient(BASE, transport=api.transport())
        client.sign_in(SecretStr(OWNER_CODE))
        principal = next(p for p in api.principals.values() if p.name == "Maya Okafor-Lindqvist")
        issued = client.issue_access_code(principal.id, label="evals test")
        assert issued.access_code.get_secret_value().startswith("FA-")
        assert issued.access_code.get_secret_value() not in repr(issued)


class TestTurns:
    def _session_handler(self, stream: str, turn: dict[str, Any] | None = None) -> Any:
        calls: dict[str, int] = {"turns": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/turns"):
                calls["turns"] += 1
                assert request.headers["idempotency-key"]
                assert request.headers["x-requested-with"] == "foundry-ascent"
                return httpx.Response(
                    200, content=stream.encode(), headers={"content-type": "text/event-stream"}
                )
            detail = {
                "session": {
                    "id": "s",
                    "ventureId": "v",
                    "mode": "coach",
                    "privacy": "ephemeral",
                    "status": "active",
                    "personaName": "Foundry Guide",
                    "personaVersion": 1,
                    "disclosure": "d",
                    "startedBy": {"id": "p", "displayName": "x"},
                    "turnCount": 1,
                },
                "turns": [turn] if turn else [],
            }
            return httpx.Response(200, json=detail)

        handler.calls = calls  # type: ignore[attr-defined]
        return handler

    def test_completed(self, turn_payload: dict[str, Any]) -> None:
        outcome = client_for(self._session_handler(completed_stream(turn_payload))).run_turn("s", "hi")
        assert outcome.kind == "completed"
        assert outcome.turn is not None
        assert outcome.turn.id == turn_payload["id"]
        assert outcome.phases == ["classifying", "retrieving", "reasoning", "validating"]
        assert outcome.keepalives == 1

    def test_blocked_resolves_the_stored_turn(self, turn_payload: dict[str, Any]) -> None:
        turn_payload["status"] = "blocked"
        outcome = client_for(
            self._session_handler(blocked_stream(turn_payload["id"]), turn_payload)
        ).run_turn("s", "hi")
        assert outcome.kind == "blocked"
        assert outcome.blocked_reason == "crisis_support"
        assert outcome.support_message == "Call 988."
        assert outcome.turn is not None
        assert outcome.turn.status == "blocked"

    def test_error_event(self) -> None:
        outcome = client_for(self._session_handler(error_stream())).run_turn("s", "hi")
        assert (outcome.kind, outcome.error_code, outcome.error_retryable) == (
            "error",
            "model_unavailable",
            True,
        )

    def test_truncated_stream_is_replayed_with_the_same_key(self, turn_payload: dict[str, Any]) -> None:
        full = completed_stream(turn_payload)
        truncated = full[: full.index("event: turn.completed")]
        keys: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            keys.append(request.headers["idempotency-key"])
            body = truncated if len(keys) == 1 else full
            return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})

        outcome = client_for(handler).run_turn("s", "hi")
        assert outcome.kind == "completed"
        assert len(keys) == 2
        assert keys[0] == keys[1]

    def test_refusal_before_streaming_raises(self) -> None:
        client = client_for(lambda _r: problem(429, "rate_limited", retry_after=600))
        with pytest.raises(ApiError) as info:
            client.run_turn("s", "hi")
        assert (info.value.code, info.value.retry_after) == ("rate_limited", 600.0)

    def test_database_resuming_before_streaming_is_retried(self, turn_payload: dict[str, Any]) -> None:
        responses = [problem(503, "database_resuming", retry_after=3)]

        def handler(_r: httpx.Request) -> httpx.Response:
            if responses:
                return responses.pop()
            return httpx.Response(
                200,
                content=completed_stream(turn_payload).encode(),
                headers={"content-type": "text/event-stream"},
            )

        sleeps: list[float] = []
        assert client_for(handler, sleeps).run_turn("s", "hi").kind == "completed"
        assert sleeps == [3.0]

    def test_rehearsal_counterpart_is_sent(self, turn_payload: dict[str, Any]) -> None:
        seen: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            return httpx.Response(
                200,
                content=completed_stream(turn_payload).encode(),
                headers={"content-type": "text/event-stream"},
            )

        client_for(handler).run_turn("s", "hi", mode="rehearse", rehearsal_counterpart="investor")
        assert seen == [{"text": "hi", "mode": "rehearse", "rehearsalCounterpart": "investor"}]
