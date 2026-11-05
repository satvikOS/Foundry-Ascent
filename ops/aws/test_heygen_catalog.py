"""Tests for heygen_catalog.py against recorded fake LiveAvatar responses (testdata/heygen_catalog; no network).

The fixtures are shaped exactly as the vendor's OpenAPI document describes each response (2026-11-05): the
``{code, data, message}`` envelope, paginated ``{count, next, previous, results}`` lists, AvatarSchema, VoiceSchema,
VoiceDetailSchema and UserCreditsSchema. Wayne's id is the documented sandbox avatar; the other avatar ids are
documented stock looks; every voice is fake.
"""

from __future__ import annotations

import copy
import http.server
import json
import threading
import urllib.parse
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

import pytest

import heygen_catalog as hc

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "ops-heygen-catalog.yml"
FIXTURES = Path(__file__).resolve().parent / "testdata" / "heygen_catalog"
KEY = "hg_TEST_ONLY_not_a_key_0123456789abcdef"
WAYNE = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"
GRAHAM = "03f8332d-9046-42a1-bff3-3b2309f77b58"
KATYA = "09919247-f4b2-45d8-a75e-86fc2fceaebf"
RETIRED = "6b0e2f4a-8c1d-4e3b-9f5a-7d2c0e4b6a81"
V1 = "5f1c2a7e-0b3d-4c8e-9a61-2d7f4b8c9e01"
V2 = "8a4e6b2c-1d3f-4e5a-b7c9-0f2e4d6a8b13"


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def recorded() -> dict[tuple[str, str], dict[str, Any]]:
    """(path, page) -> envelope; page is '' for unpaginated paths."""
    return {
        ("/v1/avatars/public", "1"): fixture("avatars_public_page1.json"),
        ("/v1/avatars/public", "2"): fixture("avatars_public_page2.json"),
        ("/v1/voices", "1"): fixture("voices_public_page1.json"),
        (f"/v1/voices/{V1}", ""): fixture(f"voice_{V1}.json"),
        (f"/v1/voices/{V2}", ""): fixture(f"voice_{V2}.json"),
        ("/v1/users/credits", ""): fixture("users_credits.json"),
    }


class FakeApi:
    """A transport that serves the recorded responses, after any queued (status, body) overrides for a path."""

    def __init__(self, responses: Mapping[tuple[str, str], Any] | None = None) -> None:
        self.responses = dict(responses if responses is not None else recorded())
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.queued: dict[str, list[tuple[int, bytes]]] = {}

    def queue(self, path: str, status: int, body: Any) -> None:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.queued.setdefault(path, []).append((status, raw))

    def __call__(self, path: str, params: Mapping[str, str]) -> tuple[int, bytes]:
        self.calls.append((path, dict(params)))
        if self.queued.get(path):
            return self.queued[path].pop(0)
        key = (path, params.get("page", ""))
        if key not in self.responses:
            return 404, json.dumps({"code": 404, "message": "Not Found", "data": None}).encode()
        return 200, json.dumps(self.responses[key]).encode()


def client(api: FakeApi, sleeps: list[float] | None = None) -> hc.Client:
    return hc.Client(api, hc.Scrubber(KEY), sleep=(sleeps.append if sleeps is not None else lambda _s: None))


def build(api: FakeApi | None = None, **kwargs: Any) -> dict[str, Any]:
    return hc.build_catalog(client(api or FakeApi()), **kwargs)


def by_id(catalog: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {a["id"]: a for a in catalog["avatars"]}


# --- the catalogue ---------------------------------------------------------------------------------------------


def test_the_catalogue_lists_every_stock_avatar_and_voice_with_documented_fields() -> None:
    api = FakeApi()
    catalog = build(api)
    assert [a["name"] for a in catalog["avatars"]] == ["Graham in Black Suit", "Katya in Pink Suit", "Wayne", "Retired | Look"]
    graham = by_id(catalog)[GRAHAM]
    assert graham == {
        "id": GRAHAM,
        "name": "Graham in Black Suit",
        "type": "VIDEO",
        "status": "ACTIVE",
        "is_1080p": True,
        "is_expired": False,
        "preview_url": "https://files.liveavatar.example/previews/graham.png",
        "default_voice": {"id": V1, "name": "Fake Voice One"},
        "default_voice_agent_id": None,
        "created_at": "2026-01-12T09:30:00Z",
        "updated_at": "2026-10-01T12:00:00.123456Z",
        "has_error_message": False,
        "default_voice_gender": "male",
        "default_voice_language": "English",
        "default_voice_engines": ["elevenLabs"],
        "lite": True,
        "full": True,
        "full_needs_voice_id": False,
        "sandbox": False,
        "paid_lite_now": True,
        "paid_full_now": True,
    }
    assert [v["id"] for v in catalog["voices"]] == [V1, V2]
    assert catalog["voices"][1]["voice_engines"] == ["fish", "cartesia"]
    assert catalog["voices"][1]["description"] is None
    # Every page asked for 100 (the documented maximum), public voices only, and one detail per voice.
    assert api.calls == [
        ("/v1/avatars/public", {"page": "1", "page_size": "100"}),
        ("/v1/avatars/public", {"page": "2", "page_size": "100"}),
        ("/v1/voices", {"voice_type": "public", "page": "1", "page_size": "100"}),
        (f"/v1/voices/{V1}", {}),
        (f"/v1/voices/{V2}", {}),
        ("/v1/users/credits", {}),
    ]
    assert catalog["source"]["requests"] == 6
    assert catalog["unknown_fields"] == {"avatar": [], "voice": []}


def test_documented_rules_mark_lite_full_sandbox_and_plan() -> None:
    avatars = by_id(build())
    assert avatars[WAYNE]["sandbox"] is True
    assert sum(a["sandbox"] for a in avatars.values()) == 1
    # No default voice: still usable in FULL, but a session must name a voice.
    assert avatars[KATYA]["full"] is True and avatars[KATYA]["full_needs_voice_id"] is True
    assert avatars[KATYA]["default_voice_gender"] is None
    # Deactivated and expired: usable nowhere.
    retired = avatars[RETIRED]
    assert (retired["lite"], retired["full"], retired["paid_lite_now"], retired["full_needs_voice_id"]) == (False, False, False, False)


@pytest.mark.parametrize(
    ("credits_left", "lite", "full", "lite_minutes", "full_minutes"),
    [("10.0", True, True, 10, 5), ("1.5", True, False, 1, 0), ("0", False, False, 0, 0), ("-3", False, False, 0, 0)],
)
def test_paid_sessions_need_credit_for_one_minute(credits_left: str, lite: bool, full: bool, lite_minutes: int, full_minutes: int) -> None:
    responses = recorded()
    responses[("/v1/users/credits", "")] = {"code": 100, "data": {"credits_left": credits_left}, "message": "ok"}
    catalog = build(FakeApi(responses))
    graham = by_id(catalog)[GRAHAM]
    assert (graham["paid_lite_now"], graham["paid_full_now"]) == (lite, full)
    assert (catalog["account"]["paid_lite_minutes"], catalog["account"]["paid_full_minutes"]) == (lite_minutes, full_minutes)
    assert catalog["account"]["credits_left"] == str(hc.Decimal(credits_left))


def test_counts() -> None:
    counts = build()["counts"]
    assert counts == {
        "avatars": 4,
        "avatars_active": 3,
        "avatars_expired": 1,
        "avatars_1080p": 2,
        "avatars_lite": 3,
        "avatars_full": 3,
        "avatars_with_default_voice": 3,
        "avatars_sandbox": 1,
        "avatars_paid_lite_now": 3,
        "avatars_paid_full_now": 3,
        "avatars_by_default_voice_gender": {"female": 1, "male": 2, "unknown": 1},
        "voices": 2,
        "voices_by_gender": {"female": 1, "male": 1},
        "voices_elevenlabs_engine": 1,
    }


def test_without_voice_details_engines_are_left_out() -> None:
    api = FakeApi()
    catalog = build(api, voice_details=False)
    assert all("voice_engines" not in v for v in catalog["voices"])
    assert not any(path.startswith("/v1/voices/") for path, _ in api.calls)
    assert catalog["counts"]["voices_elevenlabs_engine"] == 0


def test_undocumented_fields_are_reported_not_catalogued() -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "1")]["data"]["results"][0]["age_group"] = "adult"
    catalog = build(FakeApi(responses))
    assert catalog["unknown_fields"]["avatar"] == ["age_group"]
    assert all("age_group" not in a for a in catalog["avatars"])
    assert "Undocumented avatar fields seen (not catalogued): age\\_group." in hc.render_markdown(catalog)


# --- strict validation -----------------------------------------------------------------------------------------


def mutate_avatar(change: Callable[[dict[str, Any]], None]) -> FakeApi:
    responses = recorded()
    change(responses[("/v1/avatars/public", "1")]["data"]["results"][1])
    return FakeApi(responses)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda a: a.pop("id"), "missing id"),
        (lambda a: a.pop("is_expired"), "missing is_expired"),
        (lambda a: a.update(id="not-a-uuid"), "id is not a UUID"),
        (lambda a: a.update(name=""), "name is not a non-empty string"),
        (lambda a: a.update(status="RETIRED"), "status 'RETIRED' is not one of"),
        (lambda a: a.update(type="CARTOON"), "type 'CARTOON' is not one of"),
        (lambda a: a.update(is_1080p="yes"), "is_1080p is not a boolean"),
        (lambda a: a.update(is_expired=0), "is_expired is not a boolean"),
        (lambda a: a.update(preview_url="http://insecure.example/x.png"), "preview_url is not an https URL"),
        (lambda a: a.update(preview_url="https://x.example/a.png) [x](https://evil.example"), "preview_url is not an https URL"),
        (lambda a: a.update(default_voice={"id": V1}), "default_voice: missing name"),
        (lambda a: a.update(default_voice="Fake Voice One"), "default_voice: not an object"),
        (lambda a: a.update(created_at="yesterday"), "created_at is not an ISO 8601 date-time"),
        (lambda a: a.update(error_message=7), "error_message is not a string"),
    ],
)
def test_a_malformed_avatar_stops_the_run(change: Callable[[dict[str, Any]], None], message: str) -> None:
    with pytest.raises(hc.CatalogError, match="/v1/avatars/public result 1") as error:
        build(mutate_avatar(change))
    assert message in str(error.value)


@pytest.mark.parametrize(
    ("path", "page", "change", "message"),
    [
        ("/v1/voices", "1", lambda d: d["results"][0].pop("gender"), "missing gender"),
        ("/v1/voices", "1", lambda d: d["results"][0].update(tags="calm"), "tags is not a list of strings"),
        ("/v1/voices", "1", lambda d: d["results"][0].update(tags=[1]), "tags is not a list of strings"),
        (f"/v1/voices/{V1}", "", lambda d: d.update(voice_engines=["polly"]), "voice_engines holds 'polly'"),
        (f"/v1/voices/{V1}", "", lambda d: d.update(voice_engines="elevenLabs"), "voice_engines is not a list"),
        (f"/v1/voices/{V1}", "", lambda d: d.update(id=V2), "the detail is for another voice"),
        ("/v1/users/credits", "", lambda d: d.update(credits_left="ten"), "credits_left is not a decimal"),
        ("/v1/users/credits", "", lambda d: d.update(credits_left="."), "credits_left is not a decimal"),
        ("/v1/users/credits", "", lambda d: d.pop("credits_left"), "missing credits_left"),
    ],
)
def test_a_malformed_voice_or_credit_stops_the_run(path: str, page: str, change: Callable[[dict[str, Any]], None], message: str) -> None:
    responses = recorded()
    change(responses[(path, page)]["data"])
    with pytest.raises(hc.CatalogError) as error:
        build(FakeApi(responses))
    assert message in str(error.value)


@pytest.mark.parametrize(
    ("envelope", "message"),
    [
        ({"code": 2000, "data": {"count": 0, "results": []}, "message": "odd"}, "unexpected envelope code (code 2000: odd)"),
        ({"code": "100", "data": {"count": 0, "results": []}}, "unexpected envelope code"),
        ({"data": {"count": 0, "results": []}}, "unexpected envelope code"),
        ({"code": 100, "data": None, "message": "nothing"}, "the envelope has no data"),
        ([], "not a JSON object"),
        ({"code": 100, "data": {"results": []}}, "missing count"),
        ({"code": 100, "data": {"count": -1, "results": []}}, "count is not a non-negative integer"),
        ({"code": 100, "data": {"count": 1, "results": {}}}, "results is not a list of objects"),
        ({"code": 100, "data": {"count": 1, "results": [], "next": 2}}, "next is not a string or null"),
        ({"code": 100, "data": {"count": 1, "results": []}}, "empty page with 0 of 1 results read"),
        ({"code": 100, "data": {"count": 0, "results": [{}]}}, "more results (1) than the stated count (0)"),
    ],
)
def test_a_malformed_envelope_or_page_stops_the_run(envelope: Any, message: str) -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "1")] = envelope
    with pytest.raises(hc.CatalogError) as error:
        build(FakeApi(responses))
    assert message in str(error.value)


def test_both_documented_success_codes_are_taken() -> None:
    responses = recorded()
    assert responses[("/v1/avatars/public", "1")]["code"] == 1000
    assert responses[("/v1/users/credits", "")]["code"] == 100
    build(FakeApi(responses))


def test_a_count_that_changes_between_pages_stops_the_run() -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "2")]["data"]["count"] = 5
    with pytest.raises(hc.CatalogError, match="count changed from 4 to 5 while paging"):
        build(FakeApi(responses))


def test_a_duplicate_avatar_stops_the_run() -> None:
    responses = recorded()
    page2 = responses[("/v1/avatars/public", "2")]["data"]["results"]
    page2[0] = copy.deepcopy(responses[("/v1/avatars/public", "1")]["data"]["results"][0])
    with pytest.raises(hc.CatalogError, match=f"duplicate ids {WAYNE}"):
        build(FakeApi(responses))


def test_paging_stops_after_the_page_limit() -> None:
    api = FakeApi()
    page = {"code": 100, "data": {"count": 10_000, "results": [{}]}, "message": ""}
    for n in range(1, hc.MAX_PAGES + 2):
        api.responses[("/v1/avatars/public", str(n))] = page
    with pytest.raises(hc.CatalogError, match=f"more than {hc.MAX_PAGES} pages"):
        client(api).paginate("/v1/avatars/public")
    assert len(api.calls) == hc.MAX_PAGES


# --- HTTP failures, retries and the key ------------------------------------------------------------------------


def test_throttling_and_server_errors_are_retried_with_backoff() -> None:
    api = FakeApi()
    api.queue("/v1/users/credits", 429, {"code": 429, "message": "Too many requests"})
    api.queue("/v1/users/credits", 503, b"")
    sleeps: list[float] = []
    catalog = hc.build_catalog(client(api, sleeps))
    assert catalog["account"]["credits_left"] == "10.0"
    assert [s for s in sleeps if s != hc.REQUEST_INTERVAL_S] == [1.0, 2.0]
    # Every request after the first waits the interval (5 per second, under the documented 10).
    assert sleeps.count(hc.REQUEST_INTERVAL_S) == len(api.calls) - 1


def test_retries_give_up() -> None:
    api = FakeApi()
    for _ in range(len(hc.RETRY_DELAYS_S) + 1):
        api.queue("/v1/avatars/public", 502, b"<html>bad gateway</html>")
    with pytest.raises(hc.CatalogError, match=r"^/v1/avatars/public\?page=1&page_size=100: HTTP 502$"):
        build(api)
    assert len(api.calls) == len(hc.RETRY_DELAYS_S) + 1


def test_network_errors_are_retried_then_reported() -> None:
    calls: list[str] = []

    def broken(path: str, _params: Mapping[str, str]) -> tuple[int, bytes]:
        calls.append(path)
        raise hc.urllib.error.URLError(f"no route ({KEY})")

    with pytest.raises(hc.CatalogError) as error:
        hc.Client(broken, hc.Scrubber(KEY), sleep=lambda _s: None).get("/v1/users/credits")
    assert len(calls) == len(hc.RETRY_DELAYS_S) + 1
    assert "request failed (URLError: no route (***))" in str(error.value)
    assert KEY not in str(error.value)


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_says_which_secret_and_never_echoes_it(status: int) -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", status, {"code": status, "message": f"Invalid API key {KEY}", "data": None})
    with pytest.raises(hc.CatalogError) as error:
        build(api)
    text = str(error.value)
    assert KEY not in text
    assert f"HTTP {status} (code {status}: Invalid API key ***) (check the key: HEYGEN_LIVEAVATAR_API)" in text


def test_a_vendor_message_is_cut_to_200_characters() -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", 400, {"code": 400, "message": "x" * 5000})
    with pytest.raises(hc.CatalogError) as error:
        build(api)
    assert len(str(error.value)) < 300


def test_the_scrubber_finds_a_truncated_key() -> None:
    scrub = hc.Scrubber(KEY)
    assert scrub(f"a {KEY} b") == "a *** b"
    assert scrub.leaks(KEY[5:20])
    assert not scrub.leaks(KEY[:11])
    assert not hc.Scrubber("").leaks("anything")


# --- main: outputs, summary, the key ---------------------------------------------------------------------------


def run_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, api: FakeApi, key: str | None = KEY, extra: tuple[str, ...] = ()) -> tuple[int, Path, Path]:
    out = tmp_path / "out"
    summary = tmp_path / "summary.md"
    if key is None:
        monkeypatch.delenv("HEYGEN_API_KEY", raising=False)
    else:
        monkeypatch.setenv("HEYGEN_API_KEY", f" {key}\n")
    rc = hc.main(["--out-dir", str(out), "--summary", str(summary), *extra], transport=api, sleep=lambda _s: None)
    return rc, out, summary


def test_main_writes_json_markdown_and_a_counts_only_summary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    rc, out, summary = run_main(tmp_path, monkeypatch, FakeApi())
    assert rc == 0
    assert "HEYGEN_API_KEY" not in hc.os.environ  # taken out of the environment once read
    catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    assert catalog["counts"]["avatars"] == 4
    markdown = (out / "catalog.md").read_text(encoding="utf-8")
    assert f"| Graham in Black Suit | `{GRAHAM}` | ACTIVE | yes | Fake Voice One | male | English | yes | yes | no | yes | [preview](https://files.liveavatar.example/previews/graham.png) |" in markdown
    assert "| Retired \\| Look |" in markdown  # a pipe in a name cannot break the table
    assert f"| Fake Voice Two | `{V2}` | female | English | fish, cartesia |  |  |" in markdown
    text = summary.read_text(encoding="utf-8")
    assert "| Stock avatars | 4 |" in text and "| Usable in the sandbox | 1 |" in text
    # Counts only: no names, ids, URLs or credits in the public summary.
    for private in ("Graham", "Wayne", "Fake Voice", GRAHAM, WAYNE, V1, "https://", "10.0", "credits_left"):
        assert private not in text
    log = capsys.readouterr()
    assert log.out == "Catalogued 4 stock avatars (3 usable in LITE) and 2 voices.\n" and log.err == ""
    for path in (out / "catalog.json", out / "catalog.md", summary):
        assert KEY not in path.read_text(encoding="utf-8")


def test_main_fails_without_the_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeApi()
    rc, out, _ = run_main(tmp_path, monkeypatch, api, key=None)
    assert rc == 2 and api.calls == [] and not out.exists()
    rc, out, _ = run_main(tmp_path, monkeypatch, api, key="   ")
    assert rc == 2 and api.calls == [] and not out.exists()


def test_main_reports_an_error_without_the_key_and_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", 401, {"code": 401, "message": f"bad key {KEY}"})
    rc, out, summary = run_main(tmp_path, monkeypatch, api)
    log = capsys.readouterr()
    assert rc == 1
    assert log.out.startswith("::error::HeyGen catalogue: /v1/avatars/public?page=1&page_size=100: HTTP 401 (code 401: bad key ***)")
    assert KEY not in log.out + log.err
    assert not out.exists() and not summary.exists()


def test_main_refuses_to_write_output_that_holds_the_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "1")]["data"]["results"][0]["name"] = f"Wayne {KEY[3:20]}"
    rc, out, _ = run_main(tmp_path, monkeypatch, FakeApi(responses))
    assert rc == 1 and not out.exists()
    assert "refusing to write catalog.json: it would contain part of the API key" in capsys.readouterr().out


# --- the real transport against a local server -----------------------------------------------------------------


@pytest.fixture
def local_api() -> Iterator[tuple[str, list[dict[str, Any]]]]:
    seen: list[dict[str, Any]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            url = urllib.parse.urlsplit(self.path)
            seen.append({"path": url.path, "query": url.query, "key": self.headers.get("X-API-KEY")})
            if url.path == "/v1/redirect":
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.2:9/steal")
                self.end_headers()
                return
            body = json.dumps({"code": 100, "data": {"credits_left": "3"}, "message": "ok"}).encode()
            self.send_response(200 if url.path == "/v1/users/credits" else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()


def test_the_transport_sends_the_key_only_in_its_header(local_api: tuple[str, list[dict[str, Any]]]) -> None:
    base, seen = local_api
    get = hc.urllib_transport(KEY, base, timeout=5)
    status, body = get("/v1/users/credits", {"b": "2", "a": "1"})
    assert status == 200 and json.loads(body)["data"] == {"credits_left": "3"}
    assert seen == [{"path": "/v1/users/credits", "query": "a=1&b=2", "key": KEY}]
    assert get("/v1/missing", {})[0] == 404


def test_the_transport_refuses_redirects(local_api: tuple[str, list[dict[str, Any]]]) -> None:
    base, seen = local_api
    status, _ = hc.urllib_transport(KEY, base, timeout=5)("/v1/redirect", {})
    assert status == 302
    assert [s["path"] for s in seen] == ["/v1/redirect"]


def test_the_transport_refuses_plain_http_and_odd_paths() -> None:
    with pytest.raises(hc.CatalogError, match="must be https"):
        hc.urllib_transport(KEY, "http://api.liveavatar.com")
    get = hc.urllib_transport(KEY)
    for path in ("https://elsewhere.example/v1/x", "/v2/embeddings", "/v1/../admin"):
        with pytest.raises(hc.CatalogError, match="refusing to request"):
            get(path, {})


# --- the workflow ----------------------------------------------------------------------------------------------


def test_the_workflow_runs_from_main_only_and_keeps_the_key_off_the_log() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "on:\n  workflow_dispatch:\n" in text
    assert "permissions: {}" in text
    assert "    if: github.ref == 'refs/heads/main'\n" in text
    assert "    environment: production\n" in text
    assert "    permissions:\n      contents: read\n" in text
    assert "persist-credentials: false" in text
    # The secret reaches exactly two steps, each through the environment: the check and the catalogue.
    assert text.count("${{ secrets.HEYGEN_LIVEAVATAR_API }}") == 2
    for line in text.splitlines():
        if "secrets.HEYGEN_LIVEAVATAR_API" in line:
            assert line.strip().startswith(("HEYGEN_KEY:", "HEYGEN_API_KEY:")), line
    assert "python -I ops/aws/heygen_catalog.py" in text
    assert "::add-mask::" in text
    assert "name: heygen-catalog" in text and "retention-days: 7" in text
