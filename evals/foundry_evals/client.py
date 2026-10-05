"""HTTP client for the Foundry Ascent API (system design §4.1, §6; packages/contracts/src/api.ts).

* Session: ``POST /api/v1/auth/sign-in`` sets the ``fa_session`` cookie (HttpOnly, Secure,
  SameSite=Strict, Path=/api). The client keeps that one cookie itself and sends it only to the
  configured origin, which also works against ``http://localhost`` (Python's cookie jar would drop a
  Secure cookie there). Every other cookie is ignored.
* Every non-GET request carries ``x-requested-with: foundry-ascent`` (CSRF) and
  ``x-amz-content-sha256: <hex sha256 of the exact body bytes>`` (CloudFront OAC to the Lambda URL).
* Retries: ``503 database_resuming`` (Aurora waking from auto-pause; honours ``Retry-After``) on every
  method; network errors and ``502/504`` only for idempotent methods or requests carrying an
  ``Idempotency-Key``. Turn requests always carry one, so a dropped stream is replayed from storage by
  the server instead of producing a second model call.
* The turn stream is consumed incrementally (``foundry_evals.sse``); a blocked turn is resolved to its
  stored ``TurnView`` through ``GET /sessions/:id``.

Nothing here logs. Exceptions carry status codes, problem codes and request ids, never bodies, and
access codes are only ever held as ``SecretStr``.
"""

from __future__ import annotations

import hashlib
import json
import random
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from http.cookiejar import CookieJar, CookiePolicy
from typing import Any, Literal, TypeVar
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, SecretStr, TypeAdapter, ValidationError

from foundry_evals import __version__
from foundry_evals.models import (
    AccessCodeIssued,
    AdminPrincipalRow,
    CreateDocumentResponse,
    DocumentView,
    HealthResponse,
    Me,
    MemoryObject,
    ProblemDetails,
    ProgramVentureRow,
    SessionDetail,
    SessionView,
    TurnBlocked,
    TurnCompleted,
    TurnError,
    TurnView,
    VentureDetail,
    VentureSummary,
)
from foundry_evals.sse import TurnStreamReader

API_PREFIX = "/api/v1"
CSRF_HEADER = "x-requested-with"
CSRF_HEADER_VALUE = "foundry-ascent"
CONTENT_SHA256_HEADER = "x-amz-content-sha256"
IDEMPOTENCY_HEADER = "idempotency-key"
REQUEST_ID_HEADER = "x-request-id"
SESSION_COOKIE = "fa_session"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
#: Per-request timeout. The API holds a request up to its database resume budget (40 s) while Aurora wakes
#: from auto-pause, then answers ``503 database_resuming``; CloudFront gives up on the origin at 60 s. A
#: client timeout above both lets the server's answer (or CloudFront's 504) arrive instead of a local
#: timeout, which a non-idempotent request such as sign-in could not retry.
DEFAULT_TIMEOUT_SECONDS = 65.0

M = TypeVar("M", bound=BaseModel)


class ApiError(Exception):
    """A problem+json (or otherwise non-2xx) response. Never carries the response body."""

    def __init__(
        self,
        *,
        method: str,
        path: str,
        status: int,
        code: str,
        title: str = "",
        request_id: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        self.method = method
        self.path = path
        self.status = status
        self.code = code
        self.title = title
        self.request_id = request_id
        self.retry_after = retry_after
        super().__init__(
            f"{method} {path} -> {status} {code}" + (f" (request {request_id})" if request_id else "")
        )


class ApiUnreachableError(Exception):
    """The API could not be reached, or a stream broke, after the retry budget."""


class ContractError(Exception):
    """A response did not match the API contract (field names only, never values)."""


class _RejectAllCookies(CookiePolicy):
    """httpx's own jar is disabled: the session cookie is managed explicitly (see module docs)."""

    netscape = True
    rfc2965 = False
    hide_cookie2 = True

    def set_ok(self, cookie: Any, request: Any) -> bool:
        return False

    def return_ok(self, cookie: Any, request: Any) -> bool:
        return False

    def domain_return_ok(self, domain: str, request: Any) -> bool:
        return False

    def path_return_ok(self, path: str, request: Any) -> bool:
        return False


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 8
    #: Total time spent waiting between attempts of one request (Aurora resumes in ~15-30 s).
    budget_seconds: float = 180.0
    base_delay: float = 1.0
    max_delay: float = 20.0


def normalize_base_url(raw: str) -> str:
    """``https://example.cloudfront.net/`` or ``…/api/v1`` → ``https://example.cloudfront.net``."""
    value = raw.strip().rstrip("/")
    if value.endswith(API_PREFIX):
        value = value[: -len(API_PREFIX)]
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("base URL must be an absolute http(s) URL")
    if parts.query or parts.fragment:
        raise ValueError("base URL must not carry a query or fragment")
    return value


def body_headers(method: str, body: bytes) -> dict[str, str]:
    """Headers every non-GET request needs (CSRF + CloudFront OAC payload hash)."""
    if method.upper() in SAFE_METHODS:
        return {}
    return {
        CSRF_HEADER: CSRF_HEADER_VALUE,
        CONTENT_SHA256_HEADER: hashlib.sha256(body).hexdigest(),
    }


def encode_json(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _retry_after(response: httpx.Response, problem: ProblemDetails | None) -> float | None:
    if problem is not None and problem.retry_after_seconds is not None:
        return float(problem.retry_after_seconds)
    header = response.headers.get("retry-after")
    if header is not None and header.strip().isdigit():
        return float(header.strip())
    return None


def _problem(response: httpx.Response, body: bytes) -> ProblemDetails | None:
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type:
        return None
    try:
        return ProblemDetails.model_validate_json(body)
    except ValidationError:
        return None


def parse_session_cookie(set_cookie_values: list[str]) -> tuple[bool, str | None]:
    """Returns ``(seen, token)`` for the ``fa_session`` cookie among Set-Cookie header values.
    ``token`` is None when the cookie is cleared (empty value or ``Max-Age=0``)."""
    seen = False
    token: str | None = None
    for raw in set_cookie_values:
        first, _, attributes = raw.partition(";")
        name, sep, value = first.partition("=")
        if not sep or name.strip() != SESSION_COOKIE:
            continue
        seen = True
        value = value.strip()
        cleared = value == ""
        for attribute in attributes.split(";"):
            key, _, attr_value = attribute.strip().partition("=")
            if key.lower() == "max-age" and attr_value.strip().lstrip("-").isdigit() and int(attr_value) <= 0:
                cleared = True
        token = None if cleared else value
    return seen, token


@dataclass
class TurnOutcome:
    """The result of one turn request. ``turn`` is set for completed and blocked turns."""

    kind: Literal["completed", "blocked", "error"]
    turn_id: str | None = None
    turn: TurnView | None = None
    blocked_reason: str | None = None
    escalation_id: str | None = None
    support_message: str | None = None
    error_code: str | None = None
    error_retryable: bool = False
    phases: list[str] = field(default_factory=list)
    keepalives: int = 0
    duration_seconds: float = 0.0
    replayed: bool = False


class FoundryClient:
    """One signed-in principal (or anonymous). Not thread-safe; one instance per principal."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        stream_read_timeout: float = 120.0,
        retry: RetryPolicy | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        request_id_prefix: str = "evals",
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self._origin = urlsplit(self.base_url)
        self._retry = retry or RetryPolicy()
        self._sleep = sleep
        self._stream_read_timeout = stream_read_timeout
        self._request_id_prefix = request_id_prefix
        self._session_token: str | None = None
        self._jitter = random.Random()  # noqa: S311 - retry jitter, not security relevant
        self._http = httpx.Client(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout),
            transport=transport,
            cookies=httpx.Cookies(CookieJar(policy=_RejectAllCookies())),
            headers={"user-agent": f"foundry-evals/{__version__}", "accept": "application/json"},
            follow_redirects=False,
        )

    def __repr__(self) -> str:  # never expose the session token
        return f"FoundryClient(base_url={self.base_url!r}, signed_in={self.signed_in})"

    # Lifecycle --------------------------------------------------------------------------------------

    @property
    def signed_in(self) -> bool:
        return self._session_token is not None

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> FoundryClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # Low-level request ------------------------------------------------------------------------------

    def _headers(self, method: str, body: bytes, idempotency_key: str | None) -> dict[str, str]:
        headers = body_headers(method, body)
        if body:
            headers["content-type"] = "application/json"
        if idempotency_key is not None:
            headers[IDEMPOTENCY_HEADER] = idempotency_key
        headers[REQUEST_ID_HEADER] = f"{self._request_id_prefix}-{uuid.uuid4()}"
        if self._session_token is not None:
            headers["cookie"] = f"{SESSION_COOKIE}={self._session_token}"
        return headers

    def _absorb_cookies(self, response: httpx.Response) -> None:
        seen, token = parse_session_cookie(response.headers.get_list("set-cookie"))
        if seen:
            self._session_token = token

    def _delay(self, attempt: int, hint: float | None) -> float:
        if hint is not None:
            return min(max(hint, 0.5), self._retry.max_delay)
        backoff = min(self._retry.base_delay * (2 ** (attempt - 1)), self._retry.max_delay)
        return backoff * (0.75 + 0.5 * self._jitter.random())

    def _wait_or_give_up(self, attempt: int, waited: float, hint: float | None) -> float | None:
        if attempt >= self._retry.max_attempts:
            return None
        delay = self._delay(attempt, hint)
        if waited + delay > self._retry.budget_seconds:
            return None
        self._sleep(delay)
        return delay

    def _retryable_status(self, method: str, keyed: bool, status: int, code: str | None) -> bool:
        if status == 503 and code == "database_resuming":
            return True
        if status in (502, 504) or (status == 503 and code is None):
            return method in IDEMPOTENT_METHODS or keyed
        return False

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, str] | None = None,
        idempotency_key: str | None = None,
        authenticated: bool = True,
    ) -> httpx.Response:
        """Sends a request with retries; returns any 2xx response, raises ApiError otherwise."""
        method = method.upper()
        body = b"" if json_body is None else encode_json(json_body)
        url = API_PREFIX + path
        keyed = idempotency_key is not None
        attempt = 0
        waited = 0.0
        while True:
            attempt += 1
            headers = self._headers(method, body, idempotency_key)
            if not authenticated:
                headers.pop("cookie", None)
            try:
                response = self._http.request(
                    method, url, content=body or None, params=params, headers=headers
                )
            except httpx.TransportError as exc:
                if method in IDEMPOTENT_METHODS or keyed:
                    delay = self._wait_or_give_up(attempt, waited, None)
                    if delay is not None:
                        waited += delay
                        continue
                raise ApiUnreachableError(f"{method} {path}: {type(exc).__name__}") from exc
            self._absorb_cookies(response)
            if response.is_success:
                return response
            problem = _problem(response, response.content)
            code = problem.code if problem is not None else None
            hint = _retry_after(response, problem)
            if self._retryable_status(method, keyed, response.status_code, code):
                delay = self._wait_or_give_up(attempt, waited, hint)
                if delay is not None:
                    waited += delay
                    continue
            raise ApiError(
                method=method,
                path=path,
                status=response.status_code,
                code=code or f"http_{response.status_code}",
                title=problem.title if problem is not None else "",
                request_id=(problem.request_id if problem is not None else None)
                or response.headers.get(REQUEST_ID_HEADER),
                retry_after=hint,
            )

    def probe(
        self, method: str, path: str, *, json_body: Any = None, omit_csrf: bool = False
    ) -> tuple[int, str | None, bytes]:
        """One request without raising or retrying on 4xx (authorization probes).
        Returns ``(status, problem code, body)``; the body is for in-memory grading only.
        ``omit_csrf`` drops the X-Requested-With header (the payload hash is still sent, so the request
        reaches the API through CloudFront)."""
        method = method.upper()
        body = b"" if json_body is None else encode_json(json_body)
        attempt = 0
        waited = 0.0
        while True:
            attempt += 1
            headers = self._headers(method, body, None)
            if omit_csrf:
                headers.pop(CSRF_HEADER, None)
            try:
                response = self._http.request(
                    method, API_PREFIX + path, content=body or None, headers=headers
                )
            except httpx.TransportError as exc:
                delay = self._wait_or_give_up(attempt, waited, None) if method in IDEMPOTENT_METHODS else None
                if delay is not None:
                    waited += delay
                    continue
                raise ApiUnreachableError(f"{method} {path}: {type(exc).__name__}") from exc
            problem = _problem(response, response.content)
            code = problem.code if problem is not None else None
            if response.status_code == 503 and code == "database_resuming":
                delay = self._wait_or_give_up(attempt, waited, _retry_after(response, problem))
                if delay is not None:
                    waited += delay
                    continue
            return response.status_code, code, response.content

    def _json(self, response: httpx.Response, model: type[M]) -> M:
        try:
            return model.model_validate_json(response.content)
        except ValidationError as exc:
            raise ContractError(_contract_message(model.__name__, exc)) from exc

    def _items(self, response: httpx.Response, model: type[M]) -> list[M]:
        adapter: TypeAdapter[list[M]] = TypeAdapter(list[model])
        try:
            payload = json.loads(response.content)
            return adapter.validate_python(payload["items"])
        except (ValueError, KeyError, TypeError) as exc:
            raise ContractError(f"{model.__name__} list: response is not {{items: [...]}}") from exc
        except ValidationError as exc:
            raise ContractError(_contract_message(f"{model.__name__}[]", exc)) from exc

    # Health and auth --------------------------------------------------------------------------------

    def health(self) -> HealthResponse:
        response = self.request("GET", "/health", authenticated=False)
        return self._json(response, HealthResponse)

    def wait_until_ready(self, *, max_wait_seconds: float = 180.0) -> HealthResponse:
        """Polls the public ``/health`` until the API answers and has not recently seen the database fail.

        The public health route never queries the database, so it cannot wake a paused Aurora and ``db``
        may be absent. The first database call (sign-in) wakes it; ``503 database_resuming`` is retried
        with ``Retry-After`` by :meth:`request`.
        """
        waited = 0.0
        while True:
            try:
                status = self.health()
                if status.db != "unavailable":
                    return status
            except ApiError as exc:
                if exc.status != 503:
                    raise
            if waited >= max_wait_seconds:
                raise ApiUnreachableError("the API did not report ready within the wait budget")
            self._sleep(5.0)
            waited += 5.0

    def sign_in(self, access_code: SecretStr) -> Me:
        response = self.request(
            "POST",
            "/auth/sign-in",
            json_body={"accessCode": access_code.get_secret_value()},
            authenticated=False,
        )
        if self._session_token is None:
            raise ContractError("sign-in succeeded without setting the fa_session cookie")
        return self._json(response, Me)

    def sign_out(self) -> None:
        if self._session_token is None:
            return
        try:
            self.request("POST", "/auth/sign-out")
        finally:
            self._session_token = None

    def me(self) -> Me:
        return self._json(self.request("GET", "/me"), Me)

    # Ventures, memory, documents --------------------------------------------------------------------

    def list_ventures(self) -> list[VentureSummary]:
        return self._items(self.request("GET", "/ventures"), VentureSummary)

    def get_venture(self, venture_id: str) -> VentureDetail:
        return self._json(self.request("GET", f"/ventures/{venture_id}"), VentureDetail)

    def list_memory(self, venture_id: str, *, q: str | None = None) -> list[MemoryObject]:
        params = {"q": q} if q else None
        return self._items(self.request("GET", f"/ventures/{venture_id}/memory", params=params), MemoryObject)

    def create_memory(
        self, venture_id: str, *, memory_type: str, title: str, content: str, visibility: str = "venture"
    ) -> MemoryObject:
        response = self.request(
            "POST",
            f"/ventures/{venture_id}/memory",
            json_body={"type": memory_type, "title": title, "content": content, "visibility": visibility},
            idempotency_key=str(uuid.uuid4()),
        )
        return self._json(response, MemoryObject)

    def delete_memory(self, memory_id: str) -> None:
        self.request(
            "PATCH",
            f"/memory/{memory_id}",
            json_body={"action": "delete", "reason": "evaluation cleanup"},
            idempotency_key=str(uuid.uuid4()),
        )

    def create_document_upload(
        self, venture_id: str, *, filename: str, content_type: str, size_bytes: int
    ) -> CreateDocumentResponse:
        response = self.request(
            "POST",
            f"/ventures/{venture_id}/documents",
            json_body={"filename": filename, "contentType": content_type, "sizeBytes": size_bytes},
            idempotency_key=str(uuid.uuid4()),
        )
        return self._json(response, CreateDocumentResponse)

    def upload_presigned(self, url: str, headers: Mapping[str, str], body: bytes) -> None:
        """PUT to a presigned URL. Same-origin URLs (local dev uploads) get the API headers too."""
        target = urlsplit(url)
        if target.scheme not in ("http", "https") or not target.netloc:
            raise ContractError("presigned upload URL is not an absolute http(s) URL")
        extra: dict[str, str] = {}
        if (target.scheme, target.netloc) == (self._origin.scheme, self._origin.netloc):
            extra = body_headers("PUT", body)
        try:
            # Absolute URL: the client's base URL does not apply; no session cookie is attached.
            response = self._http.request(
                "PUT", url, content=body, headers={**headers, **extra}, timeout=60.0
            )
        except httpx.TransportError as exc:
            raise ApiUnreachableError(f"presigned upload: {type(exc).__name__}") from exc
        if not response.is_success:
            raise ApiError(
                method="PUT", path="<presigned upload>", status=response.status_code, code="upload_failed"
            )

    def complete_document(self, document_id: str) -> DocumentView:
        response = self.request(
            "POST", f"/documents/{document_id}/complete", idempotency_key=str(uuid.uuid4())
        )
        return self._json(response, DocumentView)

    def list_documents(self, venture_id: str) -> list[DocumentView]:
        return self._items(self.request("GET", f"/ventures/{venture_id}/documents"), DocumentView)

    def delete_document(self, document_id: str) -> None:
        self.request("DELETE", f"/documents/{document_id}")

    # Sessions and turns -----------------------------------------------------------------------------

    def create_session(self, venture_id: str, *, mode: str, privacy: str = "ephemeral") -> SessionView:
        response = self.request(
            "POST",
            f"/ventures/{venture_id}/sessions",
            json_body={"mode": mode, "goal": None, "privacy": privacy},
            idempotency_key=str(uuid.uuid4()),
        )
        return self._json(response, SessionView)

    def get_session(self, session_id: str) -> SessionDetail:
        return self._json(self.request("GET", f"/sessions/{session_id}"), SessionDetail)

    def end_session(self, session_id: str) -> None:
        self.request("POST", f"/sessions/{session_id}/end", idempotency_key=str(uuid.uuid4()))

    def run_turn(
        self,
        session_id: str,
        text: str,
        *,
        mode: str | None = None,
        rehearsal_counterpart: str | None = None,
    ) -> TurnOutcome:
        """Sends one founder message and consumes the SSE stream to the terminal event.

        Raises ApiError when the turn is refused before streaming (problem+json: rate limit, spend cap,
        kill switch, …) and ApiUnreachableError when the stream cannot be completed within the retry budget.
        """
        payload: dict[str, str] = {"text": text}
        if mode is not None:
            payload["mode"] = mode
        if rehearsal_counterpart is not None:
            payload["rehearsalCounterpart"] = rehearsal_counterpart
        body = encode_json(payload)
        path = f"/sessions/{session_id}/turns"
        key = str(uuid.uuid4())
        attempt = 0
        waited = 0.0
        started = time.monotonic()
        while True:
            attempt += 1
            headers = self._headers("POST", body, key)
            headers["accept"] = "text/event-stream, application/problem+json"
            try:
                outcome = self._stream_turn(path, headers, body)
            except (httpx.TransportError, _BrokenStreamError) as exc:
                # Same Idempotency-Key: the server replays the accepted turn from storage.
                delay = self._wait_or_give_up(attempt, waited, None)
                if delay is not None:
                    waited += delay
                    continue
                raise ApiUnreachableError(f"POST {path}: {type(exc).__name__}") from exc
            except _RetryableRefusalError as refusal:
                delay = self._wait_or_give_up(attempt, waited, refusal.error.retry_after)
                if delay is not None:
                    waited += delay
                    continue
                raise refusal.error from None
            outcome.duration_seconds = time.monotonic() - started
            if outcome.kind == "blocked" and outcome.turn_id is not None:
                outcome.turn = self._find_turn(session_id, outcome.turn_id)
            return outcome

    def _stream_turn(self, path: str, headers: dict[str, str], body: bytes) -> TurnOutcome:
        timeout = httpx.Timeout(self._http.timeout.connect, read=self._stream_read_timeout)
        request = self._http.build_request(
            "POST", API_PREFIX + path, content=body, headers=headers, timeout=timeout
        )
        response = self._http.send(request, stream=True)
        try:
            self._absorb_cookies(response)
            content_type = response.headers.get("content-type", "")
            if not response.is_success or not content_type.startswith("text/event-stream"):
                raw = response.read()
                problem = _problem(response, raw)
                code = problem.code if problem is not None else f"http_{response.status_code}"
                error = ApiError(
                    method="POST",
                    path=path,
                    status=response.status_code,
                    code=code,
                    title=problem.title if problem is not None else "",
                    request_id=(problem.request_id if problem is not None else None)
                    or response.headers.get(REQUEST_ID_HEADER),
                    retry_after=_retry_after(response, problem),
                )
                if response.is_success:
                    raise ContractError(
                        f"turn response has content-type '{content_type}', expected an event stream"
                    )
                if self._retryable_status(
                    "POST", True, response.status_code, problem.code if problem else None
                ):
                    raise _RetryableRefusalError(error)
                if response.status_code == 409 and code == "idempotency_conflict":
                    # The same key is still in flight on the server: wait, then replay.
                    raise _RetryableRefusalError(error)
                raise error
            reader = TurnStreamReader()
            try:
                for chunk in response.iter_bytes():
                    reader.feed(chunk)
                    if reader.done:
                        break
            except httpx.TransportError as exc:
                if reader.result.accepted is not None:
                    raise _BrokenStreamError from exc
                raise
            result = reader.close()
            replayed = response.headers.get("idempotency-replayed") == "true"
        finally:
            response.close()
        if result.truncated or result.terminal is None:
            raise _BrokenStreamError
        terminal = result.terminal
        outcome = TurnOutcome(
            kind="error", phases=result.phases, keepalives=result.keepalives, replayed=replayed
        )
        if isinstance(terminal, TurnCompleted):
            outcome.kind = "completed"
            outcome.turn_id = terminal.turn.id
            outcome.turn = terminal.turn
        elif isinstance(terminal, TurnBlocked):
            outcome.kind = "blocked"
            outcome.turn_id = terminal.turn_id
            outcome.blocked_reason = terminal.reason
            outcome.escalation_id = terminal.escalation_id
            outcome.support_message = terminal.support_message
        elif isinstance(terminal, TurnError):
            outcome.turn_id = terminal.turn_id
            outcome.error_code = terminal.code
            outcome.error_retryable = terminal.retryable
        return outcome

    def _find_turn(self, session_id: str, turn_id: str) -> TurnView | None:
        detail = self.get_session(session_id)
        return next((t for t in detail.turns if t.id == turn_id), None)

    # Admin and program --------------------------------------------------------------------------------

    def list_admin_principals(self) -> list[AdminPrincipalRow]:
        return self._items(self.request("GET", "/admin/principals"), AdminPrincipalRow)

    def issue_access_code(
        self, principal_id: str, *, label: str, expires_in_days: int = 1
    ) -> AccessCodeIssued:
        # No Idempotency-Key: the API never stores one-time codes for replay, and a retried issue
        # would only mint a second code (revoked at teardown with the first).
        response = self.request(
            "POST",
            f"/admin/principals/{principal_id}/access-codes",
            json_body={"label": label[:80], "expiresInDays": expires_in_days},
        )
        return self._json(response, AccessCodeIssued)

    def revoke_access_code(self, access_code_id: str) -> None:
        self.request("DELETE", f"/admin/access-codes/{access_code_id}")

    def list_program_ventures(self) -> list[ProgramVentureRow]:
        return self._items(self.request("GET", "/program/ventures"), ProgramVentureRow)


class _BrokenStreamError(Exception):
    """The stream ended or broke before its terminal event (retried with the same Idempotency-Key)."""


class _RetryableRefusalError(Exception):
    def __init__(self, error: ApiError) -> None:
        super().__init__(str(error))
        self.error = error


def _contract_message(name: str, exc: ValidationError) -> str:
    fields = sorted({".".join(str(p) for p in err["loc"]) for err in exc.errors()})[:8]
    return f"{name} does not match the API contract (fields: {', '.join(fields)})"
