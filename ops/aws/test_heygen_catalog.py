"""Tests for heygen_catalog.py against recorded fake LiveAvatar responses (testdata/heygen_catalog; no network).

The fixtures are shaped exactly as the vendor's OpenAPI document describes each response (2026-11-05): the
``{code, data, message}`` envelope, paginated ``{count, next, previous, results}`` lists, AvatarSchema, VoiceSchema
and VoiceDetailSchema. Wayne's id is the documented sandbox avatar; the other avatar ids are documented stock looks;
every voice is fake. Preview images are fake bytes built here (PNG and WebP headers), served by a fake fetcher or a
local server.
"""

from __future__ import annotations

import copy
import http.server
import json
import struct
import threading
import time
import urllib.parse
import zlib
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

import pytest

import heygen_catalog as hc

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "ops-heygen-catalog.yml"
RUNBOOK = REPO / "docs" / "runbooks" / "avatars.md"
FIXTURES = Path(__file__).resolve().parent / "testdata" / "heygen_catalog"
KEY = "hg_TEST_ONLY_not_a_key_0123456789abcdef"
WAYNE = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"
GRAHAM = "03f8332d-9046-42a1-bff3-3b2309f77b58"
KATYA = "09919247-f4b2-45d8-a75e-86fc2fceaebf"
RETIRED = "6b0e2f4a-8c1d-4e3b-9f5a-7d2c0e4b6a81"
V1 = "5f1c2a7e-0b3d-4c8e-9a61-2d7f4b8c9e01"
V2 = "8a4e6b2c-1d3f-4e5a-b7c9-0f2e4d6a8b13"
PREVIEWS = "https://files.liveavatar.example/previews/"
TEST_DOMAINS = ("liveavatar.example",)


# --- fake images -----------------------------------------------------------------------------------------------


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(color_type: int, *, trns: bool = False, before_idat: bytes = b"") -> bytes:
    """A 2x2 PNG of the colour type (0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA), optionally with tRNS."""
    chunks = _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, color_type, 0, 0, 0))
    if color_type == 3:
        chunks += _png_chunk(b"PLTE", b"\x00\xff\x00\x00\x00\x00")
    chunks += before_idat
    if trns:
        chunks += _png_chunk(b"tRNS", b"\x00")
    chunks += _png_chunk(b"IDAT", zlib.compress(b"\x00" * 24)) + _png_chunk(b"IEND", b"")
    return b"\x89PNG\r\n\x1a\n" + chunks


def webp(chunk: bytes, payload: bytes) -> bytes:
    body = b"WEBP" + chunk + struct.pack("<I", len(payload)) + payload
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_vp8x(alpha: bool) -> bytes:
    return webp(b"VP8X", bytes([0x10 if alpha else 0x00, 0, 0, 0]) + b"\x01\x00\x00\x01\x00\x00")


def webp_vp8l(alpha: bool) -> bytes:
    bits = (1 << 0) | (1 << 14) | ((1 if alpha else 0) << 28)  # 2x2, then the alpha_is_used bit
    return webp(b"VP8L", b"\x2f" + bits.to_bytes(4, "little") + b"\x00" * 8)


WEBP_LOSSY = webp(b"VP8 ", b"\x00" * 16)


class FakePreviews:
    """A preview fetcher: url -> bytes (or an exception to raise), recording every URL it was asked for."""

    def __init__(self, images: Mapping[str, bytes | Exception] | None = None) -> None:
        self.images = dict(
            images
            if images is not None
            else {
                PREVIEWS + "wayne.webp": WEBP_LOSSY,  # a full scene: no alpha
                PREVIEWS + "graham.png": png(2),  # RGB: no alpha
                PREVIEWS + "katya.png": png(6),  # RGBA: a transparent cutout (studio)
            }
        )
        self.calls: list[str] = []
        self.lock = threading.Lock()

    def __call__(self, url: str) -> bytes:
        with self.lock:
            self.calls.append(url)
        image = self.images.get(url, OSError("404"))
        if isinstance(image, Exception):
            raise image
        return image


# --- the fake API ----------------------------------------------------------------------------------------------


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


def build(api: FakeApi | None = None, previews: FakePreviews | None = None, **kwargs: Any) -> dict[str, Any]:
    kwargs.setdefault("preview_domains", TEST_DOMAINS)
    return hc.build_catalog(client(api or FakeApi()), preview_fetch=previews or FakePreviews(), **kwargs)


def by_id(catalog: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {a["id"]: a for a in catalog["avatars"]}


def assert_no_key_piece(text: str, key: str = KEY) -> None:
    """No 12-character piece of the key, and no 4-character start or end of it standing as its own fragment."""
    for i in range(len(key) - 11):
        assert key[i : i + 12] not in text, f"piece {i} of the key leaked"
    assert f" {key[:4]}" not in f" {text}" and f"{key[-4:]} " not in f"{text} "


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
        "preview_url": PREVIEWS + "graham.png",
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
        "likely_green_screen": False,
        "preview_check": "no alpha channel",
    }
    assert [v["id"] for v in catalog["voices"]] == [V1, V2]
    assert catalog["voices"][1]["voice_engines"] == ["fish", "cartesia"]
    assert catalog["voices"][1]["description"] is None
    # Every page asked for 100 (the documented maximum), public voices only, one detail per voice, and no credits.
    assert api.calls == [
        ("/v1/avatars/public", {"page": "1", "page_size": "100"}),
        ("/v1/avatars/public", {"page": "2", "page_size": "100"}),
        ("/v1/voices", {"voice_type": "public", "page": "1", "page_size": "100"}),
        (f"/v1/voices/{V1}", {}),
        (f"/v1/voices/{V2}", {}),
    ]
    assert catalog["source"]["requests"] == 5
    assert catalog["unknown_fields"] == {"avatar": [], "voice": []}
    assert catalog["skipped"] == {"avatars": {}, "voices": {}, "voice_details": {}}


def test_documented_rules_mark_lite_full_and_sandbox() -> None:
    avatars = by_id(build())
    assert avatars[WAYNE]["sandbox"] is True
    assert sum(a["sandbox"] for a in avatars.values()) == 1
    # No default voice: still usable in FULL, but a session must name a voice.
    assert avatars[KATYA]["full"] is True and avatars[KATYA]["full_needs_voice_id"] is True
    assert avatars[KATYA]["default_voice_gender"] is None
    # Deactivated and expired: usable nowhere.
    retired = avatars[RETIRED]
    assert (retired["lite"], retired["full"], retired["full_needs_voice_id"]) == (False, False, False)


def test_the_catalogue_holds_no_account_data() -> None:
    """The artifact of a public repository's run can be downloaded by any signed-in GitHub user."""
    api = FakeApi()
    catalog = build(api)
    assert not any(path.startswith("/v1/users") for path, _ in api.calls)
    assert "account" not in catalog
    for avatar in catalog["avatars"]:
        assert not [field for field in avatar if "credit" in field or "paid" in field]
    assert not [field for field in catalog["counts"] if "credit" in field or "paid" in field]
    markdown = hc.render_markdown(catalog)
    assert "credits left" not in markdown and "Paid LITE now" not in markdown
    assert "Public stock metadata only: no account data" in markdown


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
        "avatars_likely_green_screen": 1,
        "avatars_preview_unchecked": 1,
        "avatars_by_default_voice_gender": {"female": 1, "male": 2, "unknown": 1},
        "avatars_skipped": 0,
        "voices": 2,
        "voices_by_gender": {"female": 1, "male": 1},
        "voices_elevenlabs_engine": 1,
        "voices_skipped": 0,
        "voice_details_skipped": 0,
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


# --- green-screen studio avatars (preview alpha) ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("head", "alpha"),
    [
        (png(6), True),
        (png(4), True),
        (png(2, trns=True), True),
        (png(3, trns=True), True),
        (png(0, trns=True), True),
        (png(2), False),
        (png(3), False),
        (png(0), False),
        (png(2)[:40], None),  # cut off before the image data: cannot tell
        (png(2, before_idat=_png_chunk(b"iCCP", b"x" * 5000))[:1000], None),
        (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"tRNS", b"\x00"), None),  # no IHDR first
        (webp_vp8x(True), True),
        (webp_vp8x(False), False),
        (webp_vp8l(True), True),
        (webp_vp8l(False), False),
        (WEBP_LOSSY, False),
        (b"\xff\xd8\xff\xe0" + b"\x00" * 20, False),  # JPEG
        (b"GIF89a" + b"\x00" * 20, None),
        (b"<html>not an image</html>", None),
        (b"", None),
    ],
)
def test_image_alpha_is_read_from_the_first_bytes(head: bytes, alpha: bool | None) -> None:
    assert hc.image_has_alpha(head) is alpha


def test_a_transparent_preview_marks_a_likely_green_screen_avatar() -> None:
    previews = FakePreviews()
    catalog = build(previews=previews)
    avatars = by_id(catalog)
    assert (avatars[KATYA]["likely_green_screen"], avatars[KATYA]["preview_check"]) == (True, "alpha channel")
    assert (avatars[WAYNE]["likely_green_screen"], avatars[WAYNE]["preview_check"]) == (False, "no alpha channel")
    assert (avatars[RETIRED]["likely_green_screen"], avatars[RETIRED]["preview_check"]) == (None, "no preview")
    assert sorted(previews.calls) == sorted([PREVIEWS + "wayne.webp", PREVIEWS + "graham.png", PREVIEWS + "katya.png"])
    markdown = hc.render_markdown(catalog)
    assert "| Green screen (likely) |" in markdown
    assert f"| Katya in Pink Suit | `{KATYA}` | ACTIVE | yes |  |  |  | yes | yes | no | yes | [preview]({PREVIEWS}katya.png) |" in markdown
    assert "| ? (no preview) |" in markdown


def test_previews_off_the_vendor_domains_are_never_fetched() -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "1")]["data"]["results"][1]["preview_url"] = "https://attacker.example/graham.png"
    previews = FakePreviews()
    avatars = by_id(build(FakeApi(responses), previews))
    assert (avatars[GRAHAM]["likely_green_screen"], avatars[GRAHAM]["preview_check"]) == (None, "host not allowed")
    assert all("attacker.example" not in url for url in previews.calls)


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://files.heygen.ai/a.png", True),
        ("https://heygen.ai/a.png", True),
        ("https://cdn.liveavatar.com/p/a.webp", True),
        ("https://files.heygen.com:443/a.png", True),
        ("https://FILES.HEYGEN.AI./a.png", True),
        ("http://files.heygen.ai/a.png", False),
        ("https://heygen.ai.attacker.example/a.png", False),
        ("https://notheygen.ai/a.png", False),
        ("https://user:pw@files.heygen.ai/a.png", False),
        ("https://files.heygen.ai:8443/a.png", False),
        ("https://files.heygen.ai:bad/a.png", False),
        ("https:///a.png", False),
    ],
)
def test_only_https_previews_on_the_vendor_domains_are_allowed(url: str, allowed: bool) -> None:
    assert hc.preview_host_allowed(url) is allowed


def test_a_failed_or_unreadable_preview_is_reported_and_the_run_goes_on() -> None:
    previews = FakePreviews(
        {
            PREVIEWS + "wayne.webp": TimeoutError("slow"),
            PREVIEWS + "graham.png": b"<html>Access denied</html>",
            PREVIEWS + "katya.png": png(6),
        }
    )
    avatars = by_id(build(previews=previews))
    assert (avatars[WAYNE]["likely_green_screen"], avatars[WAYNE]["preview_check"]) == (None, "fetch failed")
    assert (avatars[GRAHAM]["likely_green_screen"], avatars[GRAHAM]["preview_check"]) == (None, "unknown image format")
    assert avatars[KATYA]["likely_green_screen"] is True


def test_without_a_fetcher_no_preview_is_checked() -> None:
    catalog = hc.build_catalog(client(FakeApi()))
    assert {a["preview_check"] for a in catalog["avatars"]} == {"not checked"}
    assert catalog["counts"]["avatars_preview_unchecked"] == 4


def preview_avatars(n: int, url: Callable[[int], str] = lambda i: f"{PREVIEWS}{i}.png") -> list[dict[str, Any]]:
    return [{"preview_url": url(i)} for i in range(n)]


def test_previews_are_fetched_a_few_at_a_time_and_once_per_url() -> None:
    active = 0
    peak = 0
    lock = threading.Lock()
    calls: list[str] = []

    def slow(url: str) -> bytes:
        nonlocal active, peak
        with lock:
            calls.append(url)
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with lock:
            active -= 1
        return png(6)

    avatars = preview_avatars(12) + preview_avatars(3)  # the last three repeat the first three URLs
    hc.check_previews(avatars, slow, domains=TEST_DOMAINS, workers=3)
    assert peak <= 3
    assert sorted(calls) == sorted({a["preview_url"] for a in avatars})
    assert all(a["likely_green_screen"] is True for a in avatars)


def test_previews_stop_at_the_time_budget_and_the_check_limit() -> None:
    release = threading.Event()

    def stuck(_url: str) -> bytes:
        release.wait(5)
        return png(6)

    avatars = preview_avatars(4)
    try:
        started = time.monotonic()
        hc.check_previews(avatars, stuck, domains=TEST_DOMAINS, workers=2, budget_s=0.1)
        assert time.monotonic() - started < 2
    finally:
        release.set()
    assert {a["preview_check"] for a in avatars} == {"over the time budget"}
    assert all(a["likely_green_screen"] is None for a in avatars)

    avatars = preview_avatars(5)
    hc.check_previews(avatars, lambda _url: png(2), domains=TEST_DOMAINS, limit=2)
    assert [a["preview_check"] for a in avatars] == ["no alpha channel"] * 2 + ["over the check limit"] * 3


# --- validation: strict envelope and paging, per item for avatars and voices -------------------------------------


def mutate_avatar(change: Callable[[dict[str, Any]], None]) -> FakeApi:
    responses = recorded()
    change(responses[("/v1/avatars/public", "1")]["data"]["results"][1])
    return FakeApi(responses)


@pytest.mark.parametrize(
    ("change", "category"),
    [
        (lambda a: a.pop("id"), "missing field"),
        (lambda a: a.pop("is_expired"), "missing field"),
        (lambda a: a.update(id="not-a-uuid"), "malformed id"),
        (lambda a: a.update(name=""), "mistyped field"),
        (lambda a: a.update(status="RETIRED"), "undocumented enum value"),
        (lambda a: a.update(type="CARTOON"), "undocumented enum value"),
        (lambda a: a.update(is_1080p="yes"), "mistyped field"),
        (lambda a: a.update(is_expired=0), "mistyped field"),
        (lambda a: a.update(preview_url="http://insecure.example/x.png"), "malformed URL"),
        (lambda a: a.update(preview_url="https://x.example/a.png) [x](https://evil.example"), "malformed URL"),
        (lambda a: a.update(default_voice={"id": V1}), "missing field"),
        (lambda a: a.update(default_voice="Fake Voice One"), "not an object"),
        (lambda a: a.update(created_at="yesterday"), "malformed date-time"),
        (lambda a: a.update(error_message=7), "mistyped field"),
    ],
)
def test_a_malformed_avatar_is_skipped_and_counted(change: Callable[[dict[str, Any]], None], category: str) -> None:
    catalog = build(mutate_avatar(change))
    assert GRAHAM not in by_id(catalog)
    assert sorted(by_id(catalog)) == sorted([WAYNE, KATYA, RETIRED])
    assert catalog["skipped"]["avatars"] == {category: 1}
    assert catalog["counts"]["avatars"] == 3 and catalog["counts"]["avatars_skipped"] == 1
    assert f"Invalid avatars skipped: {category}: 1." in hc.render_markdown(catalog)
    assert "| Avatars skipped as invalid | 1 |" in hc.render_summary(catalog)


def test_a_non_object_result_is_skipped_and_counted() -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "2")]["data"]["results"][1] = None
    catalog = build(FakeApi(responses))
    assert catalog["skipped"]["avatars"] == {"not an object": 1}
    assert RETIRED not in by_id(catalog)


def test_a_list_with_no_valid_item_stops_the_run() -> None:
    responses = recorded()
    for page in ("1", "2"):
        for avatar in responses[("/v1/avatars/public", page)]["data"]["results"]:
            avatar["status"] = "RETIRED"
    with pytest.raises(hc.CatalogError, match=r"/v1/avatars/public: all 4 results are invalid \(undocumented enum value: 4\)"):
        build(FakeApi(responses))


@pytest.mark.parametrize(
    ("change", "category"),
    [
        (lambda v: v.pop("gender"), "missing field"),
        (lambda v: v.update(tags="calm"), "mistyped field"),
        (lambda v: v.update(tags=[1]), "mistyped field"),
        (lambda v: v.update(id="nope"), "malformed id"),
    ],
)
def test_a_malformed_voice_is_skipped_and_counted(change: Callable[[dict[str, Any]], None], category: str) -> None:
    responses = recorded()
    change(responses[("/v1/voices", "1")]["data"]["results"][0])
    catalog = build(FakeApi(responses))
    assert [v["id"] for v in catalog["voices"]] == [V2]
    assert catalog["skipped"]["voices"] == {category: 1}
    # Graham's default voice was the skipped one: its gender is unknown, the avatar is still catalogued.
    assert by_id(catalog)[GRAHAM]["default_voice_gender"] is None


@pytest.mark.parametrize(
    ("change", "category"),
    [
        (lambda d: d.update(voice_engines=["polly"]), "undocumented enum value"),
        (lambda d: d.update(voice_engines="elevenLabs"), "mistyped field"),
        (lambda d: d.update(id=V2), "detail for another voice"),
        (lambda d: d.pop("tags"), "missing field"),
    ],
)
def test_a_malformed_voice_detail_leaves_the_voice_without_engines(change: Callable[[dict[str, Any]], None], category: str) -> None:
    responses = recorded()
    change(responses[(f"/v1/voices/{V1}", "")]["data"])
    catalog = build(FakeApi(responses))
    voices = {v["id"]: v for v in catalog["voices"]}
    assert voices[V1]["voice_engines"] is None and voices[V2]["voice_engines"] == ["fish", "cartesia"]
    assert catalog["skipped"]["voice_details"] == {category: 1}
    assert catalog["counts"]["voice_details_skipped"] == 1


@pytest.mark.parametrize(
    ("envelope", "message"),
    [
        ({"code": 2000, "data": {"count": 0, "results": []}, "message": "odd"}, "unexpected envelope code (code 2000: odd)"),
        ({"code": "100", "data": {"count": 0, "results": []}}, "unexpected envelope code (code not an integer: )"),
        ({"data": {"count": 0, "results": []}}, "unexpected envelope code"),
        ({"code": 100, "data": None, "message": "nothing"}, "the envelope has no data"),
        ([], "not a JSON object"),
        ({"code": 100, "data": [], "message": "x"}, "page 1: not an object"),
        ({"code": 100, "data": {"results": []}}, "missing count"),
        ({"code": 100, "data": {"count": -1, "results": []}}, "count is not a non-negative integer"),
        ({"code": 100, "data": {"count": 1, "results": {}}}, "results is not a list"),
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
    responses[("/v1/voices", "1")]["code"] = 100
    assert responses[("/v1/avatars/public", "1")]["code"] == 1000
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
    api.queue(f"/v1/voices/{V2}", 429, {"code": 429, "message": "Too many requests"})
    api.queue(f"/v1/voices/{V2}", 503, b"")
    sleeps: list[float] = []
    catalog = hc.build_catalog(client(api, sleeps))
    assert {v["id"]: v["voice_engines"] for v in catalog["voices"]}[V2] == ["fish", "cartesia"]
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


def test_network_errors_are_retried_then_reported_without_any_piece_of_the_key() -> None:
    calls: list[str] = []

    def broken(path: str, _params: Mapping[str, str]) -> tuple[int, bytes]:
        calls.append(path)
        raise hc.urllib.error.URLError(f"no route ({KEY}) for {KEY[3:19]} near {KEY[:9]}")

    with pytest.raises(hc.CatalogError) as error:
        hc.Client(broken, hc.Scrubber(KEY), sleep=lambda _s: None).get("/v1/avatars/public")
    assert len(calls) == len(hc.RETRY_DELAYS_S) + 1
    assert "request failed (URLError: no route (***) for *** near ***)" in str(error.value)
    assert_no_key_piece(str(error.value))


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_says_which_secret_and_never_echoes_it(status: int) -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", status, {"code": status, "message": f"Invalid API key {KEY}", "data": None})
    with pytest.raises(hc.CatalogError) as error:
        build(api)
    text = str(error.value)
    assert_no_key_piece(text)
    assert f"HTTP {status} (code {status}: Invalid API key ***) (check the key: HEYGEN_LIVEAVATAR_API)" in text


@pytest.mark.parametrize(
    "message",
    [
        f"Invalid API key {KEY[:16]}...",  # a truncated key
        f"Invalid API key {KEY[:7]}… (rejected)",  # a short start of it
        f"key ending in {KEY[-4:]} was revoked",  # its last characters
        f"key {KEY[:4]}****{KEY[-4:]} is not valid",  # masked in the middle
        f"key ...{KEY[10:30]}... unknown",  # a piece from the middle
        f"Invalid key: {KEY[1:]}",  # all but the first character
        f"key {KEY[:20]}\n{KEY[20:]}",  # split across lines
    ],
)
def test_a_vendor_message_echoing_part_of_the_key_is_scrubbed(message: str) -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", 400, {"code": 400, "message": message, "detail": [{"input": KEY}]})
    with pytest.raises(hc.CatalogError) as error:
        build(api)
    assert "HTTP 400 (code 400: " in str(error.value)
    assert_no_key_piece(str(error.value))


def test_the_scrubber_removes_pieces_starts_and_ends_and_leaves_other_text_alone() -> None:
    scrub = hc.Scrubber(KEY)
    assert scrub(f"a {KEY} b") == "a *** b"
    assert scrub(f"a {KEY[5:20]} b") == "a *** b"
    assert scrub(f"key {KEY[:6]}... end") == "key ***... end"
    assert scrub(f"ends in ...{KEY[-5:]}.") == "ends in ...***."
    assert scrub(f"x{KEY[:6]}") == f"x{KEY[:6]}"  # a start inside another word is not a key fragment
    for ordinary in ("/v1/avatars/public?page=1&page_size=100: HTTP 502", "Catalogued 4 stock avatars", f"/v1/voices/{V1}"):
        assert scrub(ordinary) == ordinary
    assert hc.Scrubber("")("anything") == "anything"
    special = "Ab+/Cd=Ef:Gh~Ij.Kl_Mn-Op0123"
    encoded = hc.urllib.parse.quote(special, safe="")
    assert scrub_has_no_piece(hc.Scrubber(special)(f"echo {encoded}"), encoded)


def scrub_has_no_piece(text: str, form: str) -> bool:
    return all(form[i : i + 12] not in text for i in range(len(form) - 11))


def test_the_output_check_finds_a_truncated_key() -> None:
    scrub = hc.Scrubber(KEY)
    assert scrub.leaks(KEY[5:20])
    assert not scrub.leaks(KEY[:11])
    assert not hc.Scrubber("").leaks("anything")


def test_a_vendor_message_is_cut_to_200_characters() -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", 400, {"code": 400, "message": "x" * 5000})
    with pytest.raises(hc.CatalogError) as error:
        build(api)
    assert len(str(error.value)) < 300


def test_a_string_envelope_code_is_never_echoed() -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", 200, {"code": f"{KEY}", "data": {}, "message": "ok"})
    with pytest.raises(hc.CatalogError) as error:
        build(api)
    assert "code not an integer: ok" in str(error.value)
    assert_no_key_piece(str(error.value))


# --- main: outputs, summary, the log ---------------------------------------------------------------------------


def run_main(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    api: Any,
    key: str | None = KEY,
    extra: tuple[str, ...] = (),
    previews: Any = None,
) -> tuple[int, Path, Path]:
    out = tmp_path / "out"
    summary = tmp_path / "summary.md"
    if key is None:
        monkeypatch.delenv("HEYGEN_API_KEY", raising=False)
    else:
        monkeypatch.setenv("HEYGEN_API_KEY", f" {key}\n")
    monkeypatch.setattr(hc, "PREVIEW_DOMAINS", TEST_DOMAINS)
    rc = hc.main(
        ["--out-dir", str(out), "--summary", str(summary), *extra],
        transport=api,
        preview_fetch=previews or FakePreviews(),
        sleep=lambda _s: None,
    )
    return rc, out, summary


def test_main_writes_json_markdown_and_a_counts_only_summary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    rc, out, summary = run_main(tmp_path, monkeypatch, FakeApi())
    assert rc == 0
    assert "HEYGEN_API_KEY" not in hc.os.environ  # taken out of the environment once read
    catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    assert catalog["counts"]["avatars"] == 4 and catalog["counts"]["avatars_likely_green_screen"] == 1
    markdown = (out / "catalog.md").read_text(encoding="utf-8")
    assert f"| Graham in Black Suit | `{GRAHAM}` | ACTIVE | yes | Fake Voice One | male | English | yes | yes | no | no | [preview]({PREVIEWS}graham.png) |" in markdown
    assert "| Retired \\| Look |" in markdown  # a pipe in a name cannot break the table
    assert f"| Fake Voice Two | `{V2}` | female | English | fish, cartesia |  |  |" in markdown
    text = summary.read_text(encoding="utf-8")
    assert "| Stock avatars | 4 |" in text and "| Usable in the sandbox | 1 |" in text
    assert "| Likely green-screen studio (transparent preview) | 1 |" in text
    assert "downloaded by any signed-in GitHub user" in text
    # Counts only: no names, ids or URLs in the public summary.
    for private in ("Graham", "Wayne", "Fake Voice", GRAHAM, WAYNE, V1, "https://", "credits_left"):
        assert private not in text
    log = capsys.readouterr()
    assert log.out == "Catalogued 4 stock avatars (3 usable in LITE, 1 likely green-screen) and 2 voices.\n" and log.err == ""
    for path in (out / "catalog.json", out / "catalog.md", summary):
        assert_no_key_piece(path.read_text(encoding="utf-8"))


def test_main_warns_about_skipped_items_by_category_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    rc, _, summary = run_main(tmp_path, monkeypatch, mutate_avatar(lambda a: a.update(status=f"RETIRED-{KEY[:14]}")))
    log = capsys.readouterr().out
    assert rc == 0
    assert log.splitlines()[0] == "::warning::HeyGen catalogue: skipped 1 invalid avatars (undocumented enum value: 1)."
    assert "RETIRED" not in log and "Graham" not in log and GRAHAM not in log
    assert_no_key_piece(log)
    assert "| Avatars skipped as invalid | 1 |" in summary.read_text(encoding="utf-8")


def test_main_fails_without_the_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeApi()
    rc, out, _ = run_main(tmp_path, monkeypatch, api, key=None)
    assert rc == 2 and api.calls == [] and not out.exists()
    rc, out, _ = run_main(tmp_path, monkeypatch, api, key="   ")
    assert rc == 2 and api.calls == [] and not out.exists()


def test_main_reports_an_error_without_the_key_and_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    api = FakeApi()
    api.queue("/v1/avatars/public", 401, {"code": 401, "message": f"bad key {KEY[:18]}… (ends {KEY[-4:]})"})
    rc, out, summary = run_main(tmp_path, monkeypatch, api)
    log = capsys.readouterr()
    assert rc == 1
    assert log.out.startswith("::error::HeyGen catalogue: /v1/avatars/public?page=1&page_size=100: HTTP 401 (code 401: bad key ***… (ends ***))")
    assert_no_key_piece(log.out + log.err)
    assert not out.exists() and not summary.exists()


def test_main_reports_an_unexpected_error_scrubbed_and_without_a_traceback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    def explode(_path: str, _params: Mapping[str, str]) -> tuple[int, bytes]:
        raise RuntimeError(f"connection pool broke while sending {KEY[2:26]}")

    rc, out, _ = run_main(tmp_path, monkeypatch, explode)
    log = capsys.readouterr()
    assert rc == 1 and not out.exists()
    assert log.out == "::error::HeyGen catalogue: unexpected RuntimeError: connection pool broke while sending ***\n"
    assert log.err == "" and "Traceback" not in log.out
    assert_no_key_piece(log.out)


def test_main_refuses_to_write_output_that_holds_the_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    responses = recorded()
    responses[("/v1/avatars/public", "1")]["data"]["results"][0]["name"] = f"Wayne {KEY[3:20]}"
    rc, out, _ = run_main(tmp_path, monkeypatch, FakeApi(responses))
    log = capsys.readouterr().out
    assert rc == 1 and not out.exists()
    assert "refusing to write catalog.json: it would contain part of the API key" in log
    assert_no_key_piece(log)


def test_main_can_skip_the_preview_check(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    previews = FakePreviews()
    rc, out, _ = run_main(tmp_path, monkeypatch, FakeApi(), extra=("--no-preview-check",), previews=previews)
    assert rc == 0 and previews.calls == []
    catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    assert {a["preview_check"] for a in catalog["avatars"]} == {"not checked"}


# --- the real transport and preview fetcher against a local server ----------------------------------------------


@pytest.fixture
def local_api() -> Iterator[tuple[str, list[dict[str, Any]]]]:
    seen: list[dict[str, Any]] = []
    big_png = png(6) + b"\x00" * 200_000

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            url = urllib.parse.urlsplit(self.path)
            seen.append(
                {
                    "path": url.path,
                    "query": url.query,
                    "key": self.headers.get("X-API-KEY"),
                    "range": self.headers.get("Range"),
                    "cookie": self.headers.get("Cookie"),
                }
            )
            if url.path in {"/v1/redirect", "/img/redirect.png"}:
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.2:9/steal")
                self.end_headers()
                return
            if url.path.startswith("/img/"):
                body = big_png  # ignores Range: the fetcher must stop reading by itself
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
            else:
                body = json.dumps({"code": 100, "data": {"count": 0, "results": []}, "message": "ok"}).encode()
                self.send_response(200 if url.path == "/v1/avatars/public" else 404)
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

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
    status, body = get("/v1/avatars/public", {"b": "2", "a": "1"})
    assert status == 200 and json.loads(body)["data"] == {"count": 0, "results": []}
    assert seen[0]["path"] == "/v1/avatars/public" and seen[0]["query"] == "a=1&b=2" and seen[0]["key"] == KEY
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


def test_the_preview_fetcher_reads_only_the_first_bytes_without_the_key(local_api: tuple[str, list[dict[str, Any]]]) -> None:
    base, seen = local_api
    fetch = hc.urllib_preview_fetcher(timeout=5, max_bytes=1024)
    head = fetch(f"{base}/img/katya.png")
    assert len(head) == 1024 and hc.image_has_alpha(head) is True
    assert seen == [{"path": "/img/katya.png", "query": "", "key": None, "range": "bytes=0-1023", "cookie": None}]


def test_the_preview_fetcher_refuses_redirects_and_plain_http(local_api: tuple[str, list[dict[str, Any]]]) -> None:
    base, seen = local_api
    fetch = hc.urllib_preview_fetcher(timeout=5)
    with pytest.raises(hc.urllib.error.HTTPError):
        fetch(f"{base}/img/redirect.png")
    assert [s["path"] for s in seen] == ["/img/redirect.png"]
    with pytest.raises(ValueError, match="not https"):
        fetch("http://files.heygen.ai/a.png")


def test_a_plain_http_preview_is_never_fetched_even_on_a_listed_host(local_api: tuple[str, list[dict[str, Any]]]) -> None:
    base, seen = local_api
    avatars = [{"preview_url": f"{base}/img/{i}.png"} for i in range(3)]
    hc.check_previews(avatars, hc.urllib_preview_fetcher(timeout=5), domains=("127.0.0.1",), workers=2)
    assert {a["preview_check"] for a in avatars} == {"host not allowed"}
    assert seen == []


# --- the workflow and the runbook ------------------------------------------------------------------------------


def test_the_workflow_runs_from_main_only_and_keeps_the_key_off_the_log() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "on:\n  workflow_dispatch:\n" in text
    assert "permissions: {}" in text
    assert "    if: github.ref == 'refs/heads/main'\n" in text
    assert "    environment: production\n" in text
    assert "    permissions:\n      contents: read\n" in text
    assert "persist-credentials: false" in text
    # The secret reaches exactly two steps, each through the environment: the check and the catalogue (the second
    # account's key when it is set, as Ops - sync HeyGen key does).
    assert text.count("${{ secrets.HEYGEN_LIVEAVATAR_API_2 || secrets.HEYGEN_LIVEAVATAR_API }}") == 2
    for line in text.splitlines():
        if "secrets.HEYGEN_LIVEAVATAR_API" in line:
            assert line.strip().startswith(("HEYGEN_KEY:", "HEYGEN_API_KEY:")), line
    assert "python -I ops/aws/heygen_catalog.py" in text
    assert "::add-mask::" in text
    assert "name: heygen-catalog" in text and "retention-days: 7" in text


def test_the_workflow_and_runbook_say_the_artifact_is_public_and_holds_no_credits() -> None:
    workflow = " ".join(WORKFLOW.read_text(encoding="utf-8").replace("#", " ").split())
    runbook = " ".join(RUNBOOK.read_text(encoding="utf-8").split())
    catalogue = runbook[runbook.index("Ops - HeyGen catalogue") :][:1500]
    for text in (workflow, catalogue):
        assert "any signed-in GitHub user" in text
        assert "credits left" not in text and "private" not in text.lower()
