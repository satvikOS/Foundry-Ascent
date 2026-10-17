"""Conversation matrix: the taxonomy and template bank, the covering array and the turn plan."""

from __future__ import annotations

import copy
import itertools
from pathlib import Path
from typing import Any

import pytest
import yaml

from foundry_evals.datasets import DatasetError
from foundry_evals.matrix import generator as gen
from foundry_evals.matrix.generator import (
    BUDGETS,
    CoveringArray,
    Scenario,
    coverage,
    generate,
    resolve_budget,
)
from foundry_evals.matrix.simulator import TemplateSimulator
from foundry_evals.matrix.taxonomy import (
    DIMENSIONS,
    TAXONOMY_PATH,
    TEMPLATES_PATH,
    Taxonomy,
    Templates,
    load_taxonomy,
    load_templates,
)
from foundry_evals.text import mentions_any

VALUES = {"eir_first_name": "Corin", "other_venture": "BenchTally"}


@pytest.fixture(scope="module")
def taxonomy() -> Taxonomy:
    return load_taxonomy()


@pytest.fixture(scope="module")
def templates() -> Templates:
    return load_templates()


@pytest.fixture(scope="module")
def full(taxonomy: Taxonomy, templates: Templates) -> list[Scenario]:
    return generate(taxonomy, templates, budget="full")


def _raw(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _write(tmp_path: Path, name: str, data: dict[str, Any]) -> Path:
    path = tmp_path / name
    path.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    return path


class TestTaxonomy:
    def test_the_brief_s_dimensions_and_values_are_all_there(self, taxonomy: Taxonomy) -> None:
        assert tuple(taxonomy.dimensions) == DIMENSIONS
        brief = {
            "question_type": {
                "open", "closed", "yes_no", "either_or", "leading", "rhetorical", "hypothetical", "multi_part",
                "clarifying", "follow_up", "challenge", "why_how", "ask_opinion", "ask_to_decide", "ask_example",
                "ask_repeat", "ask_simplify", "off_topic", "small_talk", "meta", "recall", "identity", "capability",
            },
            "answer_style": {
                "one_word", "emoji", "long_ramble", "evasive", "partial", "contradicts_earlier", "changes_mind",
                "corrects_veir", "typos_slang", "non_native", "silence", "idk", "sarcasm", "humour",
            },
            "emotion": {
                "neutral", "excited", "proud", "anxious", "stressed", "overwhelmed", "frustrated", "angry_at_veir",
                "defensive", "sad", "embarrassed", "confused", "bored", "grateful", "relieved",
            },
            "trajectory": {"escalates", "de_escalates", "swings", "crisis_adjacent", "crisis"},
            "topic_dynamic": {
                "abrupt_shift", "stepwise_drift", "tangent_and_return", "parked_topic", "two_threads", "barge_in",
                "where_were_we",
            },
            "relational_move": {
                "greeting", "small_talk", "compliment", "apology", "thanks", "venting", "asks_empathy", "pushback",
                "boundary_test", "flattery", "prompt_injection", "other_ventures",
            },
            "continuity": {
                "recall_minutes", "recall_days", "recall_weeks", "commitment_followup", "cross_channel", "teammate",
                "after_private",
            },
            "channel": {"chat", "voice"},
            "register": {"formal", "casual", "gen_z", "terse"},
        }  # fmt: skip
        for dim, wanted in brief.items():
            assert wanted <= set(taxonomy.values_of(dim)), dim

    def test_the_presence_policy_is_checked_on_every_reply(self, taxonomy: Taxonomy) -> None:
        for check in (
            "identity.no_volunteered_disclaimer",
            "identity.no_presence_claim",
            "identity.no_human_claim",
            "craft.length_mirroring",
            "craft.no_parroting",
        ):
            assert check in taxonomy.always_checks
        assert taxonomy.checks["identity.no_volunteered_disclaimer"].severity == "high"
        assert taxonomy.checks["identity.honest_when_asked"].severity == "high"
        assert taxonomy.dimensions["question_type"].values["identity"].checks == [
            "identity.honest_when_asked",
            "identity.brief_disclosure",
            "identity.carries_on",
        ]
        assert "safety" in taxonomy.humanness.excluded_families

    @pytest.mark.parametrize(
        ("mutate", "message"),
        [
            (lambda d: d["dimensions"].pop("register"), "dimensions must be exactly"),
            (lambda d: d["dimensions"]["emotion"]["values"]["sad"]["checks"].append("nope.check"), "unknown check"),
            (lambda d: d["dimensions"]["emotion"]["values"]["sad"]["judge"].append("charm"), "unknown judge"),
            (lambda d: d["dimensions"]["answer_style"]["values"]["emoji"].update(requires={"channel": ["fax"]}), "requires unknown values"),
            (lambda d: d["dimensions"]["answer_style"]["values"]["emoji"].update(requires={"weather": ["sun"]}), "unknown dimension"),
            (lambda d: d["always_checks"].append("craft.mystery"), "always_checks"),
            (lambda d: d["dimensions"]["continuity"].update(default="sometimes"), "default"),
            (lambda d: d["dimensions"]["continuity"].update(pairs_with=["moon"]), "pairs_with"),
            (lambda d: d["humanness"]["families"].pop("voice"), "has no weight"),
        ],
    )  # fmt: skip
    def test_invalid_taxonomies_are_refused(self, tmp_path: Path, mutate: Any, message: str) -> None:
        data = copy.deepcopy(_raw(TAXONOMY_PATH))
        mutate(data)
        with pytest.raises(DatasetError, match=message):
            load_taxonomy(_write(tmp_path, "taxonomy.yaml", data))

    @pytest.mark.parametrize(
        ("mutate", "message"),
        [
            (lambda d: d["topics"]["pricing"].update(recall_terms=["zeppelin"]), "recall term"),
            (
                lambda d: d["topics"]["pricing"].update(commitment="I'll call home."),
                "commitment does not say",
            ),
            (lambda d: d["topics"]["pricing"]["option_terms"].__setitem__(0, ["zeppelin"]), "option"),
            (lambda d: d["personas"][0]["topics"].append("astrology"), "unknown topic"),
            (lambda d: d["phrases"]["closing"].append("Bye <nickname>"), "unknown template slots"),
            (lambda d: d["phrases"]["closing"].append("Bye {{venture_secret}}"), "unknown placeholders"),
            (lambda d: d.update(private_terms=["zeppelin"]), "private_detail"),
        ],
    )
    def test_invalid_templates_are_refused(self, tmp_path: Path, mutate: Any, message: str) -> None:
        data = copy.deepcopy(_raw(TEMPLATES_PATH))
        mutate(data)
        with pytest.raises(DatasetError, match=message):
            load_templates(_write(tmp_path, "templates.yaml", data))

    def test_a_missing_phrase_bank_is_a_dataset_error(self, templates: Templates) -> None:
        with pytest.raises(DatasetError, match="no phrases"):
            templates.bank("question", "telepathy")


class TestCoveringArray:
    def test_a_full_run_covers_every_valid_pair(self, taxonomy: Taxonomy, full: list[Scenario]) -> None:
        cov = coverage(taxonomy, full)
        assert cov.pairs_covered == cov.pairs_total > 3000
        assert cov.values_covered == cov.values_total == 94
        # Far fewer than the cartesian product (23 x 15 x 15 x ... = about 52 million).
        product = 1
        for d in DIMENSIONS:
            product *= len(taxonomy.values_of(d))
        assert len(full) < 500 < product

    def test_every_value_appears_within_the_ci_budget(self, taxonomy: Taxonomy, templates: Templates) -> None:
        ci = generate(taxonomy, templates, budget="ci")
        assert len(ci) == BUDGETS["ci"] == 24
        assert coverage(taxonomy, ci).missing_values == ()
        assert sum(s.multi_session for s in ci) >= 7  # every continuity value needs a remembered conversation

    def test_the_same_seed_gives_the_same_scenarios(self, taxonomy: Taxonomy, templates: Templates) -> None:
        a = generate(taxonomy, templates, seed=7, budget=30)
        gen._ROWS.clear()  # recompute, not the memo
        b = generate(taxonomy, templates, seed=7, budget=30)
        assert [s.to_dict() for s in a] == [s.to_dict() for s in b]
        assert [s.seed for s in a] == [s.seed for s in b]
        other = generate(taxonomy, templates, seed=8, budget=30)
        assert [s.values for s in a] != [s.values for s in other]

    def test_a_smaller_budget_is_a_prefix_of_a_larger_one(
        self, taxonomy: Taxonomy, templates: Templates
    ) -> None:
        ci, smoke, standard = (generate(taxonomy, templates, budget=b) for b in ("ci", "smoke", "standard"))
        assert [s.to_dict() for s in smoke[: len(ci)]] == [s.to_dict() for s in ci]
        assert [s.to_dict() for s in standard[: len(smoke)]] == [s.to_dict() for s in smoke]

    def test_constraints_are_never_broken(self, taxonomy: Taxonomy, full: list[Scenario]) -> None:
        for s in full:
            v = s.values
            assert taxonomy.allowed(dict(v)), s.id
            if v["topic_dynamic"] == "barge_in" or v["continuity"] == "cross_channel":
                assert v["channel"] == "voice", s.id
            if v["answer_style"] in ("emoji", "typos_slang"):
                assert v["channel"] == "chat", s.id
            if v["trajectory"] in ("crisis", "crisis_adjacent"):
                assert v["continuity"] == "none", s.id

    def test_continuity_pairs_only_where_it_matters(self, taxonomy: Taxonomy) -> None:
        dims = taxonomy.pair_dimensions()
        assert ("question_type", "continuity") not in dims
        assert ("emotion", "continuity") in dims
        assert ("continuity", "channel") in dims
        assert len(dims) == len(list(itertools.combinations(DIMENSIONS, 2))) - 3

    def test_an_impossible_pair_is_not_required(self, taxonomy: Taxonomy) -> None:
        array = CoveringArray(taxonomy)
        # Emoji needs a chat and a barge-in needs a call: no row can hold both, so it is never asked for.
        assert not array.completable({"answer_style": "emoji", "topic_dynamic": "barge_in"})
        assert ("answer_style", "emoji", "topic_dynamic", "barge_in") not in array.uncovered
        assert array.completable({"answer_style": "emoji", "channel": "chat"})

    def test_budgets(self) -> None:
        assert resolve_budget("ci") == 24
        assert resolve_budget("full") is None
        assert resolve_budget("12") == 12
        assert resolve_budget(5) == 5
        with pytest.raises(ValueError, match="unknown matrix budget"):
            resolve_budget("huge")
        with pytest.raises(ValueError, match="> 0"):
            resolve_budget(0)


class TestPlan:
    def test_every_value_s_checks_land_on_a_turn(self, taxonomy: Taxonomy, full: list[Scenario]) -> None:
        for s in full:
            sources = {src for t in s.turns() for c in t.checks for src in c.sources}
            for dim in ("question_type", "answer_style", "topic_dynamic", "relational_move", "continuity"):
                value = s.values[dim]
                if taxonomy.dimensions[dim].values[value].checks:
                    assert f"{dim}:{value}" in sources or any(
                        f"{dim}:{value}" in c.sources for ss in s.sessions for c in ss.session_checks
                    ), (s.id, dim, value)

    def test_turn_shapes(self, full: list[Scenario]) -> None:
        for s in full:
            turns = list(s.turns())
            assert 4 <= len(turns) <= 12, s.id
            intents = [t.intent for t in turns]
            q = s.values["question_type"]
            assert f"question:{q}" in intents
            assert f"answer:{s.values['answer_style']}" in intents
            if s.values["trajectory"] in ("crisis", "crisis_adjacent"):
                assert intents[-1] == f"trajectory:{s.values['trajectory']}", s.id
            else:
                assert intents[-1] == "close", s.id
            if s.values["topic_dynamic"] in ("tangent_and_return", "parked_topic"):
                leave = intents.index(f"dynamic:{s.values['topic_dynamic']}:leave")
                assert intents[leave + 1] == f"dynamic:{s.values['topic_dynamic']}:return"
            if q in gen.ABOUT_THE_REPLY:
                # A question about the last reply always follows a reply about the topic, never an intro.
                at = intents.index(f"question:{q}")
                assert at > 0, s.id
                assert intents[at - 1] == "open:topic", s.id

    def test_remembered_scenarios(self, full: list[Scenario]) -> None:
        for s in full:
            continuity = s.values["continuity"]
            if continuity == "none":
                assert len(s.sessions) == 1
                assert s.sessions[0].privacy == "ephemeral"
                continue
            first, second = s.sessions
            assert first.privacy == ("ephemeral" if continuity == "after_private" else "standard")
            assert second.privacy == "standard"
            assert second.actor == ("teammate" if continuity == "teammate" else "founder")
            assert first.channel == ("chat" if continuity == "cross_channel" else s.values["channel"])
            probe = second.turns[1]
            assert probe.intent.startswith("continuity:"), s.id
            assert probe.checks, s.id

    def test_what_the_template_simulator_says_carries_what_the_checks_need(
        self, taxonomy: Taxonomy, templates: Templates, full: list[Scenario]
    ) -> None:
        simulator = TemplateSimulator(taxonomy, templates)
        for s in full:
            for turn in s.turns():
                text = simulator.render(s, turn, [], VALUES).text
                assert text.strip(), (s.id, turn.intent)
                for group in turn.must_say:
                    assert mentions_any(text, list(group)), (s.id, turn.intent, group)

    def test_injection_scenarios_carry_a_marker(self, full: list[Scenario]) -> None:
        markers = [s.marker for s in full if s.values["relational_move"] == "prompt_injection"]
        assert markers
        assert all(m and m.startswith("MXINJ-") for m in markers)
        assert all(s.marker is None for s in full if s.values["relational_move"] != "prompt_injection")

    def test_the_plan_dump_carries_no_message_text(
        self, taxonomy: Taxonomy, templates: Templates, full: list[Scenario]
    ) -> None:
        simulator = TemplateSimulator(taxonomy, templates)
        s = full[0]
        dumped = str(s.to_dict())
        for turn in s.turns():
            text = simulator.render(s, turn, [], VALUES).text
            if len(text) > 12:
                assert text not in dumped
