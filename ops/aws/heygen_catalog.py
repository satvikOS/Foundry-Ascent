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
* ``GET /v1/users/credits``: ``credits_left`` (a decimal string). The API names no plan; the plan only shows
  through the credits.

What no API field says, and the documented rules the catalogue applies instead (docs.liveavatar.com, 2026-11-05):

* LITE ("Avatar Only") takes any avatar from the public list (lite-mode/configuration) and brings its own audio,
  so HeyGen voices play no part in it ("Voices are used in FULL Mode only", core-concepts/voices). An avatar is
  marked usable in LITE and in FULL when its status is ACTIVE and it has not expired; FULL also needs a voice,
  which is the avatar's default voice unless a session names another.
* Sandbox ("Developing in Sandbox Mode"): only the Wayne avatar (dd73ea75-1218-4ef3-92ce-606d5f7fbc0a), sessions
  of about a minute, no credits.
* Outside the sandbox a session needs credit for at least one minute (faq/credits): 1 credit for LITE, 2 for FULL.

Responses are ``{code, data, message}``. The success code is 100 in the OpenAPI document and 1000 in the vendor's
web SDK 0.0.19; both are taken, as in apps/api/src/adapters/heygen-liveavatar.ts. Everything else is validated
strictly: a missing or mistyped field, a value outside a documented enum, a page count that changes between pages,
a duplicate id, or a page short of the stated count stops the run with the path and the reason, so a changed API
is noticed rather than catalogued wrong.

THE REPOSITORY IS PUBLIC. The key is never printed, never on a command line and never written: requests carry it
in a header only to api.liveavatar.com (redirects are refused, so it cannot follow one elsewhere; preview images
are never fetched), every message passes through ``Scrubber`` (which also hides a key a vendor message might
echo), and the outputs are checked not to contain it before they are written. Vendor bodies are never printed;
an error reports the path, the HTTP status, the envelope's code and at most 200 scrubbed characters of its message.

Outputs: ``catalog.json`` and ``catalog.md`` in ``--out-dir`` (the workflow uploads them as an artifact), and with
``--summary`` a step summary of counts only.

Dependencies: none (standard library). Python 3.12+.
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
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
CREDITS_PER_MINUTE = {"lite": Decimal(1), "full": Decimal(2)}

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
CREDITS_RE = re.compile(r"^[+-]?0*\d*\.?\d*$")


class CatalogError(Exception):
    """A request failed or a response does not have the documented shape. The message never holds the key."""


class Scrubber:
    """Replaces the API key with *** in anything printed; `leaks` also finds a 12-character piece of it."""

    def __init__(self, secret: str) -> None:
        self.secret = secret

    def __call__(self, text: str) -> str:
        if not self.secret:
            return text
        return text.replace(self.secret, "***")

    def leaks(self, text: str) -> bool:
        """Whether text holds the key or any 12-character piece of it (a truncated copy)."""
        if not self.secret:
            return False
        if self.secret in text:
            return True
        n = 12
        return len(self.secret) >= n and any(self.secret[i : i + n] in text for i in range(len(self.secret) - n + 1))


# A transport takes an API path and its query parameters and answers (HTTP status, body bytes).
Transport = Callable[[str, Mapping[str, str]], tuple[int, bytes]]


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """urllib would repeat the X-API-KEY header to a redirect's target: refuse every redirect instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def urllib_transport(api_key: str, base_url: str = API_BASE, timeout: float = HTTP_TIMEOUT_S) -> Transport:
    """The real transport: HTTPS GET with the key in X-API-KEY, no redirects, no proxies from the environment."""
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost"}:
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
            vendor = f" (code {code!r}: {self.scrub(' '.join(str(message).split()))[:200]})" if code is not None or message else ""
        if status != 200:
            hint = " (check the key: HEYGEN_LIVEAVATAR_API)" if status in {401, 403} else ""
            raise CatalogError(self.scrub(f"{where}: HTTP {status}{vendor}{hint}"))
        if not isinstance(envelope, dict):
            raise CatalogError(f"{where}: the response is not a JSON object")
        code = envelope.get("code")
        if type(code) is not int or code not in SUCCESS_CODES:
            raise CatalogError(self.scrub(f"{where}: unexpected envelope code{vendor or f' {code!r}'}"))
        if envelope.get("data") is None:
            raise CatalogError(self.scrub(f"{where}: the envelope has no data{vendor}"))
        return envelope["data"]

    def paginate(self, path: str, params: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
        """Every result of a paginated list, checking that the pages add up to the stated count exactly."""
        results: list[dict[str, Any]] = []
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
            if not isinstance(page_results, list) or not all(isinstance(item, dict) for item in page_results):
                raise CatalogError(f"{where}: results is not a list of objects")
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
        raise CatalogError(f"{where}: not an object")
    missing = sorted(set(required) - obj.keys())
    if missing:
        raise CatalogError(f"{where}: missing {', '.join(missing)}")
    return sorted(obj.keys() - set(known))


def _string(obj: Mapping[str, Any], key: str, where: str, *, optional: bool = False, nonempty: bool = True) -> str | None:
    value = obj.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise CatalogError(f"{where}: {key} is not a {'non-empty ' if nonempty else ''}string")
    return value


def _bool(obj: Mapping[str, Any], key: str, where: str, default: bool | None = None) -> bool:
    if key not in obj and default is not None:
        return default
    value = obj.get(key)
    if type(value) is not bool:
        raise CatalogError(f"{where}: {key} is not a boolean")
    return value


def _uuid(obj: Mapping[str, Any], key: str, where: str) -> str:
    value = _string(obj, key, where)
    if value is None or not UUID_RE.match(value):
        raise CatalogError(f"{where}: {key} is not a UUID")
    return value.lower()


def _timestamp(obj: Mapping[str, Any], key: str, where: str) -> str:
    value = _string(obj, key, where) or ""
    try:
        dt.datetime.fromisoformat(value)
    except ValueError:
        raise CatalogError(f"{where}: {key} is not an ISO 8601 date-time") from None
    return value


def _enum(obj: Mapping[str, Any], key: str, where: str, allowed: frozenset[str], default: str) -> str:
    value = obj.get(key, default)
    if not isinstance(value, str) or value not in allowed:
        shown = value if isinstance(value, str) and len(value) <= 40 else type(value).__name__
        raise CatalogError(f"{where}: {key} {shown!r} is not one of {', '.join(sorted(allowed))} (the documented values)")
    return value


def _https_url(obj: Mapping[str, Any], key: str, where: str) -> str | None:
    value = _string(obj, key, where, optional=True)
    if value is None or value == "":
        return None
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or any(c in value for c in "\r\n\t |<>\"'`"):
        raise CatalogError(f"{where}: {key} is not an https URL")
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
        raise CatalogError(f"{where}: tags is not a list of strings")
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
            raise CatalogError(f"{where}: voice_engines is not a list")
        for engine in engines:
            if not isinstance(engine, str) or engine not in VOICE_ENGINES:
                raise CatalogError(f"{where}: voice_engines holds {engine!r}, not one of {', '.join(sorted(VOICE_ENGINES))}")
        voice["voice_engines"] = engines
    return voice


def parse_credits(raw: Any) -> Decimal:
    where = "/v1/users/credits"
    _require_keys(raw, where, ("credits_left",), ("credits_left",))
    value = raw["credits_left"]
    # The schema says a decimal string; a bare number is taken too, since it cannot be misread.
    if type(value) in (int, float):
        value = str(value)
    if not isinstance(value, str) or not CREDITS_RE.match(value) or not re.search(r"\d", value):
        raise CatalogError(f"{where}: credits_left is not a decimal")
    try:
        return Decimal(value)
    except InvalidOperation:
        raise CatalogError(f"{where}: credits_left is not a decimal") from None


def _unique(items: Sequence[Mapping[str, Any]], what: str) -> None:
    duplicates = sorted(key for key, n in Counter(item["id"] for item in items).items() if n > 1)
    if duplicates:
        raise CatalogError(f"{what}: duplicate ids {', '.join(duplicates[:5])}")


def build_catalog(client: Client, *, voice_details: bool = True, now: dt.datetime | None = None) -> dict[str, Any]:
    """Reads the three lists, validates them and joins them into the catalogue (no key material)."""
    avatars = [parse_avatar(raw, f"/v1/avatars/public result {i}") for i, raw in enumerate(client.paginate("/v1/avatars/public"))]
    _unique(avatars, "/v1/avatars/public")
    voices = [
        parse_voice(raw, f"/v1/voices result {i}") for i, raw in enumerate(client.paginate("/v1/voices", {"voice_type": "public"}))
    ]
    _unique(voices, "/v1/voices")
    if voice_details:
        if len(voices) > MAX_VOICE_DETAILS:
            raise CatalogError(f"/v1/voices: {len(voices)} voices, more than the {MAX_VOICE_DETAILS} this reads details for")
        for voice in voices:
            where = f"/v1/voices/{voice['id']}"
            detail = parse_voice(client.get(where), where, detail=True)
            if detail["id"] != voice["id"]:
                raise CatalogError(f"{where}: the detail is for another voice")
            voice["voice_engines"] = detail["voice_engines"]
            voice["_unknown_fields"] = sorted(set(voice["_unknown_fields"]) | set(detail["_unknown_fields"]))
    credits = parse_credits(client.get("/v1/users/credits"))

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
        avatar["paid_lite_now"] = usable and credits >= CREDITS_PER_MINUTE["lite"]
        avatar["paid_full_now"] = usable and credits >= CREDITS_PER_MINUTE["full"]
    avatars.sort(key=lambda a: (not a["lite"], a["name"].casefold(), a["id"]))
    voices.sort(key=lambda v: (v["language"].casefold(), v["name"].casefold(), v["id"]))

    stamp = (now or dt.datetime.now(dt.UTC)).astimezone(dt.UTC).replace(microsecond=0).isoformat()
    return {
        "generated_at": stamp,
        "source": {
            "api": API_BASE,
            "openapi": OPENAPI_URL,
            "endpoints": ["GET /v1/avatars/public", "GET /v1/voices?voice_type=public", "GET /v1/voices/{id}", "GET /v1/users/credits"],
            "requests": client.requests,
        },
        "rules": {
            "lite": "status ACTIVE and not expired; LITE plays our own audio (HeyGen voices are FULL only)",
            "full": "status ACTIVE and not expired; needs a voice: the avatar's default voice or a voice_id",
            "sandbox": f"only avatar {SANDBOX_AVATAR_ID} (Wayne), sessions of about 60 s, no credits",
            "paid_now": "credits_left covers one minute: 1 credit for LITE, 2 for FULL",
            "gender": "avatars have no gender, age or style field; default_voice_gender is the gender of the avatar's default voice",
        },
        "account": {
            "credits_left": str(credits),
            "paid_lite_minutes": int(credits // CREDITS_PER_MINUTE["lite"]) if credits > 0 else 0,
            "paid_full_minutes": int(credits // CREDITS_PER_MINUTE["full"]) if credits > 0 else 0,
            "sandbox_avatar_listed": any(a["sandbox"] for a in avatars),
        },
        "unknown_fields": unknown_fields,
        "counts": counts(avatars, voices),
        "avatars": avatars,
        "voices": voices,
    }


def counts(avatars: Sequence[Mapping[str, Any]], voices: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {
        "avatars": len(avatars),
        "avatars_active": sum(a["status"] == "ACTIVE" for a in avatars),
        "avatars_expired": sum(a["is_expired"] for a in avatars),
        "avatars_1080p": sum(a["is_1080p"] for a in avatars),
        "avatars_lite": sum(a["lite"] for a in avatars),
        "avatars_full": sum(a["full"] for a in avatars),
        "avatars_with_default_voice": sum(a["default_voice"] is not None for a in avatars),
        "avatars_sandbox": sum(a["sandbox"] for a in avatars),
        "avatars_paid_lite_now": sum(a["paid_lite_now"] for a in avatars),
        "avatars_paid_full_now": sum(a["paid_full_now"] for a in avatars),
        "avatars_by_default_voice_gender": dict(sorted(Counter(a["default_voice_gender"] or "unknown" for a in avatars).items())),
        "voices": len(voices),
        "voices_by_gender": dict(sorted(Counter(v["gender"] or "unknown" for v in voices).items())),
        "voices_elevenlabs_engine": sum("elevenLabs" in (v.get("voice_engines") or []) for v in voices),
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


def render_markdown(catalog: Mapping[str, Any]) -> str:
    account = catalog["account"]
    lines = [
        "# HeyGen LiveAvatar catalogue",
        "",
        f"Generated {catalog['generated_at']} from {catalog['source']['api']} ({catalog['source']['requests']} requests).",
        "",
        "Rules applied (no API field says these; docs.liveavatar.com):",
        "",
        *(f"- **{name}**: {_cell(rule)}" for name, rule in catalog["rules"].items()),
        "",
        (
            f"Account: {_cell(account['credits_left'])} credits left, enough to start a paid LITE session: "
            f"{_cell(account['paid_lite_minutes'] > 0)}, a paid FULL session: {_cell(account['paid_full_minutes'] > 0)}. "
            f"Sandbox avatar in the public list: {_cell(account['sandbox_avatar_listed'])}."
        ),
        "",
    ]
    for kind in ("avatar", "voice"):
        if catalog["unknown_fields"][kind]:
            lines += [f"Undocumented {kind} fields seen (not catalogued): {_cell(catalog['unknown_fields'][kind])}.", ""]
    lines += [
        f"## Avatars ({len(catalog['avatars'])})",
        "",
        "| Name | Avatar id | Status | 1080p | Default voice | Voice gender | Voice language | LITE | FULL | Sandbox | Paid LITE now | Preview |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a in catalog["avatars"]:
        voice = a["default_voice"]
        status = a["status"] + (" (expired)" if a["is_expired"] else "")
        preview = f"[preview]({a['preview_url']})" if a["preview_url"] else ""
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
                    _cell(a["paid_lite_now"]),
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
    """The public step summary: fixed words and counts only (no names, ids, URLs or credits)."""
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
        ("Startable now outside the sandbox (LITE)", c["avatars_paid_lite_now"]),
        ("Startable now outside the sandbox (FULL)", c["avatars_paid_full_now"]),
        ("Stock voices (FULL only)", c["voices"]),
        ("Voices with the ElevenLabs engine", c["voices_elevenlabs_engine"]),
    ]
    rows += [(f"Avatars whose default voice is {_cell(g)}", n) for g, n in c["avatars_by_default_voice_gender"].items()]
    rows += [(f"Voices: {_cell(g)}", n) for g, n in c["voices_by_gender"].items()]
    lines = ["### HeyGen LiveAvatar catalogue", "", "| | Count |", "| --- | ---: |"]
    lines += [f"| {label} | {int(n)} |" for label, n in rows]
    lines += ["", "Names, ids and previews are in the run's `heygen-catalog` artifact."]
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


def main(argv: Sequence[str] | None = None, *, transport: Transport | None = None, sleep: Callable[[float], None] = time.sleep) -> int:
    parser = argparse.ArgumentParser(description="List HeyGen LiveAvatar's stock avatars and voices (key in HEYGEN_API_KEY).")
    parser.add_argument("--out-dir", type=Path, required=True, help="where catalog.json and catalog.md are written")
    parser.add_argument("--summary", type=Path, help="append a counts-only Markdown summary here (GITHUB_STEP_SUMMARY)")
    parser.add_argument("--no-voice-details", action="store_true", help="skip GET /v1/voices/{id} (no voice engines)")
    args = parser.parse_args(argv)

    api_key = os.environ.pop("HEYGEN_API_KEY", "").strip()
    scrub = Scrubber(api_key)
    if not api_key:
        print("HEYGEN_API_KEY is empty or not set.", file=sys.stderr)
        return 2
    try:
        client = Client(transport or urllib_transport(api_key), scrub, sleep=sleep)
        catalog = build_catalog(client, voice_details=not args.no_voice_details)
        write_outputs(catalog, args.out_dir, scrub, args.summary)
    except CatalogError as error:
        print(f"::error::HeyGen catalogue: {scrub(str(error))}")
        return 1
    c = catalog["counts"]
    print(f"Catalogued {c['avatars']} stock avatars ({c['avatars_lite']} usable in LITE) and {c['voices']} voices.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
