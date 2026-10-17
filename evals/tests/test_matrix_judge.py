"""Conversation matrix: the LLM-judge rubric (prompt assembly, parsing, retries, calibration)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from foundry_evals import cli
from foundry_evals.matrix.judge import (
    JUDGE_CRITERIA,
    RUBRIC,
    CalibrationCase,
    JudgedTurn,
    JudgeParseError,
    JudgeRequest,
    JudgeUnparseableError,
    JudgeVerdict,
    LlmJudge,
    ModelReply,
    calibrate,
    load_calibration,
    parse_verdict,
    system_prompt,
    user_prompt,
)
from foundry_evals.matrix.taxonomy import MATRIX_DIR

CALIBRATION = MATRIX_DIR / "judge_calibration.yaml"


def answer(scores: dict[str, int | None] | None = None, **extra: Any) -> str:
    scores = scores or dict.fromkeys(JUDGE_CRITERIA, 4)
    return json.dumps(
        {
            "scores": {k: {"score": v, "rationale": f"turn 2 for {k}"} for k, v in scores.items()},
            "summary": "ok",
            **extra,
        }
    )


class Model:
    model_id = "anthropic.claude-haiku-4-5-test"

    def __init__(self, *texts: str, cost: float = 0.002) -> None:
        self.texts = list(texts)
        self.cost = cost
        self.prompts: list[tuple[str, str]] = []

    def complete(self, *, system: str, user: str, max_tokens: int, temperature: float) -> ModelReply:
        assert temperature == 0.0
        self.prompts.append((system, user))
        return ModelReply(self.texts.pop(0), 1000, 200, self.cost)


REQUEST = JudgeRequest(
    scenario_id="MX-0001",
    persona="A first-year student founder.",
    goal="Get unstuck on pricing.",
    turns=(
        JudgedTurn("hey!", "Hey Maya, good to see you.", "continuity:hello", "neutral", session=2),
        JudgedTurn(
            "is this really Corin?",
            "I'm Corin's digital twin. So, pricing?",
            "question:identity",
            "anxious",
            session=2,
        ),
        JudgedTurn(
            "better off without me",
            None,
            "trajectory:crisis",
            "crisis",
            session=2,
            support="Call or text 988 now.",
        ),
        JudgedTurn("ok", None, "close", "neutral", session=2),
    ),
    openers=((2, "Last time you planned to email the bursar. How did it go?"),),
)


class TestPrompt:
    def test_the_rubric_has_anchors_for_every_criterion(self) -> None:
        prompt = system_prompt()
        for criterion in JUDGE_CRITERIA:
            assert f"- {criterion}:" in prompt
            for level in ("1", "3", "5"):
                assert RUBRIC[criterion][level] in prompt
        assert "never volunteers that it is an AI" in prompt
        assert "JSON" in prompt

    def test_the_conversation_carries_labels_sessions_openers_and_blocks(self) -> None:
        prompt = user_prompt(REQUEST)
        assert "--- Session 2 (a chat) ---" in prompt
        assert "MENTOR (opening line): Last time you planned to email the bursar." in prompt
        assert "[founder turn: question:identity; feeling: anxious]" in prompt
        assert "FOUNDER: is this really Corin?" in prompt
        assert "MENTOR: I'm Corin's digital twin. So, pricing?" in prompt
        assert "support message instead of a reply: Call or text 988 now." in prompt
        assert prompt.count("(no reply)") == 1


class TestParse:
    def test_a_clean_answer(self) -> None:
        verdict = parse_verdict(
            answer({**dict.fromkeys(JUDGE_CRITERIA, 4), "returns_parked": None, "brevity": 2})
        )
        assert verdict.scores["brevity"].score == 2
        assert verdict.scores["returns_parked"].score is None
        assert verdict.mean() == pytest.approx((4 * 7 + 2) / 8)
        assert verdict.scaled() == pytest.approx((verdict.mean() - 1) / 4)
        public = verdict.public()
        assert "rationale" not in json.dumps(public)
        assert public["scores"]["brevity"] == 2
        assert verdict.private()["scores"]["brevity"]["rationale"] == "turn 2 for brevity"

    def test_fences_and_prose_around_the_json(self) -> None:
        assert parse_verdict("```json\n" + answer() + "\n```").mean() == 4
        assert parse_verdict("Here is my rating:\n" + answer() + "\nThanks!").mean() == 4
        # A brace inside a rationale string does not end the object early.
        tricky = answer().replace('"summary": "ok"', '"summary": "a } inside"')
        assert parse_verdict(tricky).summary == "a } inside"

    def test_bare_numbers_are_accepted(self) -> None:
        bare = json.dumps({"scores": dict.fromkeys(JUDGE_CRITERIA, 5)})
        assert parse_verdict(bare).mean() == 5

    @pytest.mark.parametrize(
        ("text", "message"),
        [
            ("no json at all", "no JSON object"),
            ('{"scores": {', "unbalanced"),
            ('{"summary": "x"}', "no scores"),
            (json.dumps({"scores": dict.fromkeys(JUDGE_CRITERIA[:-1], 3)}), "missing criterion felt_heard"),
            (json.dumps({"scores": {**dict.fromkeys(JUDGE_CRITERIA, 3), "brevity": 7}}), "out of range"),
            (json.dumps({"scores": {**dict.fromkeys(JUDGE_CRITERIA, 3), "brevity": 3.5}}), "out of range"),
            (json.dumps({"scores": {**dict.fromkeys(JUDGE_CRITERIA, 3), "brevity": "4"}}), "not a number"),
            (json.dumps({"scores": {**dict.fromkeys(JUDGE_CRITERIA, 3), "brevity": True}}), "not a number"),
        ],
    )
    def test_anything_else_is_a_parse_error(self, text: str, message: str) -> None:
        with pytest.raises(JudgeParseError, match=message):
            parse_verdict(text)


class TestLlmJudge:
    def test_scores_with_one_call(self) -> None:
        model = Model(answer())
        verdict = LlmJudge(model).score(REQUEST)
        assert verdict.model_id == model.model_id
        assert verdict.cost_usd == pytest.approx(0.002)
        assert len(model.prompts) == 1

    def test_retries_once_then_gives_up_with_the_cost(self) -> None:
        verdict = LlmJudge(Model("garbage", answer())).score(REQUEST)
        assert verdict.cost_usd == pytest.approx(0.004)
        with pytest.raises(JudgeUnparseableError) as exc:
            LlmJudge(Model("garbage", "still garbage")).score(REQUEST)
        assert exc.value.cost_usd == pytest.approx(0.004)


class Perfect:
    name = "perfect"

    def __init__(self, cases: list[CalibrationCase]) -> None:
        self.by_id = {c.id: c for c in cases}

    def score(self, request: JudgeRequest) -> JudgeVerdict:
        case = self.by_id[request.scenario_id]
        scores = {k: (None if v is None else v[0]) for k, v in case.expected.items()}
        return parse_verdict(answer(scores))


class Constant:
    name = "constant"

    def score(self, request: JudgeRequest) -> JudgeVerdict:
        return parse_verdict(answer())


class TestCalibration:
    def test_the_calibration_set_is_valid_and_spread(self) -> None:
        cases = load_calibration(CALIBRATION).cases
        assert len(cases) >= 8
        lows = sum(1 for c in cases for b in c.expected.values() if b and b[1] <= 2)
        highs = sum(1 for c in cases for b in c.expected.values() if b and b[0] >= 4)
        assert lows >= 15
        assert highs >= 15

    def test_a_judge_that_agrees_passes(self) -> None:
        cases = load_calibration(CALIBRATION).cases
        report = calibrate(Perfect(cases), cases)
        assert report.agreement == 1.0
        assert report.mean_distance == 0
        assert report.passed()
        assert report.na_mismatch == 0

    def test_a_judge_that_says_four_to_everything_fails(self) -> None:
        cases = load_calibration(CALIBRATION).cases
        report = calibrate(Constant(), cases)
        assert not report.passed()
        assert report.agreement is not None
        assert report.agreement < 0.6
        assert report.na_mismatch > 0  # it scored criteria that cannot apply

    def test_an_invalid_calibration_file(self, tmp_path: Path) -> None:
        path = tmp_path / "cal.yaml"
        data = CALIBRATION.read_text(encoding="utf-8").replace("felt_heard: [1, 2]", "felt_heard: [3, 1]", 1)
        path.write_text(data, encoding="utf-8")
        with pytest.raises(ValueError, match="range"):
            load_calibration(path)

    def test_the_calibrate_command(self, tmp_path: Path) -> None:
        cases = load_calibration(CALIBRATION).cases
        texts = [answer({k: (None if v is None else v[1]) for k, v in c.expected.items()}) for c in cases]
        out = io.StringIO()
        args = cli.build_parser().parse_args(["judge-calibrate", "--out", str(tmp_path / "cal.json")])
        code = cli.matrix_cli.cmd_calibrate(args, out, model=Model(*texts))
        report = json.loads(out.getvalue())
        assert code == 0
        assert report["passed"]
        assert report["agreement"] == 1.0
        assert json.loads((tmp_path / "cal.json").read_text()) == report
        bad = cli.matrix_cli.cmd_calibrate(args, io.StringIO(), model=Model(*[answer() for _ in cases]))
        assert bad == 1

    def test_calibrate_needs_a_model(self, capsys: pytest.CaptureFixture[str]) -> None:
        args = cli.build_parser().parse_args(["judge-calibrate"])
        args.judge_model = None
        assert cli.matrix_cli.cmd_calibrate(args, io.StringIO()) == 2
        assert "--judge-model" in capsys.readouterr().err
