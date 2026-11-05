"""Distinctness of the live scenarios: a build-failing check that no two scenarios are near-duplicates and that no
authored field is shared boilerplate.

Three measures, all on the scenario's decision-bearing text (title, challenge, objective, constraints, hidden facts,
arc, branches, expectations, prohibitions, memory changes and pass criterion) with the scenario's own names masked
and digits folded, so a copy that changes only names or numbers scores as the copy it is:

* TF-IDF cosine over word unigrams and bigrams (stop words dropped): topical near-duplicates;
* Jaccard over word 4-gram shingles: copied sentences and templated phrasing;
* a "name or industry only" variant check: the same cosine after also masking every venture-domain word, so two
  scenarios that differ only by industry vocabulary still collide;
* exact reuse of any authored text item of 24+ characters in two scenarios (shared boilerplate fields).

Standard library only; the full dataset checks in a few seconds.
"""

from __future__ import annotations

import itertools
import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from conversation_lab.live.dataset import Scenario

#: A pair at or above any of these fails the build (calibrated on the authored set: see the README's table).
MAX_COSINE = 0.40
MAX_SHINGLE_JACCARD = 0.10
MAX_MASKED_COSINE = 0.45
#: Authored items at least this long may not appear verbatim in two scenarios.
MIN_SHARED_CHARS = 16

STOP = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "hers",
        "him",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "me",
        "more",
        "most",
        "my",
        "no",
        "not",
        "of",
        "on",
        "once",
        "one",
        "only",
        "or",
        "our",
        "out",
        "over",
        "own",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "to",
        "too",
        "under",
        "until",
        "up",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "yet",
        "about",
        "after",
        "again",
        "against",
        "all",
        "am",
        "any",
        "because",
        "before",
        "being",
        "below",
        "between",
        "both",
        "down",
        "during",
        "each",
        "few",
        "further",
        "here",
        "itself",
        "let",
        "off",
        "same",
        "through",
        "themselves",
        "ourselves",
        "yourself",
        "himself",
        "herself",
        "also",
        "asks",
        "says",
        "said",
        "tells",
        "wants",
        "gets",
        "get",
        "make",
        "makes",
        "made",
    ]
)
#: Words that only name an industry or product category: masked in the "name or industry only" variant check.
INDUSTRY_WORDS = frozenset(
    [
        "app",
        "apps",
        "software",
        "saas",
        "platform",
        "marketplace",
        "device",
        "devices",
        "hardware",
        "product",
        "products",
        "service",
        "services",
        "food",
        "restaurant",
        "restaurants",
        "kitchen",
        "kitchens",
        "clinic",
        "clinics",
        "hospital",
        "hospitals",
        "patient",
        "patients",
        "farm",
        "farms",
        "farmer",
        "farmers",
        "battery",
        "batteries",
        "energy",
        "solar",
        "water",
        "coating",
        "coatings",
        "robot",
        "robots",
        "robotics",
        "student",
        "students",
        "campus",
        "dorm",
        "dorms",
        "school",
        "schools",
        "university",
        "college",
        "colleges",
        "pet",
        "pets",
        "laundry",
        "tutoring",
        "tutor",
        "tutors",
        "fitness",
        "gym",
        "health",
        "medical",
        "clinical",
        "bank",
        "banking",
        "finance",
        "fintech",
        "retail",
        "grocery",
        "groceries",
        "shop",
        "shops",
        "store",
        "stores",
        "fashion",
        "beauty",
        "skincare",
        "coffee",
        "café",
        "cafés",
        "truck",
        "trucks",
        "delivery",
        "logistics",
        "fleet",
        "vans",
        "housing",
        "landlord",
        "landlords",
        "parents",
        "children",
        "kids",
        "teacher",
        "teachers",
        "nurses",
        "nurse",
        "doctors",
    ]
)
_WORD = re.compile(r"[a-z][a-z'-]*|#")


def scenario_text(s: Scenario) -> str:
    raw = s.raw
    parts: list[str] = [raw["title"], raw["challenge"], raw["objective"], raw["scoring"]["pass"]]
    for key in ("constraints", "hidden", "branches", "expected", "prohibited", "memoryChanges"):
        parts += list(raw[key])
    parts += [beat.text for beat in s.arc]
    return " . ".join(str(p) for p in parts)


def own_names(s: Scenario) -> set[str]:
    raw = s.raw
    names = [raw["venture"]["name"], raw["student"]["name"]]
    if raw.get("neighbour"):
        names += [raw["neighbour"]["venture"], raw["neighbour"]["founder"]]
    out: set[str] = set()
    for name in names:
        for token in re.findall(r"[A-Za-z][A-Za-z'-]+", str(name)):
            if token.lower() not in {"dr", "the", "and", "co", "of"}:
                out.add(token.lower())
    return out


def tokens(text: str, masked: set[str], *, industry: bool = False) -> list[str]:
    lowered = re.sub(r"\d+([.,]\d+)?", "#", text.lower())
    out = []
    for word in _WORD.findall(lowered):
        word = word.strip("'-")
        if not word:
            continue
        if word in masked:
            out.append("@name")
        elif industry and word in INDUSTRY_WORDS:
            out.append("@kind")
        else:
            out.append(word)
    return out


def _features(words: Sequence[str]) -> Counter[str]:
    content = [w for w in words if w not in STOP and w not in ("@name", "#")]
    grams = Counter(content)
    grams.update(f"{a} {b}" for a, b in itertools.pairwise(content))
    return grams


def _tfidf(docs: Sequence[Counter[str]]) -> list[dict[str, float]]:
    df: Counter[str] = Counter()
    for doc in docs:
        df.update(doc.keys())
    n = len(docs)
    vectors = []
    for doc in docs:
        # Smoothed IDF (+1): terms in every document still count, so tiny batches compare sensibly.
        vec = {t: (1 + math.log(c)) * (math.log((1 + n) / (1 + df[t])) + 1) for t, c in doc.items()}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        vectors.append({t: v / norm for t, v in vec.items()})
    return vectors


def _cosine_pairs(vectors: Sequence[Mapping[str, float]]) -> dict[tuple[int, int], float]:
    """Cosine of every pair that shares at least one term (an inverted index; the rest are 0)."""
    index: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for i, vec in enumerate(vectors):
        for t, v in vec.items():
            index[t].append((i, v))
    sums: dict[tuple[int, int], float] = defaultdict(float)
    for postings in index.values():
        if len(vectors) >= 50 and len(postings) > len(vectors) // 2:
            # Terms in more than half the documents carry almost no IDF weight; skipping them bounds the work.
            continue
        for a in range(len(postings)):
            i, vi = postings[a]
            for b in range(a + 1, len(postings)):
                j, vj = postings[b]
                sums[(i, j)] += vi * vj
    return sums


def _shingles(words: Sequence[str], k: int = 4) -> set[tuple[str, ...]]:
    return {tuple(words[i : i + k]) for i in range(len(words) - k + 1)}


@dataclass
class Pair:
    a: str
    b: str
    cosine: float
    jaccard: float
    masked_cosine: float

    def public(self) -> dict[str, Any]:
        return {
            "a": self.a,
            "b": self.b,
            "cosine": round(self.cosine, 3),
            "jaccard": round(self.jaccard, 3),
            "masked_cosine": round(self.masked_cosine, 3),
        }


@dataclass
class Report:
    scenarios: int
    worst: list[Pair] = field(default_factory=list)
    failures: list[Pair] = field(default_factory=list)
    shared_items: list[tuple[str, list[str]]] = field(default_factory=list)
    nearest_within_family: dict[int, float] = field(default_factory=dict)
    nearest_across_families: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.failures and not self.shared_items

    def public(self) -> dict[str, Any]:
        return {
            "scenarios": self.scenarios,
            "ok": self.ok,
            "thresholds": {
                "max_cosine": MAX_COSINE,
                "max_shingle_jaccard": MAX_SHINGLE_JACCARD,
                "max_masked_cosine": MAX_MASKED_COSINE,
                "min_shared_chars": MIN_SHARED_CHARS,
            },
            "nearest_within_family": {
                str(k): round(v, 3) for k, v in sorted(self.nearest_within_family.items())
            },
            "nearest_across_families": round(self.nearest_across_families, 3),
            "worst_pairs": [p.public() for p in self.worst],
            "failures": [p.public() for p in self.failures],
            "shared_items": [{"text": t[:80], "scenarios": ids} for t, ids in self.shared_items],
        }


def _items(s: Scenario) -> Iterable[str]:
    raw = s.raw
    for key in ("title", "challenge", "objective", "sources"):
        if raw.get(key):
            yield str(raw[key])
    for key in ("constraints", "hidden", "branches", "expected", "prohibited", "memoryChanges"):
        yield from (str(x) for x in raw[key])
    yield str(raw["scoring"]["pass"])
    if raw["escalation"].get("why"):
        yield str(raw["escalation"]["why"])
    yield from (beat.text for beat in s.arc)
    yield str(raw["venture"]["oneLiner"])
    yield str(raw["student"]["style"])
    for m in raw["priorMemory"]:
        yield str(m["content"])


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def check(scenarios: Sequence[Scenario], *, top: int = 15) -> Report:
    texts = [scenario_text(s) for s in scenarios]
    masks = [own_names(s) for s in scenarios]
    words = [tokens(t, m) for t, m in zip(texts, masks, strict=True)]
    masked_words = [tokens(t, m, industry=True) for t, m in zip(texts, masks, strict=True)]
    cos = _cosine_pairs(_tfidf([_features(w) for w in words]))
    mcos = _cosine_pairs(_tfidf([_features(w) for w in masked_words]))
    shingles = [_shingles(w) for w in words]
    report = Report(scenarios=len(scenarios))
    pairs: list[Pair] = []
    # Candidate pairs: any shared term (cosine) or any shared 4-gram (Jaccard).
    shingle_index: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for i, sh in enumerate(shingles):
        for g in sh:
            shingle_index[g].append(i)
    shingle_pairs = {(a, b) for ids in shingle_index.values() for a in ids for b in ids if a < b}
    for i, j in set(cos) | set(mcos) | shingle_pairs:
        a, b = shingles[i], shingles[j]
        jac = len(a & b) / len(a | b) if a and b else 0.0
        pair = Pair(scenarios[i].id, scenarios[j].id, cos.get((i, j), 0.0), jac, mcos.get((i, j), 0.0))
        pairs.append(pair)
        same = scenarios[i].family == scenarios[j].family
        if same:
            f = scenarios[i].family
            report.nearest_within_family[f] = max(report.nearest_within_family.get(f, 0.0), pair.cosine)
        else:
            report.nearest_across_families = max(report.nearest_across_families, pair.cosine)
        if pair.cosine >= MAX_COSINE or jac >= MAX_SHINGLE_JACCARD or pair.masked_cosine >= MAX_MASKED_COSINE:
            report.failures.append(pair)
    # Pairs with no shared term never enter the index; Jaccard needs a shared 4-gram, hence a shared term.
    pairs.sort(
        key=lambda p: max(
            p.cosine / MAX_COSINE, p.jaccard / MAX_SHINGLE_JACCARD, p.masked_cosine / MAX_MASKED_COSINE
        ),
        reverse=True,
    )
    report.worst = pairs[:top]
    report.failures.sort(key=lambda p: (p.a, p.b))
    seen: dict[str, list[str]] = defaultdict(list)
    for s in scenarios:
        for item in {_norm(x) for x in _items(s)}:
            if len(item) >= MIN_SHARED_CHARS:
                seen[item].append(s.id)
    report.shared_items = sorted((t, ids) for t, ids in seen.items() if len(ids) > 1)
    return report
