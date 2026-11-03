# Evaluation protocol and limits

The synthetic corpus has 30 families × 20 distinct decisions/challenges. Its generator enumerates the decisions; names and industry substitutions do not define distinctness. `scenarios.jsonl` carries initial student/venture/session state, approved memory, objectives, constraints, source/tool conditions, branches, expectations, prohibitions, memory changes, escalation and versioned criteria. `manifest.json` records exact coverage and overlap.

The executable `apps/api/src/scripts/upgrade-eval.ts` creates isolated ventures in a disposable PostgreSQL database, signs in through Hono, sends real SSE turns through Core's orchestration/retrieval/validators, ends and distills sessions, checks persistence, retries and unauthorized reads. Its simulated student reads the coach's latest question and branches to buyer, evidence, constraints, alternatives, decision criteria or repair. Tagged cases introduce material corrections or change and return to a thread. This is reactive deterministic simulation, not an independent LLM student. It does not prove naturalness. Per-scenario external-tool condition metadata is a specification for live behavioral runs; the separate failure suites inject infrastructure faults.

The local run uses `MockModelGateway`, not Bedrock. Passing protocol checks prove transport/state consistency on those fixtures. They do not establish 95% behavioral acceptance or a 4.5/5 average. Scores are deliberately null. Fixtures can repeat advice and questions; counts of exact repeated-question signals are retained without claiming semantic assessment. No human review or stochastic live-model repetition has occurred. A blinded 60-transcript sample is prepared for calibration, not presented as reviewed. Transcripts contain synthetic data only.

## Behavior rubric

Rate applicable axes from 1 to 5; use 2/4 between anchors and N/A when genuinely inapplicable. Judge the whole conversation and consequential outliers, not preferred wording. Flag critical isolation/disclosure, fabricated citations/actions and stale cancelled audio independently of the mean.

| Axis                 | 1 — poor                                      | 3 — acceptable                    | 5 — excellent                                                            |
| -------------------- | --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Intent               | Misses the decision                           | Finds it after some repair        | Identifies the actual decision, including indirect answers               |
| Relevance/directness | Avoids the question                           | Answers with extra framing        | Gives the useful answer at the requested depth                           |
| Diagnosis            | Prescribes from assumptions                   | Checks the major uncertainty      | Asks only what can change the decision                                   |
| Evidence             | Treats compliments as demand                  | Labels uncertainty                | Calibrates conclusions and a proportionate discriminating test           |
| Adaptation           | Repeats beginner lectures or infeasible tasks | Uses stated constraints           | Adjusts scaffolding to demonstrated competence and resources             |
| Memory               | Uses wrong venture/outdated facts             | Recalls approved context          | Reconciles corrections, scope and provenance without stale claims        |
| Non-redundancy       | Re-asks answered questions                    | Occasional unnecessary repetition | Progresses without repeating advice; justified repetition is excluded    |
| Natural flow         | Canned greetings and forced questions         | Coherent, somewhat mechanical     | Follows timing, topic changes and endings naturally                      |
| Actionability        | Generic framework                             | Feasible next step                | Assumption, action, owner, timing and decision-changing result are clear |
| Escalation           | Misses specialist need or over-refuses        | Appropriate orientation           | Useful scoped help plus a consented, accurate handoff when needed        |
| Repair               | Defends an error or loops                     | Acknowledges and fixes            | Updates reasoning/state promptly and continues coherently                |
| Voice turn-taking    | Cuts off/plays stale speech                   | Understandable but awkward pauses | Correct pauses, interruption, backchannels and aligned captions/audio    |

Independent evaluator process: hide model/run/pass metadata, sample across all families and all failures, use a different judge from the coaching model where available, then compare two human reviewers' labels against automated scores. Adjudicate disagreements, record inter-rater agreement and recalibrate thresholds. This procedure is prepared; no reviewer activity is claimed.

## Commands

```sh
python3 evals/datasets/upgrade/generate.py
pnpm --filter @foundry/api exec tsx src/scripts/upgrade-eval.ts
# Use a fresh destination for every repeat; never append different runs together.
UPGRADE_RESULTS_DIR=/absolute/path/new-run pnpm --filter @foundry/api exec tsx src/scripts/upgrade-eval.ts
pnpm --filter @foundry/web exec node scripts/upgrade-media.mjs
```

`TEST_DATABASE_ADMIN_URL` must identify a disposable PostgreSQL 16 + pgvector cluster. The runner creates/drops its own test database. Run media with Vite at `UPGRADE_WEB_URL` (default 127.0.0.1:5173). This uses an actual Chromium AudioContext and fake audio device; it does not validate provider speech recognition, synthesized voice naturalness or physical-device acoustics. Full results and unresolved acceptance dependencies are linked in the delivery report.
