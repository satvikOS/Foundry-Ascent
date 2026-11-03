# Foundry Ascent acceptance corpus, FA26 v1

Generate with `python3 evals/datasets/upgrade/generate.py` from the repository root. The JSONL is reproducible, UTF-8, synthetic and versioned. Each of 30 families has 20 explicitly enumerated decision challenges. See `docs/upgrade/EVALUATION.md` for the run boundary, rubric and limits.

Coverage is computed from the fixtures, rather than inferred from their names:

- 600 scenarios; at least eight student/coach exchanges per substantive session.
- 60 scenarios span three sessions. 20 of those have nine student turns per session (54 conversational turns total); the other 40 have eight (48 total).
- 240 scenarios include a material correction/contradictory-evidence turn; 240 change topic and return to a prior thread.
- Multi-session ∩ correction: 60. Long ∩ correction: 20. Multi-session ∩ control: 0. Correction ∩ control: 0. These groups are not independent samples.
- Expected complete execution: 720 sessions, 5,820 student turns with corresponding coach replies (11,640 total conversational turns).

Source/tool conditions and semantic expectations are scenario specifications. The deterministic protocol runner does not magically implement every simulated external condition or grade mentor quality. Infrastructure faults have a separate executable suite. Live-model execution and independent calibration remain required before behavioral acceptance.
