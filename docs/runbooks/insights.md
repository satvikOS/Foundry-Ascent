# Runbook: platform insights

**Owner:** platform owner · **Related:** [deploy and rollback](deploy-and-rollback.md),
[infra/iam](../../infra/iam/README.md)

How the platform is actually used (conversations, calls, distillation, knowledge, spend), read from
production without opening a network path to the database and without putting content in a public log.

## How it works

| Piece                                                              | What it may do                                                                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ops - insights** (`.github/workflows/ops-insights.yml`)          | Runs from `main` only, in the GitHub environment `ops-insights`.                                                                                                                          |
| Role `FoundryAscent-OpsInsights` (Foundation stack)                | Trusted only by `repo:satvikOS@…/Foundry-Ascent@…:environment:ops-insights`. `lambda:InvokeFunction` on `FoundryAscent-Insights`; `logs:FilterLogEvents` on `/aws/lambda/FoundryAscent*`. |
| Function `FoundryAscent-Insights` (App stack, `handlers/insights`) | The database policy only. Every read runs in a `SET TRANSACTION READ ONLY` transaction; the requests it accepts are fixed (`metadata` or `export`).                                       |

The deploy role is not widened. The repository is public, so:

- `scope = metadata` prints only numbers, codes, ids and timings. The function validates the report against a strict
  schema (`InsightsReport`) in which no field can hold text; the log step keeps an allow-list of fields whose values
  must be ids, codes, numbers or timings, and drops everything else.
- `scope = export` also exports the content of the window's standard conversations (founder text, validated
  answers, voice fields, digests, notebooks, memory, lessons, openers, the audit trail). It is sealed **inside the
  function** to your RSA public key (RSA-OAEP-256 wrapping a random AES-256-GCM key); only ciphertext reaches GitHub.
  The sealed files are uploaded as an artifact kept for **1 day**. Temporary (private) and deleted conversations are
  counted, never exported.

## One-time setup (repository owner)

Create the environment with the same branch rule as `production` (the role trusts every job in it):

```bash
gh api -X PUT repos/satvikOS/Foundry-Ascent/environments/ops-insights \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/satvikOS/Foundry-Ascent/environments/ops-insights/deployment-branch-policies \
  -f name=main -f type=branch
```

Required reviewers may be added to the environment if every run should wait for an approval.

## Metadata

```bash
gh workflow run ops-insights.yml -f scope=metadata -f days=30
gh run watch "$(gh run list --workflow ops-insights.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The tables are in the job summary and the log.

## Export (content, sealed)

Generate a key pair on your own machine; the private key never leaves it and is never committed:

```bash
dir=<a private folder>; mkdir -p "$dir" && chmod 700 "$dir"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$dir/private.pem" && chmod 600 "$dir/private.pem"
openssl pkey -in "$dir/private.pem" -pubout -outform DER | base64 | tr -d '\n' > "$dir/public.b64"
gh workflow run ops-insights.yml -f scope=export -f days=30 -f public_key="$(cat "$dir/public.b64")"
# when the run is done:
gh run download <run id> -n insights-export-<run id> -D "$dir/sealed"
pnpm --filter @foundry/api exec tsx src/scripts/insights.ts open "$dir/private.pem" "$dir/sealed" "$dir/opened.json"
```

`opened.json` holds personal conversation content: keep it in that folder, never paste it anywhere, and delete it
(and the sealed files) when the analysis is written.
