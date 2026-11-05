"""Catalogue of HeyGen LiveAvatar's stock avatars and voices, for choosing the vEIR's stock face.

Run by .github/workflows/ops-heygen-catalog.yml with the repository secret HEYGEN_LIVEAVATAR_API in the
environment variable ``HEYGEN_API_KEY``; never takes the key as an argument. Read-only: it only lists, it never
starts a session, so it uses no credits.

Endpoints (the vendor's published OpenAPI document, https://docs.liveavatar.com/openapi.json, "Live avatar API"
0.1.0, read 2026-11-05; every one authenticates with the ``X-API-KEY`` header):

* ``GET /v1/avatars/public?page&page_size`` (page_size at most 100): the stock avatars. Fields per avatar: ``id``,
  ``name``, ``type`` (IMAGE|VIDEO), ``status`` (ACTIVE|INIT|DEPLOYING|FAILED|DEACTIVATED|DELETED), ``preview_url``,
  ``default_voice`` ({id, name} or null), ``default_voice_agent_id``, ``is_1080p``, ``created_at``, ``updated_at``,
  ``is_expired``, ``error_message``. There is no gender, age or style field on an avatar: the catalogue gives the
  gender and language of its default voice instead, labelled as such.
* ``GET /v1/voices?voice_type=public&page&page_size``: the stock voices (``id``, ``name``, ``description``,
  ``language``, ``gender``, ``tags``, ``created_at``, ``updated_at``), and ``GET /v1/voices/{id}`` for each one's
  ``voice_engines`` (elevenLabs|fish|cartesia).

The account's credits (``GET /v1/users/credits``) are deliberately NOT read: the catalogue is an artifact of a
public repository's run, which any signed-in GitHub user can download, so it holds public stock metadata only.

What no API field says, and the documented rules the catalogue applies instead (docs.liveavatar.com, 2026-11-05):

* LITE ("Avatar Only") takes any avatar from the public list (lite-mode/configuration) and brings its own audio,
  so HeyGen voices play no part in it ("Voices are used in FULL Mode only", core-concepts/voices). An avatar is
  marked usable in LITE and in FULL when its status is ACTIVE and it has not expired; FULL also needs a voice,
  which is the avatar's default voice unless a session names another.
* Sandbox ("Developing in Sandbox Mode"): only the Wayne avatar (dd73ea75-1218-4ef3-92ce-606d5f7fbc0a), sessions
  of about a minute, no credits.
* Outside the sandbox a session needs credit for at least one minute (faq/credits): 1 credit for LITE, 2 for FULL.
* Green-screen studio avatars (core-concepts/avatars, "Green-screen studio avatars"): their video renders on a
  solid green background for client-side chroma keying. "There is no dedicated field on the avatar object that
  marks an avatar as a studio avatar. To detect one programmatically, check whether its ``preview_url`` image
  contains an alpha channel." The catalogue does exactly that: it reads only the first bytes of each https preview
  (a ranged GET, at most ``PREVIEW_MAX_BYTES``, a few at a time, with timeouts and an overall time budget), from
  hosts under the vendor's own domains only (``PREVIEW_DOMAINS``; the docs name no image host), without the key,
  without cookies and without following redirects, and reads the PNG header (colour type with alpha, or a tRNS
  chunk before the image data) or the WebP header (VP8X alpha flag, VP8L alpha bit). An avatar is marked
  ``likely_green_screen`` true or false, or null when its preview could not be checked (the reason category is
  in ``preview_check``).

Responses are ``{code, data, message}``. The success code is 100 in the OpenAPI document and 1000 in the vendor's
web SDK 0.0.19; both are taken, as in apps/api/src/adapters/heygen-liveavatar.ts. The envelope and the paging are
validated strictly: a wrong code, a missing or mistyped count or results, a page count that changes between pages,
a duplicate id, or a page short of the stated count stops the run, so a changed API is noticed rather than
catalogued wrong. Each avatar and voice is validated on its own: one that is missing a field, has a mistyped field
or a value outside a documented enum is skipped and counted by reason category (never by name, id or value), and
the run stops only when every item of a non-empty list is invalid.

THE REPOSITORY IS PUBLIC, and so are its Actions logs, step summaries and artifacts. The key is never printed,
never on a command line and never written: requests carry it in a header only to api.liveavatar.com (redirects
are refused, so it cannot follow one elsewhere; preview requests never carry it). Every line this prints passes
through ``Scrubber``, which removes the key, any piece of 12 or more characters of it, and a fragment of 4 or more
characters that begins like the key or ends like it (the way a vendor message might echo a truncated key), also
in URL-encoded form; an unexpected exception is reported by its type and scrubbed message only, never with a
traceback. The outputs are checked not to contain any 12-character piece of the key before they are written.
Vendor bodies are never printed; an error reports the path, the HTTP status, the envelope's code and at most 200
scrubbed characters of its message.

Outputs: ``catalog.json`` and ``catalog.md`` in ``--out-dir`` (the workflow uploads them as an artifact), and with
``--summary`` a step summary of counts only.

Dependencies: none (standard library). Python 3.12+.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import http.client
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

API_BASE = "https://api.liveavatar.com"
OPENAPI_URL = "https://docs.liveavatar.com/openapi.json"
SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"
SUCCESS_CODES = frozenset({100, 1000})
PAGE_SIZE = 100
MAX_PAGES = 50
MAX_VOICE_DETAILS = 2000
# The documented limit is 10 requests per second per API key; stay well under it.
REQUEST_INTERVAL_S = 0.2
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
RETRY_DELAYS_S = (1.0, 2.0, 4.0)
HTTP_TIMEOUT_S = 20.0
MAX_BODY_BYTES = 8 * 1024 * 1024

# Preview images (green-screen detection). The docs name no image host, so only hosts under the vendor's own
# domains are fetched; any other host is reported as not checked.
PREVIEW_DOMAINS = ("liveavatar.com", "heygen.ai", "heygen.com")
PREVIEW_MAX_BYTES = 64 * 1024
PREVIEW_WORKERS = 4
PREVIEW_TIMEOUT_S = 10.0
PREVIEW_BUDGET_S = 180.0
MAX_PREVIEW_CHECKS = 1000

AVATAR_TYPES = frozenset({"IMAGE", "VIDEO"})
AVATAR_STATUSES = frozenset({"ACTIVE", "INIT", "DEPLOYING", "FAILED", "DEACTIVATED", "DELETED"})
VOICE_ENGINES = frozenset({"elevenLabs", "fish", "cartesia"})
AVATAR_FIELDS = frozenset(
    {
        "id",
        "space_id",
        "type",
        "status",
        "name",
        "preview_url",
        "default_voice",
        "default_voice_agent_id",
        "is_1080p",
        "created_at",
        "updated_at",
        "is_expired",
        "error_message",
    }
)
VOICE_FIELDS = frozenset({"id", "name", "description", "language", "gender", "created_at", "updated_at", "tags"})
VOICE_DETAIL_FIELDS = VOICE_FIELDS | {"voice_engines"}
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class CatalogError(Exception):
    """A request failed or a response does not have the documented shape. Printed only through `Scrubber`."""


class InvalidItem(CatalogError):
    """One value does not have the documented shape; `category` is a fixed phrase that names no value."""

    def __init__(self, message: str, category: str) -> None:
        super().__init__(message)
        self.category = category


class Scrubber:
    """Removes the API key and pieces of it from text that will be printed; `leaks` checks text to be written."""

    PIECE = 12  # any run of this many characters of the key, anywhere
    EDGE = 4  # a fragment this long that begins like the key or ends like it, standing as its own word

    def __init__(self, secret: str) -> None:
        self.secret = secret
        forms = [secret, urllib.parse.quote(secret, safe="")] if secret else []
        self.forms = [form for form in dict.fromkeys(forms) if form]
        self._pieces = {piece for form in self.forms for piece in self._grams(form)}

    def _grams(self, form: str) -> set[str]:
        n = self.PIECE
        return {form[i : i + n] for i in range(len(form) - n + 1)} if len(form) >= n else set()

    def _spans(self, text: str) -> list[tuple[int, int]]:
        spans: list[tuple[int, int]] = []
        n = self.PIECE
        if self._pieces:
            spans += [(i, i + n) for i in range(len(text) - n + 1) if text[i : i + n] in self._pieces]
        for form in self.forms:
            if len(form) < self.EDGE:
                spans += [(m.start(), m.end()) for m in re.finditer(re.escape(form), text)]
                continue
            for i in range(len(text)):
                if i and text[i - 1].isalnum():
                    continue
                length = 0
                while length < len(form) and i + length < len(text) and text[i + length] == form[length]:
                    length += 1
                if length >= self.EDGE:
                    spans.append((i, i + length))
            for end in range(len(text), 0, -1):
                if end < len(text) and text[end].isalnum():
                    continue
                length = 0
                while length < len(form) and end - length > 0 and text[end - length - 1] == form[-length - 1]:
                    length += 1
                if length >= self.EDGE:
                    spans.append((end - length, end))
        return spans

    def __call__(self, text: str) -> str:
        if not self.forms:
            return text
        text = str(text)
        for form in self.forms:
            text = text.replace(form, "***")
        spans = sorted(self._spans(text))
        if not spans:
            return text
        out: list[str] = []
        position = 0
        merged: list[list[int]] = []
        for start, end in spans:
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        for start, end in merged:
            out.append(text[position:start])
            out.append("***")
            position = end
        out.append(text[position:])
        return "".join(out)

    def leaks(self, text: str) -> bool:
        """Whether text holds the key or any 12-character piece of it (a truncated copy), as given or URL-encoded."""
        if not self.forms:
            return False
        if any(form in text for form in self.forms):
            return True
        n = self.PIECE
        return any(text[i : i + n] in self._pieces for i in range(len(text) - n + 1))


def emit(scrub: Scrubber, line: str, *, stream: Any = None) -> None:
    """The only way this script prints: every line passes through the scrubber first."""
    print(scrub(line), file=stream or sys.stdout)


# A transport takes an API path and its query parameters and answers (HTTP status, body bytes).
Transport = Callable[[str, Mapping[str, str]], tuple[int, bytes]]
# A preview fetcher takes an image URL and answers its first bytes (at most PREVIEW_MAX_BYTES), or raises.
PreviewFetch = Callable[[str], bytes]


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """urllib would repeat the X-API-KEY header to a redirect's target: refuse every redirect instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _is_loopback(hostname: str | None) -> bool:
    return hostname in {"127.0.0.1", "localhost"}


def urllib_transport(api_key: str, base_url: str = API_BASE, timeout: float = HTTP_TIMEOUT_S) -> Transport:
    """The real transport: HTTPS GET with the key in X-API-KEY, no redirects, no proxies from the environment."""
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "https" and not _is_loopback(parsed.hostname):
        raise CatalogError("the API base must be https")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RefuseRedirects())

    def get(path: str, params: Mapping[str, str]) -> tuple[int, bytes]:
        if not path.startswith("/v1/") or ".." in path:
            raise CatalogError(f"refusing to request {path!r}")
        query = urllib.parse.urlencode(sorted(params.items()))
        url = f"{base_url.rstrip('/')}{path}" + (f"?{query}" if query else "")
        request = urllib.request.Request(
            url,
            headers={"X-API-KEY": api_key, "Accept": "application/json", "User-Agent": "foundry-ascent-heygen-catalog"},
            method="GET",
        )
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, response.read(MAX_BODY_BYTES + 1)
        except urllib.error.HTTPError as error:
            body = b""
            try:
                body = error.read(64 * 1024) if error.fp is not None else b""
            except OSError:
                body = b""
            return error.code, body

    return get


def urllib_preview_fetcher(timeout: float = PREVIEW_TIMEOUT_S, max_bytes: int = PREVIEW_MAX_BYTES) -> PreviewFetch:
    """The real preview fetcher: a ranged GET for the first bytes, no key, no cookies, no redirects, no proxies."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RefuseRedirects())

    def fetch(url: str) -> bytes:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" and not _is_loopback(parsed.hostname):
            raise ValueError("preview URL is not https")
        request = urllib.request.Request(
            url,
            headers={
                "Range": f"bytes=0-{max_bytes - 1}",
                "Accept": "image/png,image/webp,image/*",
                "User-Agent": "foundry-ascent-heygen-catalog",
            },
            method="GET",
        )
        deadline = time.monotonic() + timeout
        with opener.open(request, timeout=timeout) as response:
            if response.status not in {200, 206}:
                raise ValueError(f"HTTP {response.status}")
            chunks: list[bytes] = []
            got = 0
            while got < max_bytes:
                if time.monotonic() > deadline:
                    raise TimeoutError("preview read took too long")
                chunk = response.read(min(8192, max_bytes - got))
                if not chunk:
                    break
                chunks.append(chunk)
                got += len(chunk)
            return b"".join(chunks)

    return fetch


@dataclass
class Client:
    """Envelope-checking GETs with retries on throttling and transient failures."""

    transport: Transport
    scrub: Scrubber
    sleep: Callable[[float], None] = time.sleep
    interval: float = REQUEST_INTERVAL_S
    requests: int = 0

    def get(self, path: str, params: Mapping[str, str] | None = None) -> Any:
        params = dict(params or {})
        where = path + ("?" + urllib.parse.urlencode(sorted(params.items())) if params else "")
        for attempt in range(len(RETRY_DELAYS_S) + 1):
            if self.requests and self.interval:
                self.sleep(self.interval)
            self.requests += 1
            try:
                status, body = self.transport(path, params)
            except (OSError, http.client.HTTPException) as error:
                if attempt < len(RETRY_DELAYS_S):
                    self.sleep(RETRY_DELAYS_S[attempt])
                    continue
                reason = getattr(error, "reason", error)
                raise CatalogError(self.scrub(f"{where}: request failed ({type(error).__name__}: {reason})")) from None
            if status in RETRY_STATUSES and attempt < len(RETRY_DELAYS_S):
                self.sleep(RETRY_DELAYS_S[attempt])
                continue
            return self._data(where, status, body)
        raise AssertionError("unreachable")  # pragma: no cover

    def _data(self, where: str, status: int, body: bytes) -> Any:
        envelope: Any = None
        if len(body) > MAX_BODY_BYTES:
            raise CatalogError(f"{where}: HTTP {status}, response larger than {MAX_BODY_BYTES} bytes")
        try:
            envelope = json.loads(body.decode("utf-8")) if body else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            envelope = None
        vendor = ""
        if isinstance(envelope, dict):
            code = envelope.get("code")
            message = envelope.get("message")
            if not isinstance(message, str):
                message = envelope.get("detail") if isinstance(envelope.get("detail"), str) else ""
            # Only an integer code is shown (a string could carry anything); the message is scrubbed whole and
            # then cut, so a cut cannot leave a long piece of the key behind.
            shown_code = str(code) if type(code) is int else "not an integer"
            text = self.scrub(" ".join(str(message).split()))[:200]
            vendor = f" (code {shown_code}: {text})" if code is not None or message else ""
        if status != 200:
            hint = " (check the key: HEYGEN_LIVEAVATAR_API)" if status in {401, 403} else ""
            raise CatalogError(self.scrub(f"{where}: HTTP {status}{vendor}{hint}"))
        if not isinstance(envelope, dict):
            raise CatalogError(f"{where}: the response is not a JSON object")
        code = envelope.get("code")
        if type(code) is not int or code not in SUCCESS_CODES:
            raise CatalogError(self.scrub(f"{where}: unexpected envelope code{vendor or ''}"))
        if envelope.get("data") is None:
            raise CatalogError(self.scrub(f"{where}: the envelope has no data{vendor}"))
        return envelope["data"]

    def paginate(self, path: str, params: Mapping[str, str] | None = None) -> list[Any]:
        """Every result of a paginated list, checking that the pages add up to the stated count exactly.

        The envelope and the paging are strict; the results themselves are returned as given, for the caller to
        validate one by one.
        """
        results: list[Any] = []
        count: int | None = None
        for page in range(1, MAX_PAGES + 1):
            where = f"{path} page {page}"
            data = self.get(path, {**(params or {}), "page": str(page), "page_size": str(PAGE_SIZE)})
            _require_keys(data, where, {"count", "results"}, {"count", "results", "next", "previous"})
            page_count = data["count"]
            if type(page_count) is not int or page_count < 0:
                raise CatalogError(f"{where}: count is not a non-negative integer")
            for key in ("next", "previous"):
                if data.get(key) is not None and not isinstance(data[key], str):
                    raise CatalogError(f"{where}: {key} is not a string or null")
            if count is None:
                count = page_count
            elif page_count != count:
                raise CatalogError(f"{where}: count changed from {count} to {page_count} while paging")
            page_results = data["results"]
            if not isinstance(page_results, list):
                raise CatalogError(f"{where}: results is not a list")
            if len(page_results) > PAGE_SIZE:
                raise CatalogError(f"{where}: {len(page_results)} results on a page of {PAGE_SIZE}")
            results.extend(page_results)
            if len(results) > count:
                raise CatalogError(f"{path}: more results ({len(results)}) than the stated count ({count})")
            if len(results) == count:
                return results
            if not page_results:
                raise CatalogError(f"{where}: empty page with {len(results)} of {count} results read")
        raise CatalogError(f"{path}: more than {MAX_PAGES} pages of {PAGE_SIZE}")


def _require_keys(obj: Any, where: str, required: Iterable[str], known: Iterable[str]) -> list[str]:
    """Checks obj is an object with every required key; answers the keys it has beyond `known` (sorted)."""
    if not isinstance(obj, dict):
        raise InvalidItem(f"{where}: not an object", "not an object")
    missing = sorted(set(required) - obj.keys())
    if missing:
        raise InvalidItem(f"{where}: missing {', '.join(missing)}", "missing field")
    return sorted(obj.keys() - set(known))


def _string(obj: Mapping[str, Any], key: str, where: str, *, optional: bool = False, nonempty: bool = True) -> str | None:
    value = obj.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise InvalidItem(f"{where}: {key} is not a {'non-empty ' if nonempty else ''}string", "mistyped field")
    return value


def _bool(obj: Mapping[str, Any], key: str, where: str, default: bool | None = None) -> bool:
    if key not in obj and default is not None:
        return default
    value = obj.get(key)
    if type(value) is not bool:
        raise InvalidItem(f"{where}: {key} is not a boolean", "mistyped field")
    return value


def _uuid(obj: Mapping[str, Any], key: str, where: str) -> str:
    value = _string(obj, key, where)
    if value is None or not UUID_RE.match(value):
        raise InvalidItem(f"{where}: {key} is not a UUID", "malformed id")
    return value.lower()


def _timestamp(obj: Mapping[str, Any], key: str, where: str) -> str:
    value = _string(obj, key, where) or ""
    try:
        dt.datetime.fromisoformat(value)
    except ValueError:
        raise InvalidItem(f"{where}: {key} is not an ISO 8601 date-time", "malformed date-time") from None
    return value


def _enum(obj: Mapping[str, Any], key: str, where: str, allowed: frozenset[str], default: str) -> str:
    value = obj.get(key, default)
    if not isinstance(value, str) or value not in allowed:
        shown = value if isinstance(value, str) and len(value) <= 40 else type(value).__name__
        message = f"{where}: {key} {shown!r} is not one of {', '.join(sorted(allowed))} (the documented values)"
        raise InvalidItem(message, "undocumented enum value")
    return value


def _https_url(obj: Mapping[str, Any], key: str, where: str) -> str | None:
    value = _string(obj, key, where, optional=True, nonempty=False)
    if value is None or value == "":
        return None
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or any(c in value for c in "\r\n\t |<>\"'`"):
        raise InvalidItem(f"{where}: {key} is not an https URL", "malformed URL")
    return value


def parse_avatar(raw: Any, where: str) -> dict[str, Any]:
    unknown = _require_keys(raw, where, ("id", "name", "created_at", "updated_at", "is_expired", "error_message"), AVATAR_FIELDS)
    avatar_id = _uuid(raw, "id", where)
    where = f"{where} ({avatar_id})"
    default_voice = raw.get("default_voice")
    if default_voice is not None:
        voice_where = f"{where} default_voice"
        _require_keys(default_voice, voice_where, ("id", "name"), ("id", "name"))
        default_voice = {"id": _string(default_voice, "id", voice_where), "name": _string(default_voice, "name", voice_where)}
    error_message = _string(raw, "error_message", where, optional=True, nonempty=False)
    return {
        "id": avatar_id,
        "name": _string(raw, "name", where),
        "type": _enum(raw, "type", where, AVATAR_TYPES, "VIDEO"),
        "status": _enum(raw, "status", where, AVATAR_STATUSES, "INIT"),
        "is_1080p": _bool(raw, "is_1080p", where, default=False),
        "is_expired": _bool(raw, "is_expired", where),
        "preview_url": _https_url(raw, "preview_url", where),
        "default_voice": default_voice,
        "default_voice_agent_id": _string(raw, "default_voice_agent_id", where, optional=True, nonempty=False) or None,
        "created_at": _timestamp(raw, "created_at", where),
        "updated_at": _timestamp(raw, "updated_at", where),
        "has_error_message": bool(error_message),
        "_unknown_fields": unknown,
    }


def parse_voice(raw: Any, where: str, *, detail: bool = False) -> dict[str, Any]:
    known = VOICE_DETAIL_FIELDS if detail else VOICE_FIELDS
    unknown = _require_keys(raw, where, ("id", "name", "language", "gender", "created_at", "updated_at", "tags"), known)
    voice_id = _uuid(raw, "id", where)
    where = f"{where} ({voice_id})"
    tags = raw["tags"]
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        raise InvalidItem(f"{where}: tags is not a list of strings", "mistyped field")
    voice: dict[str, Any] = {
        "id": voice_id,
        "name": _string(raw, "name", where),
        "description": _string(raw, "description", where, optional=True, nonempty=False) or None,
        "language": _string(raw, "language", where, nonempty=False),
        "gender": _string(raw, "gender", where, nonempty=False),
        "tags": tags,
        "created_at": _timestamp(raw, "created_at", where),
        "updated_at": _timestamp(raw, "updated_at", where),
        "_unknown_fields": unknown,
    }
    if detail:
        engines = raw.get("voice_engines", [])
        if not isinstance(engines, list):
            raise InvalidItem(f"{where}: voice_engines is not a list", "mistyped field")
        for engine in engines:
            if not isinstance(engine, str) or engine not in VOICE_ENGINES:
                shown = engine if isinstance(engine, str) and len(engine) <= 40 else type(engine).__name__
                message = f"{where}: voice_engines holds {shown!r}, not one of {', '.join(sorted(VOICE_ENGINES))}"
                raise InvalidItem(message, "undocumented enum value")
        voice["voice_engines"] = engines
    return voice


def _parse_each(raws: Sequence[Any], what: str, parse: Callable[[Any, str], dict[str, Any]]) -> tuple[list[dict[str, Any]], Counter[str]]:
    """Parses each item on its own: an invalid one is skipped and counted by category. All invalid stops the run."""
    parsed: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    for i, raw in enumerate(raws):
        try:
            parsed.append(parse(raw, f"{what} result {i}"))
        except InvalidItem as error:
            skipped[error.category] += 1
    if raws and not parsed:
        reasons = ", ".join(f"{category}: {n}" for category, n in sorted(skipped.items()))
        raise CatalogError(f"{what}: all {len(raws)} results are invalid ({reasons}); the API may have changed")
    return parsed, skipped


def _unique(items: Sequence[Mapping[str, Any]], what: str) -> None:
    duplicates = sorted(key for key, n in Counter(item["id"] for item in items).items() if n > 1)
    if duplicates:
        raise CatalogError(f"{what}: duplicate ids {', '.join(duplicates[:5])}")


# --- preview images: green-screen studio avatars ---------------------------------------------------------------


def image_has_alpha(head: bytes) -> bool | None:
    """Whether an image (its first bytes) has an alpha channel: True, False, or None when it cannot be told."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return _png_has_alpha(head)
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return _webp_has_alpha(head)
    if head.startswith(b"\xff\xd8\xff"):
        return False  # JPEG has no alpha channel
    return None


def _png_has_alpha(head: bytes) -> bool | None:
    position = 8
    color_type: int | None = None
    while position + 8 <= len(head):
        length, kind = struct.unpack(">I4s", head[position : position + 8])
        data_start = position + 8
        if kind == b"IHDR":
            if length < 13 or data_start + 13 > len(head):
                return None
            color_type = head[data_start + 9]
            if color_type in (4, 6):  # greyscale + alpha, RGB + alpha
                return True
        elif color_type is None:
            return None  # IHDR must come first
        elif kind == b"tRNS":
            return True  # transparency for greyscale, RGB or palette images
        elif kind in (b"IDAT", b"IEND"):
            return False  # tRNS must come before the image data
        position = data_start + length + 4
    return None  # cut off before the image data: cannot tell


def _webp_has_alpha(head: bytes) -> bool | None:
    if len(head) < 21:
        return None
    chunk = head[12:16]
    if chunk == b"VP8X":
        return bool(head[20] & 0x10)
    if chunk == b"VP8L":
        if len(head) < 25 or head[20] != 0x2F:
            return None
        return bool((int.from_bytes(head[21:25], "little") >> 28) & 1)
    if chunk == b"VP8 ":
        return False  # simple lossy WebP has no alpha
    return None


def preview_host_allowed(url: str, domains: Iterable[str] = PREVIEW_DOMAINS) -> bool:
    """https, the default port, no credentials, and a host that is one of `domains` or under one of them."""
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    try:
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password or port not in (None, 443) or not host:
        return False
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def check_previews(
    avatars: Sequence[dict[str, Any]],
    fetch: PreviewFetch | None,
    *,
    domains: Iterable[str] = PREVIEW_DOMAINS,
    workers: int = PREVIEW_WORKERS,
    budget_s: float = PREVIEW_BUDGET_S,
    limit: int = MAX_PREVIEW_CHECKS,
) -> None:
    """Marks each avatar likely_green_screen from its preview's alpha channel, with the reason when it cannot."""
    domains = tuple(domains)
    todo: dict[str, list[dict[str, Any]]] = {}
    for avatar in avatars:
        avatar["likely_green_screen"] = None
        url = avatar["preview_url"]
        if fetch is None:
            avatar["preview_check"] = "not checked"
        elif not url:
            avatar["preview_check"] = "no preview"
        elif not preview_host_allowed(url, domains):
            avatar["preview_check"] = "host not allowed"
        elif url not in todo and len(todo) >= limit:
            avatar["preview_check"] = "over the check limit"
        else:
            todo.setdefault(url, []).append(avatar)
    if not todo or fetch is None:
        return

    def mark(url: str, check: str, alpha: bool | None) -> None:
        for avatar in todo[url]:
            avatar["preview_check"] = check
            avatar["likely_green_screen"] = alpha

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="preview")
    try:
        futures = {pool.submit(fetch, url): url for url in todo}
        done, not_done = concurrent.futures.wait(futures, timeout=budget_s)
        for future in done:
            url = futures[future]
            try:
                head = future.result()
            except Exception:  # noqa: BLE001 - any failure of one preview is reported as its category only
                mark(url, "fetch failed", None)
                continue
            alpha = image_has_alpha(head[:PREVIEW_MAX_BYTES]) if isinstance(head, bytes | bytearray) else None
            if alpha is None:
                mark(url, "unknown image format", None)
            else:
                mark(url, "alpha channel" if alpha else "no alpha channel", alpha)
        for future in not_done:
            future.cancel()
            mark(futures[future], "over the time budget", None)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


# --- the catalogue ---------------------------------------------------------------------------------------------


def build_catalog(
    client: Client,
    *,
    voice_details: bool = True,
    preview_fetch: PreviewFetch | None = None,
    preview_domains: Iterable[str] | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """Reads the two lists, validates them and joins them into the catalogue (public stock metadata only)."""
    avatars, skipped_avatars = _parse_each(client.paginate("/v1/avatars/public"), "/v1/avatars/public", parse_avatar)
    _unique(avatars, "/v1/avatars/public")
    voices, skipped_voices = _parse_each(client.paginate("/v1/voices", {"voice_type": "public"}), "/v1/voices", parse_voice)
    _unique(voices, "/v1/voices")
    skipped_details: Counter[str] = Counter()
    if voice_details:
        if len(voices) > MAX_VOICE_DETAILS:
            raise CatalogError(f"/v1/voices: {len(voices)} voices, more than the {MAX_VOICE_DETAILS} this reads details for")
        for voice in voices:
            where = f"/v1/voices/{voice['id']}"
            try:
                detail = parse_voice(client.get(where), where, detail=True)
                if detail["id"] != voice["id"]:
                    raise InvalidItem(f"{where}: the detail is for another voice", "detail for another voice")
            except InvalidItem as error:
                skipped_details[error.category] += 1
                voice["voice_engines"] = None
                continue
            voice["voice_engines"] = detail["voice_engines"]
            voice["_unknown_fields"] = sorted(set(voice["_unknown_fields"]) | set(detail["_unknown_fields"]))

    by_voice = {voice["id"]: voice for voice in voices}
    unknown_fields = {
        "avatar": sorted({f for a in avatars for f in a.pop("_unknown_fields")}),
        "voice": sorted({f for v in voices for f in v.pop("_unknown_fields")}),
    }
    for avatar in avatars:
        usable = avatar["status"] == "ACTIVE" and not avatar["is_expired"]
        default_voice = avatar["default_voice"]
        voice = by_voice.get(default_voice["id"].lower()) if default_voice else None
        avatar["default_voice_gender"] = voice["gender"] if voice else None
        avatar["default_voice_language"] = voice["language"] if voice else None
        avatar["default_voice_engines"] = voice.get("voice_engines") if voice else None
        avatar["lite"] = usable
        avatar["full"] = usable
        avatar["full_needs_voice_id"] = usable and default_voice is None
        avatar["sandbox"] = avatar["id"] == SANDBOX_AVATAR_ID
    check_previews(avatars, preview_fetch, domains=PREVIEW_DOMAINS if preview_domains is None else preview_domains)
    avatars.sort(key=lambda a: (not a["lite"], a["name"].casefold(), a["id"]))
    voices.sort(key=lambda v: (v["language"].casefold(), v["name"].casefold(), v["id"]))

    stamp = (now or dt.datetime.now(dt.UTC)).astimezone(dt.UTC).replace(microsecond=0).isoformat()
    skipped = {
        "avatars": dict(sorted(skipped_avatars.items())),
        "voices": dict(sorted(skipped_voices.items())),
        "voice_details": dict(sorted(skipped_details.items())),
    }
    return {
        "generated_at": stamp,
        "source": {
            "api": API_BASE,
            "openapi": OPENAPI_URL,
            "endpoints": ["GET /v1/avatars/public", "GET /v1/voices?voice_type=public", "GET /v1/voices/{id}"],
            "requests": client.requests,
        },
        "rules": {
            "lite": "status ACTIVE and not expired; LITE plays our own audio (HeyGen voices are FULL only)",
            "full": "status ACTIVE and not expired; needs a voice: the avatar's default voice or a voice_id",
            "sandbox": f"only avatar {SANDBOX_AVATAR_ID} (Wayne), sessions of about 60 s, no credits",
            "paid": (
                "outside the sandbox a session needs credit for at least one minute: 1 credit for LITE, 2 for FULL; "
                "the account's credits are not listed here (see the LiveAvatar dashboard)"
            ),
            "gender": "avatars have no gender, age or style field; default_voice_gender is the gender of the avatar's default voice",
            "green_screen": (
                "no field marks a studio (green-screen) avatar; the docs say its preview is a transparent cutout, so "
                "likely_green_screen is whether the preview image has an alpha channel (null: not checked)"
            ),
        },
        "unknown_fields": unknown_fields,
        "skipped": skipped,
        "counts": counts(avatars, voices, skipped),
        "avatars": avatars,
        "voices": voices,
    }


def counts(avatars: Sequence[Mapping[str, Any]], voices: Sequence[Mapping[str, Any]], skipped: Mapping[str, Mapping[str, int]] | None = None) -> dict[str, Any]:
    skipped = skipped or {}
    return {
        "avatars": len(avatars),
        "avatars_active": sum(a["status"] == "ACTIVE" for a in avatars),
        "avatars_expired": sum(a["is_expired"] for a in avatars),
        "avatars_1080p": sum(a["is_1080p"] for a in avatars),
        "avatars_lite": sum(a["lite"] for a in avatars),
        "avatars_full": sum(a["full"] for a in avatars),
        "avatars_with_default_voice": sum(a["default_voice"] is not None for a in avatars),
        "avatars_sandbox": sum(a["sandbox"] for a in avatars),
        "avatars_likely_green_screen": sum(a.get("likely_green_screen") is True for a in avatars),
        "avatars_preview_unchecked": sum(a.get("likely_green_screen") is None for a in avatars),
        "avatars_by_default_voice_gender": dict(sorted(Counter(a["default_voice_gender"] or "unknown" for a in avatars).items())),
        "avatars_skipped": sum(skipped.get("avatars", {}).values()),
        "voices": len(voices),
        "voices_by_gender": dict(sorted(Counter(v["gender"] or "unknown" for v in voices).items())),
        "voices_elevenlabs_engine": sum("elevenLabs" in (v.get("voice_engines") or []) for v in voices),
        "voices_skipped": sum(skipped.get("voices", {}).values()),
        "voice_details_skipped": sum(skipped.get("voice_details", {}).values()),
    }


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, list | tuple):
        value = ", ".join(str(v) for v in value)
    text = " ".join(str(value).split())
    return re.sub(r"([\\|`*_\[\]<>])", r"\\\1", text)[:120]


def _skipped_text(skipped: Mapping[str, int]) -> str:
    return ", ".join(f"{category}: {n}" for category, n in skipped.items())


def render_markdown(catalog: Mapping[str, Any]) -> str:
    lines = [
        "# HeyGen LiveAvatar catalogue",
        "",
        f"Generated {catalog['generated_at']} from {catalog['source']['api']} ({catalog['source']['requests']} requests).",
        "Public stock metadata only: no account data (this is an artifact of a public repository's run).",
        "",
        "Rules applied (no API field says these; docs.liveavatar.com):",
        "",
        *(f"- **{name}**: {_cell(rule)}" for name, rule in catalog["rules"].items()),
        "",
        f"Sandbox avatar in the public list: {_cell(catalog['counts']['avatars_sandbox'] > 0)}.",
        "",
    ]
    for kind in ("avatar", "voice"):
        if catalog["unknown_fields"][kind]:
            lines += [f"Undocumented {kind} fields seen (not catalogued): {_cell(catalog['unknown_fields'][kind])}.", ""]
    for kind, label in (("avatars", "avatars"), ("voices", "voices"), ("voice_details", "voice details")):
        if catalog["skipped"][kind]:
            lines += [f"Invalid {label} skipped: {_cell(_skipped_text(catalog['skipped'][kind]))}.", ""]
    lines += [
        f"## Avatars ({len(catalog['avatars'])})",
        "",
        "| Name | Avatar id | Status | 1080p | Default voice | Voice gender | Voice language | LITE | FULL | Sandbox | Green screen (likely) | Preview |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a in catalog["avatars"]:
        voice = a["default_voice"]
        status = a["status"] + (" (expired)" if a["is_expired"] else "")
        preview = f"[preview]({a['preview_url']})" if a["preview_url"] else ""
        green = _cell(a["likely_green_screen"]) if a["likely_green_screen"] is not None else f"? ({_cell(a['preview_check'])})"
        lines.append(
            "| "
            + " | ".join(
                [
                    _cell(a["name"]),
                    f"`{a['id']}`",
                    _cell(status),
                    _cell(a["is_1080p"]),
                    _cell(voice["name"]) if voice else "",
                    _cell(a["default_voice_gender"]),
                    _cell(a["default_voice_language"]),
                    _cell(a["lite"]),
                    _cell(a["full"]),
                    _cell(a["sandbox"]),
                    green,
                    preview,
                ]
            )
            + " |"
        )
    lines += [
        "",
        f"## Voices ({len(catalog['voices'])}, FULL mode only)",
        "",
        "| Name | Voice id | Gender | Language | Engines | Tags | Description |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for v in catalog["voices"]:
        lines.append(
            "| "
            + " | ".join(
                [
                    _cell(v["name"]),
                    f"`{v['id']}`",
                    _cell(v["gender"]),
                    _cell(v["language"]),
                    _cell(v.get("voice_engines")),
                    _cell(v["tags"]),
                    _cell(v["description"]),
                ]
            )
            + " |"
        )
    return "\n".join(lines) + "\n"


def render_summary(catalog: Mapping[str, Any]) -> str:
    """The public step summary: fixed words and counts only (no names, ids or URLs)."""
    c = catalog["counts"]
    rows = [
        ("Stock avatars", c["avatars"]),
        ("Active", c["avatars_active"]),
        ("Expired", c["avatars_expired"]),
        ("1080p", c["avatars_1080p"]),
        ("Usable in LITE", c["avatars_lite"]),
        ("Usable in FULL", c["avatars_full"]),
        ("With a default voice", c["avatars_with_default_voice"]),
        ("Usable in the sandbox", c["avatars_sandbox"]),
        ("Likely green-screen studio (transparent preview)", c["avatars_likely_green_screen"]),
        ("Preview not checked", c["avatars_preview_unchecked"]),
        ("Avatars skipped as invalid", c["avatars_skipped"]),
        ("Stock voices (FULL only)", c["voices"]),
        ("Voices with the ElevenLabs engine", c["voices_elevenlabs_engine"]),
        ("Voices skipped as invalid", c["voices_skipped"]),
        ("Voice details skipped as invalid", c["voice_details_skipped"]),
    ]
    rows += [(f"Avatars whose default voice is {_cell(g)}", n) for g, n in c["avatars_by_default_voice_gender"].items()]
    rows += [(f"Voices: {_cell(g)}", n) for g, n in c["voices_by_gender"].items()]
    lines = ["### HeyGen LiveAvatar catalogue", "", "| | Count |", "| --- | ---: |"]
    lines += [f"| {label} | {int(n)} |" for label, n in rows]
    lines += [
        "",
        (
            "Names, ids and previews are in the run's `heygen-catalog` artifact (public stock metadata only: the "
            "artifact of a public repository's run can be downloaded by any signed-in GitHub user)."
        ),
    ]
    return "\n".join(lines) + "\n"


def write_outputs(catalog: Mapping[str, Any], out_dir: Path, scrub: Scrubber, summary: Path | None) -> None:
    files = {
        "catalog.json": json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
        "catalog.md": render_markdown(catalog),
    }
    summary_text = render_summary(catalog) if summary else ""
    for name, text in [*files.items(), ("summary", summary_text)]:
        if scrub.leaks(text):
            raise CatalogError(f"refusing to write {name}: it would contain part of the API key")
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (out_dir / name).write_text(text, encoding="utf-8")
    if summary:
        with summary.open("a", encoding="utf-8") as handle:
            handle.write(summary_text)


def main(
    argv: Sequence[str] | None = None,
    *,
    transport: Transport | None = None,
    preview_fetch: PreviewFetch | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(description="List HeyGen LiveAvatar's stock avatars and voices (key in HEYGEN_API_KEY).")
    parser.add_argument("--out-dir", type=Path, required=True, help="where catalog.json and catalog.md are written")
    parser.add_argument("--summary", type=Path, help="append a counts-only Markdown summary here (GITHUB_STEP_SUMMARY)")
    parser.add_argument("--no-voice-details", action="store_true", help="skip GET /v1/voices/{id} (no voice engines)")
    parser.add_argument("--no-preview-check", action="store_true", help="do not read preview images (no green-screen marks)")
    args = parser.parse_args(argv)

    api_key = os.environ.pop("HEYGEN_API_KEY", "").strip()
    scrub = Scrubber(api_key)
    if not api_key:
        emit(scrub, "HEYGEN_API_KEY is empty or not set.", stream=sys.stderr)
        return 2
    try:
        client = Client(transport or urllib_transport(api_key), scrub, sleep=sleep)
        fetch = None if args.no_preview_check else (preview_fetch or urllib_preview_fetcher())
        catalog = build_catalog(client, voice_details=not args.no_voice_details, preview_fetch=fetch)
        write_outputs(catalog, args.out_dir, scrub, args.summary)
    except CatalogError as error:
        emit(scrub, f"::error::HeyGen catalogue: {error}")
        return 1
    except Exception as error:  # noqa: BLE001 - never let a traceback (which could quote the key) reach the log
        emit(scrub, f"::error::HeyGen catalogue: unexpected {type(error).__name__}: {' '.join(str(error).split())[:300]}")
        return 1
    for kind, label in (("avatars", "avatars"), ("voices", "voices"), ("voice_details", "voice details")):
        if catalog["skipped"][kind]:
            n = sum(catalog["skipped"][kind].values())
            emit(scrub, f"::warning::HeyGen catalogue: skipped {n} invalid {label} ({_skipped_text(catalog['skipped'][kind])}).")
    c = catalog["counts"]
    emit(
        scrub,
        f"Catalogued {c['avatars']} stock avatars ({c['avatars_lite']} usable in LITE, "
        f"{c['avatars_likely_green_screen']} likely green-screen) and {c['voices']} voices.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
