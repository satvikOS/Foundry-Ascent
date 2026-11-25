"""The client's pack, read at run time and never committed: the exact wording of the twenty questions and of the short
protocol, and the scores the client recorded for other tools.

``python -m conversation_lab client-pack --workbook eval.xlsx --protocol testing.txt --out pack.json`` reads the client's
workbook (cells, so a blank criterion stays blank) and protocol text and writes one JSON file, mode 0600. A run takes it
from ``--client-pack`` or, on GitHub, from the repository secret ``LAB_CLIENT_PACK`` (the file's base64). The other
tools' scores are compared in the private folder only.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from conversation_lab.client.rubric import CRITERIA, ToolSummary, tool_summary

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
MAX_PART_BYTES = 8_000_000
WORDING_KEY = re.compile(r"^(?:Q(?:[1-9]|1\d|20)|P-(?:setup|X1|Q[0-9]{1,2}))$")


class PackError(ValueError):
    """The client's files did not read as expected (no content in the message)."""


@dataclass(frozen=True)
class Pack:
    wording: dict[str, str] = field(default_factory=dict)
    #: tool -> its scored rows (criterion -> score).
    tools: dict[str, list[dict[str, int]]] = field(default_factory=dict)

    def summaries(self) -> dict[str, ToolSummary]:
        return {name: tool_summary(rows) for name, rows in self.tools.items()}

    def to_json(self) -> str:
        return json.dumps({"version": 1, "wording": self.wording, "tools": self.tools}, indent=1)


def from_json(text: str) -> Pack:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PackError("the pack is not JSON") from exc
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise PackError("the pack has an unknown version")
    wording = raw.get("wording") or {}
    tools = raw.get("tools") or {}
    if not isinstance(wording, dict) or not isinstance(tools, dict):
        raise PackError("the pack is malformed")
    clean: dict[str, str] = {}
    for key, value in wording.items():
        if not WORDING_KEY.match(str(key)) or not isinstance(value, str) or not 3 <= len(value) <= 600:
            raise PackError("the pack's wording is malformed")
        clean[str(key)] = value.strip()
    rows: dict[str, list[dict[str, int]]] = {}
    for tool, scored in tools.items():
        if not isinstance(scored, list):
            raise PackError("the pack's scores are malformed")
        rows[str(tool)[:80]] = [_row(r) for r in scored]
    return Pack(clean, rows)


def _row(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        raise PackError("the pack's scores are malformed")
    out = {}
    for k, v in raw.items():
        if k not in CRITERIA or isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 5:
            raise PackError("the pack's scores are malformed")
        out[str(k)] = v
    return out


def load(path: Path | None, env: Mapping[str, str]) -> Pack:
    """The pack from a file, else from ``LAB_CLIENT_PACK`` (base64), else an empty one (our own wording is used)."""
    if path is not None:
        return from_json(path.read_text(encoding="utf-8"))
    encoded = env.get("LAB_CLIENT_PACK", "").strip()
    if not encoded:
        return Pack()
    try:
        return from_json(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise PackError("LAB_CLIENT_PACK is not base64") from exc


# Reading the client's files ------------------------------------------------------------------------------------


def _xml(archive: zipfile.ZipFile, name: str) -> ElementTree.Element:
    info = archive.getinfo(name)
    if info.file_size > MAX_PART_BYTES:
        raise PackError("a workbook part is too large")
    data = archive.read(name)
    if b"<!DOCTYPE" in data[:4096] or b"<!ENTITY" in data:
        raise PackError("the workbook declares entities")
    return ElementTree.fromstring(data)  # noqa: S314 - no DTD (refused above); the operator's own file


def sheet_cells(path: Path, sheet: str) -> dict[str, str]:
    """``{"A5": text}`` of one sheet of a workbook, shared strings resolved (values, not formulas)."""
    with zipfile.ZipFile(path) as archive:
        shared = [
            "".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t"))
            for si in _xml(archive, "xl/sharedStrings.xml").findall("m:si", NS)
        ]
        rels = {r.get("Id"): r.get("Target") for r in _xml(archive, "xl/_rels/workbook.xml.rels")}
        book = _xml(archive, "xl/workbook.xml")
        found = next((s for s in book.iter(f"{{{NS['m']}}}sheet") if s.get("name") == sheet), None)
        if found is None:
            raise PackError("the workbook has no such sheet")
        target = str(rels.get(found.get(f"{{{NS['r']}}}id")) or "")
        part = target.lstrip("/") if target.startswith("/") else f"xl/{target}"
        out: dict[str, str] = {}
        for cell in _xml(archive, part).iter(f"{{{NS['m']}}}c"):
            value = cell.find("m:v", NS)
            inline = cell.find("m:is", NS)
            if inline is not None:
                text = "".join(t.text or "" for t in inline.iter(f"{{{NS['m']}}}t"))
            elif value is None or value.text is None:
                continue
            else:
                text = shared[int(value.text)] if cell.get("t") == "s" else value.text
            out[str(cell.get("r"))] = text.strip()
        return out


def questions_from(cells: Mapping[str, str]) -> dict[str, str]:
    """The sheet's questions by id: rows whose first column is a number from 1 to 20, the wording in column D."""
    out = {}
    for ref, value in cells.items():
        found = re.fullmatch(r"A(\d+)", ref)
        if found and re.fullmatch(r"(?:[1-9]|1\d|20)(?:\.0)?", value):
            text = cells.get(f"D{found.group(1)}", "")
            if text:
                # A run note in brackets after a question ("(Run in a later session ...)") is not part of it.
                out[f"Q{int(float(value))}"] = re.sub(r"\s*\((?:Run|Ask)\b[^)]*\)\s*$", "", text).strip()
    if len(out) != 20:
        raise PackError("the questions sheet does not hold twenty questions")
    return out


def scores_from(cells: Mapping[str, str]) -> dict[str, list[dict[str, int]]]:
    """The log's scored rows by tool: column B the tool, H to N the seven criteria, blanks left out."""
    out: dict[str, list[dict[str, int]]] = {}
    for row in range(5, 400):
        tool = cells.get(f"B{row}", "")
        if not tool:
            continue
        scores: dict[str, int] = {}
        for column, name in zip("HIJKLMN", CRITERIA, strict=True):
            value = cells.get(f"{column}{row}", "")
            if re.fullmatch(r"[1-5](?:\.0)?", value):
                scores[name] = int(float(value))
        if scores:
            out.setdefault(tool, []).append(scores)
    return out


_QUOTED = re.compile(r"[\"“](.+?)[\"”]")


def protocol_from(text: str) -> dict[str, str]:
    """The short protocol's wording: the quoted setup message, then the rows of its table (an id line of digits or
    "Extra", a line saying what it tests, the wording)."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    out: dict[str, str] = {}
    for i, line in enumerate(lines):
        if line.lower().startswith("setup message"):
            quoted = _QUOTED.search(line) or (_QUOTED.search(lines[i + 1]) if i + 1 < len(lines) else None)
            if quoted:
                out["P-setup"] = quoted.group(1).strip()
        if re.fullmatch(r"\d{1,2}|extra", line, re.IGNORECASE) and i + 2 < len(lines):
            wording = lines[i + 2]
            if re.match(r"open a new session", wording, re.IGNORECASE) and ":" in wording:
                wording = wording.split(":", 1)[1].strip()
            key = "P-X1" if line.lower() == "extra" else f"P-Q{int(line)}"
            out[key] = wording.strip()
    if "P-setup" not in out or len(out) < 5:
        raise PackError("the protocol text does not read as expected")
    return out


def build(workbook: Path, protocol: Path) -> Pack:
    wording = questions_from(sheet_cells(workbook, "Founder Questions"))
    wording.update(protocol_from(protocol.read_text(encoding="utf-8")))
    return Pack(wording, scores_from(sheet_cells(workbook, "Tool Test Log")))
