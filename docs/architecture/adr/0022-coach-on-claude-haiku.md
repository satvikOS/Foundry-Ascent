# ADR-0022: The coach on Claude Haiku 4.5, Nova 2 Lite behind it and for background work

- **Status:** Accepted (amends ADR-0014's model table: the primary reasoning model; ADR-0014's fallback logic, Titan
  embeddings and the gated Luna flag stand)
- **Date:** 2026-11-06
- **Deciders:** Platform owner. Decision of **2026-11-06**: "haiku for now, gpt luna api later".
- **Basis:** the coach A/B of 2026-11-05 (live run 42146119067: Claude Haiku 4.5 as the app's coach, 36 of 42 judged
  scenarios passed, naturalness 4.91 and usefulness 4.87 of 5, graded by Llama 4 Maverick; Nova 2 Lite on the same
  persona, 44 of 60, 4.44 and 4.38, live run 42143561959).

## Context and problem statement

Students read what the coach writes: every reply (its streamed text and its structured fields), the recap, and the
opener of their next conversation, which the distillation writes into the notebook. The owner wants the coaching to be
"pristine, like none other". The coach A/B showed Claude Haiku 4.5 ahead of Amazon Nova 2 Lite on every dimension the
live judge scores, on the same Thomas release. A later move to an OpenAI-family model is planned; it must stay a
configuration change and one gateway adapter.

## Decision

1. **Production's coach is Claude Haiku 4.5** through its US inference profile
   (`us.anthropic.claude-haiku-4-5-20251001-v1:0`), on Bedrock Converse. **Amazon Nova 2 Lite** (`us.` profile) is
   its fallback: the gateway falls back as before (timeouts, throttling, 5xx, access, refusals, invalid output; a
   streamed reply only before its first word).
2. **Which purposes use it** (`models.primary` / `models.fallback`): `turn` (phase A's streamed reply, phase B's
   fields, the whole reply when streaming is off), `recap`, `distill` and `test_bench`. The distillation stays on the
   coach because it writes what the student reads first next time (the notebook's `next_opener`, said as written by a
   call: ADR-0021's coach hand-off) and the notebook every later reply recalls from; the A/B ran it on Haiku too
   (memory correctness 5.0 against Nova's 4.75). A studio test conversation is what a student would get.
3. **Background purposes stay on Nova 2 Lite** (`models.background`: primary `us.`, fallback `global.`):
   `classification` (the indirect-ideation safety screen, evaluated on Nova by the lab's safety suite), `eval`,
   `ingestion` and `seed` (the last two embed with Titan; listed so any model call they make stays cheap).
   Embeddings are never a background purpose: they always go to Titan (`models.embeddings`), and the configuration
   and the gateway refuse `embedding` in the list. The runtime contract carries them as `MODEL_BACKGROUND_PRIMARY_ID`, `MODEL_BACKGROUND_FALLBACK_ID` and
   `MODEL_BACKGROUND_PURPOSES`; `turn` can never be a background purpose (config.ts refuses it).
4. **Prompt caching** on Claude Haiku 4.5: the Converse adapter puts a cache checkpoint after the turn prompt's
   unchanging prefix (identity, persona, doctrine, rules, venture, continuity notes: about 18,000 characters, 4,500
   tokens for Thomas, above the model's 4,096-token minimum) and after the conversation so far; the per-turn part
   (control block, turn policy, field contract, output section) and the new message follow the checkpoints. Cached
   tokens are metered at the cache rates (below).
5. **Prices** (AWS Price List API, offer `AmazonBedrockFoundationModels`, us-east-1, published 2026-10-12; the Amazon
   Bedrock pricing page lists the same), USD per million tokens, the `us.` profile (regional, 10 % over global):
   input 1.10, output 5.50, cache write (5 minutes) 1.375, cache read 0.11. `packages/ai/src/pricing.ts` holds the
   global rates and the regional premium. The spend caps are unchanged.
6. **IAM**: the API and worker roles may invoke the Haiku profile in us-east-1 and the Haiku foundation model only in
   the regions that profile routes to from us-east-1 (us-east-1, us-east-2, us-west-2, per its Bedrock model card);
   Nova keeps every region and the region-less ARN (its `global.` profile routes anywhere).
7. **Provider-neutral beyond the adapter**: the gateway contract (`ModelGateway`, purposes, usage with cache tokens,
   the prompt-cache hint) names no provider. What differs for Claude (no sampling parameters, a forced tool only for the
   ids that take one, which ids take cache checkpoints) lives in `packages/ai/src/gateway/nova.ts`, the Converse adapter; a later OpenAI-family
   coach is a new id in `production.json` and its adapter (`luna.ts` already serves Mantle's OpenAI-compatible
   endpoint), with no change in packages/core.

## Consequences

- Good: the coaching the owner asked for, on the model the A/B measured best.
- Good: the cheap model still does the work no student reads, and the coach's fallback is unchanged in kind (a
  different provider family, so a Claude outage does not take both).
- Bad: cost. Without caching a turn costs about 3.5 times Nova's (the lab plan's estimate: ~15.9k input and ~330
  output tokens a turn); the prompt cache takes about half of the coach's input cost back on a conversation's later
  turns (measured with the gateway and a stand-in for Bedrock's cache: 0.88 of phase A's and 0.87 of phase B's input
  read from the cache from the second turn, 55 % less than the same turns uncached; docs/runbooks/latency.md). The
  daily caps hold either way.
- Bad: the live evaluation's default run now costs more: its default sample is 8 scenarios (estimated USD 1.70, within
  the owner's USD 2 cap), and its judge on `auto` is Llama 4 Maverick (another family than the coach).
- Neutral: Haiku's first token: the latency harness's production profile run with a Haiku-like first token is in
  docs/runbooks/latency.md; a production read of `modelFirstTokenMs` replaces it after the deploy.

## Rollback

Set `models.primary` back to `us.amazon.nova-2-lite-v1:0` and `models.fallback` to `global.amazon.nova-2-lite-v1:0`
in `infra/cdk/config/production.json` and deploy (the background route may stay). No data changes.
