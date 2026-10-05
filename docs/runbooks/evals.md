# Runbook: evaluate production (scenario benchmark and red team)

**Owner:** platform owner · **Workflow:** `.github/workflows/evals.yml` (**Evals - scenario benchmark
and red team**) · **Code:** [`evals/`](../../evals/README.md) · **Related:**
[access codes](access-codes.md), [cost controls](cost-controls.md), [system design §11](../architecture/system-design.md#11-quality-security-and-evaluation)

The harness signs in to a deployed site, issues short-lived codes for synthetic principals, runs the
labelled scenarios and red-team attacks, grades every turn deterministically and reports the blueprint 01
§9 gates (0 critical cross-venture disclosures, ≥ 95 % high-risk escalation recall, …). Run it after a
release that changes prompts, validators, the risk classifier or the model, and before and after enabling
GPT-6 Luna ([ADR-0014](../architecture/adr/0014-bedrock-models-luna-nova-titan.md#enabling-luna-later)).

## One-time setup (repository owner)

| Setting                | Kind     | Value                                                                                                     |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `FA_OWNER_ACCESS_CODE` | Secret   | The platform owner's access code (`FA-XXXXX-XXXXX-XXXXX-XXXXX` format), from the owner's password manager |
| `FA_SITE_URL`          | Variable | The site origin, e.g. `https://dxxxxxxxxxxxxx.cloudfront.net` (the Deploy job summary shows it)           |

Both live under Settings → Secrets and variables → Actions (the secret on the **Secrets** tab, the URL on
the **Variables** tab). The secret is the only sanctioned copy of the owner code outside the password
manager ([access codes](access-codes.md#rotate-the-owner-code)): GitHub stores it encrypted and masks it
in logs, and workflows triggered from forks never receive it. Never put the code in a variable or a
workflow input. When the owner code is rotated, update the secret; when no evaluation is planned, delete
it.

## Run

1. Actions → **Evals - scenario benchmark and red team** → _Run workflow_ on `main`.
2. Inputs: `base_url` (empty = `FA_SITE_URL`), `suite` (`all`, `scenarios`, `redteam`), `max_turns`
   (default 100; each turn is one Bedrock call, ≈ $0.007 with Nova 2 Lite), optional `max_cost_usd`.
3. The job first runs the offline lint and unit tests with the pinned toolchain
   (`evals/requirements-dev.txt`), then checks the secret and the URL, then evaluates.
4. Read the report in the job summary; the `evals-results-<run id>` artifact (14 days) holds
   `results.json` and `report.md` (case ids, statuses, grader codes and aggregates only).

The first request after an idle period waits for Aurora to resume (~15 s): the public health check never
wakes the database, so the harness waits at sign-in, retrying `503 database_resuming` with `Retry-After`.
Every issued code is revoked when the run ends, also on failure.

## Exit codes and what to do

| Exit | Meaning                                                                  | Action                                                                                                                        |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 0    | every blocking gate passed                                               | none                                                                                                                          |
| 1    | a gate failed                                                            | triage per gate in the report; a G1 failure (cross-venture disclosure) is a SEV-1 ([incident response](incident-response.md)) |
| 2    | configuration or dataset error                                           | fix the input or the dataset                                                                                                  |
| 3    | setup failed or the run was aborted (kill switch, spend cap, rate limit) | check the secret, the site URL, the AI switch and today's spend in **Admin → Settings / Usage**                               |

Spend: a full run is 171 turns, the default cap of 100 turns costs about $0.70 with Nova 2 Lite and
counts toward the daily caps of the synthetic principals and the platform ([cost controls](cost-controls.md)).
Never enable `--include-transcripts` in CI: logs and artifacts of this public repository are public.
