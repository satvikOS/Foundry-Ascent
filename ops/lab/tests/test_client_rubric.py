"""The client's scorecard arithmetic, and reading the client's own files at run time (a synthetic workbook here)."""

from __future__ import annotations

import base64
import zipfile
from pathlib import Path

import pytest

from conversation_lab.client import pack
from conversation_lab.client.rubric import (
    ANCHORS,
    CRITERIA,
    QUESTIONS,
    WEIGHTS,
    meets_target,
    question,
    tool_summary,
    weighted,
)


def test_weights_sum_to_one_and_every_criterion_is_anchored() -> None:
    assert sum(WEIGHTS.values()) == pytest.approx(1.0)
    assert tuple(WEIGHTS) == CRITERIA == tuple(ANCHORS)
    assert len(QUESTIONS) == 20
    assert all(q.main in q.criteria for q in QUESTIONS.values())


def test_a_row_is_the_weighted_mean_of_what_it_scored() -> None:
    # SUMPRODUCT(H:N, weights) / SUMIF(H:N > 0, weights): a blank counts for nothing, score nor weight.
    assert weighted({"relevance": 5, "critical": 2, "actionability": 4, "ease": 3}) == pytest.approx(
        2.15 / 0.6
    )
    assert weighted(
        {"memory": 2, "relevance": 4, "critical": 3, "actionability": 1, "ease": 5}
    ) == pytest.approx(2.2 / 0.8)
    assert weighted(dict.fromkeys(CRITERIA)) is None
    assert weighted(dict.fromkeys(CRITERIA, 5)) == pytest.approx(5.0)


def test_the_tool_summary_averages_rows_and_gates_on_privacy() -> None:
    rows = [{"relevance": 5, "ease": 5}, {"relevance": 3, "privacy": 2}]
    line = tool_summary(rows)
    assert line.tests == 2
    assert line.criteria["relevance"] == 4
    assert line.criteria["memory"] is None
    assert line.overall == pytest.approx((5 + (0.6 + 0.2) / 0.3) / 2)
    assert line.scorecard == pytest.approx((4 * 0.2 + 5 * 0.05 + 2 * 0.1) / 0.35)
    assert line.privacy_gate == "CHECK PRIVACY"
    assert tool_summary([{"privacy": 3}]).privacy_gate == "OK"
    assert tool_summary([]).privacy_gate == ""


def test_the_target_needs_every_criterion_scored_and_at_least_four() -> None:
    assert meets_target(tool_summary([dict.fromkeys(CRITERIA, 5)])) is True
    assert meets_target(tool_summary([{**dict.fromkeys(CRITERIA, 5), "ease": 3}])) is False
    assert meets_target(tool_summary([dict.fromkeys(CRITERIA, 4)])) is False
    assert meets_target(tool_summary([{"relevance": 5}])) is None


def test_questions_score_only_what_they_test() -> None:
    assert question("Q13").criteria == ("relevance", "ease", "privacy")
    for qid in ("Q10", "Q14", "Q15", "Q16"):
        assert "referral" in question(qid).criteria
    assert "privacy" not in question("Q4").criteria
    with pytest.raises(KeyError):
        question("Q21")


# The client's files ---------------------------------------------------------------------------------------------


def _cell(ref: str, value: str | int) -> str:
    if isinstance(value, int):
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'


def _sheet(cells: dict[str, str | int]) -> str:
    body = "".join(_cell(k, v) for k, v in cells.items())
    return f'<worksheet xmlns="{pack.NS["m"]}"><sheetData><row>{body}</row></sheetData></worksheet>'


def workbook(path: Path, *, doctype: bool = False) -> Path:
    questions: dict[str, str | int] = {"A4": "Q#", "D4": "Question"}
    for n in range(1, 21):
        questions[f"A{n + 4}"] = n
        questions[f"D{n + 4}"] = f"Invented question {n}?" + (" (Run in a LATER session.)" if n == 19 else "")
    log: dict[str, str | int] = {
        "B4": "Tool",
        "B5": "Tool A",
        "G5": "warm-up, not scored",
        "B6": "Tool A",
        "C6": 4,
        "I6": 5,
        "J6": 2,
        "K6": 4,
        "M6": 3,
        "B7": "Tool B",
        "H7": 5,
        "N7": 9,
    }
    book = (
        f'<workbook xmlns="{pack.NS["m"]}" xmlns:r="{pack.NS["r"]}"><sheets>'
        '<sheet name="Founder Questions" sheetId="1" r:id="rId1"/><sheet name="Tool Test Log" sheetId="2" r:id="rId2"/>'
        "</sheets></workbook>"
    )
    rels = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
        "</Relationships>"
    )
    shared = ("<!DOCTYPE x>" if doctype else "") + f'<sst xmlns="{pack.NS["m"]}"></sst>'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.xml", book)
        z.writestr("xl/_rels/workbook.xml.rels", rels)
        z.writestr("xl/sharedStrings.xml", shared)
        z.writestr("xl/worksheets/sheet1.xml", _sheet(questions))
        z.writestr("xl/worksheets/sheet2.xml", _sheet(log))
    return path


PROTOCOL = """How to
Setup message (send first): "I am building Invented Co."
Q#
What it tests
Ask this
20
Flattery
Say it is great.
4
Skepticism
Friends like it, enough?
Extra
Memory (same session)
What is it?
14
Referral
Who owns it?
19
Memory (next day)
Open a new session the next day and ask: What did we decide?
"""


def test_the_pack_is_read_from_the_clients_own_files(tmp_path: Path) -> None:
    protocol = tmp_path / "protocol.txt"
    protocol.write_text(PROTOCOL, encoding="utf-8")
    built = pack.build(workbook(tmp_path / "eval.xlsx"), protocol)
    assert built.wording["Q1"] == "Invented question 1?"
    assert built.wording["Q19"] == "Invented question 19?"
    assert built.wording["P-setup"] == "I am building Invented Co."
    assert built.wording["P-X1"] == "What is it?"
    assert built.wording["P-Q19"] == "What did we decide?"
    # A blank criterion stays blank, a value outside 1-5 is no score, an unscored row is no row.
    assert built.tools == {
        "Tool A": [{"relevance": 5, "critical": 2, "actionability": 4, "ease": 3}],
        "Tool B": [{"memory": 5}],
    }
    assert built.summaries()["Tool A"].overall == pytest.approx(2.15 / 0.6)
    again = pack.load(None, {"LAB_CLIENT_PACK": base64.b64encode(built.to_json().encode()).decode()})
    assert again == built
    assert pack.load(None, {}) == pack.Pack()


def test_a_bad_pack_or_workbook_is_refused_without_its_content(tmp_path: Path) -> None:
    with pytest.raises(pack.PackError, match="entities"):
        pack.sheet_cells(workbook(tmp_path / "bad.xlsx", doctype=True), "Founder Questions")
    with pytest.raises(pack.PackError, match="no such sheet"):
        pack.sheet_cells(workbook(tmp_path / "ok.xlsx"), "Other")
    for text in (
        "not json",
        "{}",
        '{"version": 1, "wording": {"Q99": "x?"}}',
        '{"version": 1, "tools": {"A": [{"memory": 7}]}}',
        '{"version": 1, "tools": {"A": [{"secret": 3}]}}',
    ):
        with pytest.raises(pack.PackError):
            pack.from_json(text)
    with pytest.raises(pack.PackError, match="base64"):
        pack.load(None, {"LAB_CLIENT_PACK": "***"})
    with pytest.raises(pack.PackError):
        pack.protocol_from("nothing here")
