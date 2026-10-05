"""Foundry Ascent evaluation and red-team harness.

Runs labelled scenario prompts and adversarial attacks against a deployed Foundry Ascent API, grades
every turn with deterministic graders and reports the blueprint 01 §9 acceptance gates. The harness
never prints prompts, model output, memory content or access codes: console output, results.json and
report.md carry identifiers, counts and grader codes only.
"""

__version__ = "0.1.0"
