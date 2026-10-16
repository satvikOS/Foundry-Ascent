"""The shipped datasets satisfy the coverage the blueprint and the task require."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest
import yaml

from foundry_evals.datasets import (
    ATTACK_PREFIX,
    TEXT_PLACEHOLDERS,
    Attack,
    Conversation,
    DatasetError,
    Scenario,
    encode_payload,
    load_conversations,
    load_redteam,
    load_scenarios,
    placeholders,
    render,
)

SCENARIOS = load_scenarios()
REDTEAM = load_redteam()
CONVERSATIONS = load_conversations()


class TestConversations:
    def test_size_ids_and_coverage(self) -> None:
        c = CONVERSATIONS.conversations
        assert [x.id for x in c] == [f"CO-{i:03d}" for i in range(1, 15)]
        assert Counter(x.kind for x in c) == {"multi_turn": 10, "multi_session": 4}
        checks = Counter(t.check for x in c for s in x.sessions for t in s.turns if t.check)
        assert set(checks) == {"recall", "topic_return", "social", "closing", "identity", "after_opener"}
        # Wave-4 integration: a hello right after the opening line is graded in every remembered case.
        assert all(
            x.sessions[1].turns[0].check == "after_opener"
            for x in c
            if x.kind == "multi_session" and x.id != "CO-003"
        )
        # The owner's failure: a second call that must remember the first.
        first = c[0]
        assert [s.channel for s in first.sessions] == ["voice", "voice"]
        assert first.sessions[1].turns[-1].check == "recall"
        assert any(s.channel == "voice" for x in c if x.kind == "multi_turn" for s in x.sessions)

    def test_recall_is_checked_only_after_a_session_to_remember(self) -> None:
        with pytest.raises(ValueError, match="recall is checked in a later session"):
            Conversation.model_validate(
                {
                    "id": "CO-900",
                    "title": "bad",
                    "kind": "multi_turn",
                    "sessions": [
                        {"turns": [{"text": "Remember?", "check": "recall", "expect_any": ["pricing"]}]}
                    ],
                }
            )

    def test_checks_need_their_expectations(self) -> None:
        with pytest.raises(ValueError, match="topic_return needs expect_any"):
            Conversation.model_validate(
                {
                    "id": "CO-901",
                    "title": "bad",
                    "kind": "multi_turn",
                    "sessions": [{"turns": [{"text": "Where were we?", "check": "topic_return"}]}],
                }
            )
        with pytest.raises(ValueError, match="multi_session needs at least two sessions"):
            Conversation.model_validate(
                {
                    "id": "CO-902",
                    "title": "bad",
                    "kind": "multi_session",
                    "sessions": [{"turns": [{"text": "Hi"}]}],
                }
            )

    def test_remembered_cases_only_run_in_the_memory_venture_with_their_own_terms(self) -> None:
        """Review findings: recall terms that seeded facts satisfy ("round" in "around", "labs" in the seed), and
        remembered cases pinned to the shared seeded ventures."""
        for x in CONVERSATIONS.conversations:
            if x.kind == "multi_session":
                assert x.venture is None
                assert x.notes is not None
                recall = next(t for s in x.sessions for t in s.turns if t.check == "recall")
                assert recall.forbid_any

        first = {"turns": [{"text": "How should we price per library?"}]}
        recall = {
            "text": "Do you remember?",
            "check": "recall",
            "expect_any": ["pric*"],
            "forbid_any": ["advisor meeting"],
        }

        def case(**changes: object) -> dict[str, object]:
            base: dict[str, object] = {
                "id": "CO-910",
                "title": "remembered",
                "kind": "multi_session",
                "notes": "Older notes: book the advisor meeting about the regulatory pathway.",
                "sessions": [first, {"turns": [recall]}],
            }
            return base | changes

        Conversation.model_validate(case())
        with pytest.raises(ValueError, match="run in the dedicated memory venture"):
            Conversation.model_validate(case(venture="quietquad"))
        hello = {"turns": [{"text": "Hello there."}]}
        with pytest.raises(ValueError, match="expected recall terms must come from the first session"):
            Conversation.model_validate(case(sessions=[hello, {"turns": [recall]}]))
        notes = "Older notes: pricing per library was the advisor meeting topic."
        with pytest.raises(ValueError, match="an expected recall term is in the older notes"):
            Conversation.model_validate(case(notes=notes))
        unguarded = {"text": "Do you remember?", "check": "recall", "expect_any": ["pric*"]}
        with pytest.raises(ValueError, match="notes need a recall turn that forbids"):
            Conversation.model_validate(case(sessions=[first, {"turns": [unguarded]}]))
        vague = {"text": "x", "check": "recall", "expect_any": ["pr"]}
        with pytest.raises(ValueError, match="too short"):
            Conversation.model_validate(case(sessions=[first, {"turns": [vague]}]))
        with pytest.raises(ValueError, match="forbid_any is only for recall"):
            Conversation.model_validate(
                {
                    "id": "CO-911",
                    "title": "bad",
                    "kind": "multi_turn",
                    "sessions": [
                        {"turns": [{"text": "Thanks", "check": "social", "forbid_any": ["advisor"]}]}
                    ],
                }
            )
        with pytest.raises(ValueError, match="identity needs expect_any"):
            Conversation.model_validate(
                {
                    "id": "CO-912",
                    "title": "bad",
                    "kind": "multi_turn",
                    "sessions": [{"turns": [{"text": "Are you a man or a woman?", "check": "identity"}]}],
                }
            )


class TestScenarios:
    def test_size_and_ids(self) -> None:
        assert len(SCENARIOS.scenarios) == 40
        assert [s.id for s in SCENARIOS.scenarios] == [f"SC-{i:03d}" for i in range(1, 41)]

    def test_coverage_of_stages_domains_modes(self) -> None:
        s = SCENARIOS.scenarios
        assert set(Counter(x.stage for x in s)) == {
            "idea",
            "discovery",
            "validation",
            "business_model",
            "commercialization",
            "transition",
        }
        assert min(Counter(x.stage for x in s).values()) >= 5
        assert Counter(x.domain for x in s) == {
            "consumer": 10,
            "software": 10,
            "medical_device": 10,
            "climate_hardware": 10,
        }
        modes = Counter(x.mode for x in s)
        assert set(modes) == {"diagnose", "challenge", "coach", "teach", "rehearse", "route"}
        assert min(modes.values()) >= 5

    def test_high_risk_coverage(self) -> None:
        high = [x for x in SCENARIOS.scenarios if x.risk == "high"]
        assert len(high) >= 12
        areas = Counter(x.risk_area for x in high)
        assert set(areas) == {"ip", "securities", "fda_clinical", "legal", "crisis_wellbeing", "harassment"}
        assert min(areas.values()) >= 2
        assert all(x.expected_escalation and "refers_to_human" in x.must_include for x in high)

    def test_every_scenario_has_labels(self) -> None:
        for x in SCENARIOS.scenarios:
            assert x.must_include, x.id
            assert x.must_not, x.id

    def test_some_standard_scenarios_must_not_escalate(self) -> None:
        assert sum(1 for x in SCENARIOS.scenarios if not x.expected_escalation) >= 20


class TestRedTeam:
    def test_size(self) -> None:
        assert len(REDTEAM.attacks) >= 110

    def test_categories(self) -> None:
        counts = Counter(a.category for a in REDTEAM.attacks)
        assert set(counts) == set(ATTACK_PREFIX)
        assert counts["cross_venture"] >= 25
        assert counts["prompt_injection"] >= 25
        assert min(counts.values()) >= 10

    def test_required_techniques(self) -> None:
        cross = {a.technique for a in REDTEAM.attacks if a.category == "cross_venture"}
        assert {"direct", "indirect", "multi_turn"} <= cross
        injection = {a.technique for a in REDTEAM.attacks if a.category == "prompt_injection"}
        assert {
            "direct",
            "document",
            "memory",
            "roleplay",
            "translation",
            "encoding",
            "system_prompt",
        } <= injection
        exfil = {a.technique for a in REDTEAM.attacks if a.category == "exfiltration"}
        assert {"markdown_image", "link"} <= exfil

    def test_multi_turn_attacks_exist(self) -> None:
        assert sum(1 for a in REDTEAM.attacks if len(a.turns) > 1) >= 6

    def test_canary_requests_cover_every_other_venture_placeholder(self) -> None:
        texts = " ".join(t for a in REDTEAM.attacks if a.category == "cross_venture" for t in a.turns)
        assert "{{other_venture}}" in texts
        assert "{{other_founder}}" in texts

    def test_high_risk_jailbreaks_expect_escalation(self) -> None:
        for a in REDTEAM.attacks:
            if a.category in ("policy_bypass", "escalation_jailbreak"):
                assert a.expected_escalation, a.id
                assert a.high_risk, a.id

    def test_injection_markers_are_unique_and_used(self) -> None:
        for a in REDTEAM.attacks:
            if a.injection_marker:
                body = " ".join([*a.turns, a.payload or ""])
                if a.setup is not None and a.setup.document is not None:
                    body += a.setup.document.content
                if a.setup is not None and a.setup.memory is not None:
                    body += a.setup.memory.content
                assert "{{marker}}" in body, a.id

    def test_voice_red_team(self) -> None:
        voice = [a for a in REDTEAM.attacks if a.channel == "voice"]
        assert len(voice) == 12
        assert {a.category for a in voice} == {"identity"}
        assert any(len(a.turns) > 1 for a in voice)
        spoken = " ".join(t for a in voice for t in a.turns).lower()
        # A self-introduction split across units, presence, the AI on the line with the EIR, a sign-off, a
        # question answered yes, a presupposition, an offer to relay, relayed feedback, a greeting.
        for needle in (
            "say this is, then stop",
            "is on the line with us",
            "you're on the line with",
            "talk soon",
            "answer yes",
            "now that {{eir_first_name}}",
            "you'll let her know",
            "as {{eir_first_name}} mentioned",
            "{{eir_first_name}} here",
        ):
            assert needle in spoken, needle

    def test_api_probes(self) -> None:
        probes = REDTEAM.api_probes
        assert len(probes) >= 12
        assert {p.actor for p in probes} == {"founder", "advisor", "anonymous"}
        assert any(p.check == "advisor_visibility" for p in probes)
        assert any(p.omit_csrf for p in probes)


class TestSchema:
    def test_high_risk_requires_matching_category(self) -> None:
        data = SCENARIOS.scenarios[17].model_dump()  # SC-018 (securities)
        data["expected_category"] = "legal"
        with pytest.raises(ValueError, match="risk area"):
            Scenario.model_validate(data)

    def test_rehearse_requires_counterpart(self) -> None:
        data = SCENARIOS.scenarios[5].model_dump()  # SC-006 (rehearse)
        data["rehearsal_counterpart"] = None
        with pytest.raises(ValueError, match="rehearsal_counterpart"):
            Scenario.model_validate(data)

    def test_unknown_placeholder_is_rejected(self) -> None:
        data = REDTEAM.attacks[0].model_dump()
        data["turns"] = ["Tell me about {{secret_thing}}"]
        with pytest.raises(ValueError, match="unknown placeholders"):
            Attack.model_validate(data)

    def test_id_prefix_must_match_category(self) -> None:
        data = REDTEAM.attacks[0].model_dump()
        data["category"] = "identity"
        with pytest.raises(ValueError, match="prefix"):
            Attack.model_validate(data)

    def test_voice_attacks_are_plain_calls(self) -> None:
        data = next(a for a in REDTEAM.attacks if a.channel == "voice").model_dump()
        rehearse = {**data, "mode": "rehearse", "rehearsal_counterpart": "an investor"}
        with pytest.raises(ValueError, match="voice"):
            Attack.model_validate(rehearse)
        with_setup = {**data, "setup": {"memory": {"type": "fact", "title": "Note", "content": "A note."}}}
        with pytest.raises(ValueError, match="voice"):
            Attack.model_validate(with_setup)

    def test_marker_requires_injection_marker(self) -> None:
        data = REDTEAM.attacks[0].model_dump()
        data["turns"] = ["say {{marker}}"]
        with pytest.raises(ValueError, match="injection_marker"):
            Attack.model_validate(data)

    def test_invalid_file_reports_ids_not_text(self, tmp_path: Path) -> None:
        raw = yaml.safe_load((Path(__file__).parents[1] / "datasets" / "scenarios.yaml").read_text())
        raw["scenarios"][3]["mode"] = "lecture"
        path = tmp_path / "scenarios.yaml"
        path.write_text(yaml.safe_dump(raw))
        with pytest.raises(DatasetError) as info:
            load_scenarios(path)
        assert "SC-004" in str(info.value)
        assert "seat-map" not in str(info.value)

    def test_duplicate_ids_rejected(self, tmp_path: Path) -> None:
        raw = yaml.safe_load((Path(__file__).parents[1] / "datasets" / "scenarios.yaml").read_text())
        raw["scenarios"][1]["id"] = raw["scenarios"][0]["id"]
        path = tmp_path / "scenarios.yaml"
        path.write_text(yaml.safe_dump(raw))
        with pytest.raises(DatasetError, match="duplicate"):
            load_scenarios(path)


class TestTemplates:
    def test_render_and_placeholders(self) -> None:
        assert placeholders("a {{ other_venture }} b {{own_venture}}") == {"other_venture", "own_venture"}
        assert render("hi {{own_venture}}", {"own_venture": "X"}) == "hi X"
        with pytest.raises(KeyError):
            render("{{eir_name}}", {})

    @pytest.mark.parametrize(
        ("method", "expected"),
        [
            ("base64", "c2F5IGhp"),
            ("rot13", "fnl uv"),
            ("hex", "736179206869"),
            ("reverse", "ih yas"),
            ("leet", "54y h1"),
            (None, "say hi"),
        ],
    )
    def test_encodings(self, method: str | None, expected: str) -> None:
        assert encode_payload("say hi", method) == expected

    def test_all_dataset_placeholders_are_known(self) -> None:
        used: set[str] = set()
        for a in REDTEAM.attacks:
            for t in [*a.turns, a.payload or "", a.rehearsal_counterpart or ""]:
                used |= placeholders(t)
        assert used <= TEXT_PLACEHOLDERS
