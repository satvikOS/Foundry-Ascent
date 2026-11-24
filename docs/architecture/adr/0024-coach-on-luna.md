# ADR-0024: The coach on GPT-6 Luna through Bedrock Converse (prepared, switched off)

- **Status:** Proposed (the gateway, permissions and measurements are in place; production still runs ADR-0022's Claude
  Haiku 4.5). Accepted when the switch below is made. It would amend ADR-0022 (the coach's model) and replace the path
  ADR-0014 reserved for Luna (Bedrock Mantle, `models.luna`).
- **Date:** 2026-11-24
- **Deciders:** Platform owner. Request of **2026-11-24**: a cheaper coach ("GPT-6 Luna, else Nova 2 Lite; not Haiku
  4.5") and "better cheaper faster stronger embedding models", with replies that cite what they rest on.
- **Basis:** GPT-6 Luna's Amazon Bedrock model card and the Converse reference (checked 2026-11-24).

## Context and problem statement

A typed turn costs USD 0.012 to 0.024 on Claude Haiku 4.5 and its first token takes 2 to 3 s (16,000 to 18,000 input
tokens). GPT-6 Luna is listed at a tenth of Haiku's input and output rates. On 2026-10-05 the account was refused Luna on
Bedrock **Mantle** (401, account-level gating); AWS has since listed it on the **Bedrock runtime**, behind inference
profiles, with Converse and response streaming: the endpoint, the SDK and the permissions the coach already uses. Whether
the account may call it there is unknown until a run tries. Embeddings have been Titan V2 since the start, unmeasured
against what else Bedrock offers.

## Decision

1. **Luna runs on the Converse adapter** (`packages/ai/src/gateway/nova.ts`), as `us.openai.gpt-6-luna` or
   `global.openai.gpt-6-luna`; the bare id stays Mantle's. What its requests carry, from the model card and what other
   Converse clients report:
   - reasoning effort `none` in `additionalModelRequestFields.reasoning.effort` (the flat `reasoning_effort` is refused;
     the model's own default is `medium`, the slowest start); `MODEL_REASONING_EFFORT` changes it;
   - a temperature only at effort `none` (OpenAI models take sampling parameters at no other effort);
   - structured output through the forced submit tool, as every model on Converse;
   - no cache checkpoints: the card says `cachePoint` is not supported on Converse for it. Bedrock caches a repeated
     prefix of 1,024 tokens or more on its own; what it reports read and written is priced at the cache rates.
   - A field Bedrock refuses is left out for one retry (effort `none`, then `low`, then none sent; tool choice `auto`,
     where a reply written as text is still read and repaired) and not sent again by that process. Reasoning content
     never reaches the founder.
2. **The conversation samples at temperature 0** (`turn`, `test_bench`; `MODEL_COACH_TEMPERATURE`) on the models that
   take one (Nova 2 Lite, Luna). The founder path decides a turn's content in code and the model explains it, so the
   same turn should read the same twice. Claude requests carry no sampling parameter, as before.
3. **Prices** (USD per million tokens, prompts up to 272,000 tokens): `us.` input 0.11, output 0.55, cache write 0.1375,
   cache read 0.011; `global.` a tenth less. `packages/ai/src/pricing.ts` holds the global rates and the regional premium.
4. **Permissions follow the configuration.** A `us.` Luna coach gets its profile in us-east-1, its foundation model in
   the profile's destination regions (us-east-1, us-east-2, us-west-2), and `bedrock:InvokeModel` on the account's
   default project, which the model card asks for beside the profile. No Mantle permission. While production does not
   name Luna, the app's roles get none of it.
5. **Measured first.** The conversation lab's `models` suite probes which candidates the account may call, times coaching
   replies and structured answers through the app's gateway, and compares embedding models and rerankers on a committed
   retrieval benchmark (docs/runbooks/conversation-lab.md, "Models benchmark"). The lab role may invoke the candidates;
   GPT-6 Luna is also a coach of the live evaluation's A/B, judged by no OpenAI model.
6. **The switch is one line** in `infra/cdk/config/production.json`, then a normal deploy:

   ```json
   "primary": "us.openai.gpt-6-luna",
   ```

   `fallback` is already `us.amazon.nova-2-lite-v1:0`; the background route, embeddings and caps do not change.
   `infra/cdk/test/models.test.ts` ("GPT-6 Luna as the coach") proves the environment and permissions of that
   configuration today. The tests that state production's current coach (`models.test.ts`, the app template's snapshot,
   `ops/lab/tests/test_config.py`) change with it.

## Make the switch when

1. the `models` suite shows `us.openai.gpt-6-luna` answering, with a first token at p50 of 1.2 s or less and structured
   output valid on the first answer or after one repair every time;
2. the live evaluation's Luna arm, graded by the same judge as the default arm (`judge_model=ab`), is not below it on
   the brief's dimensions, and the founder path's own acceptance run passes on it;
3. if Luna is refused, the coach becomes Nova 2 Lite instead: `primary` `us.amazon.nova-2-lite-v1:0`, `fallback`
   `global.amazon.nova-2-lite-v1:0`.

## Consequences

- Good: about a tenth of Haiku's price per token; the same endpoint, adapter, fallback rules and spend caps.
- Good: the fallback is another provider's model, so an outage of one does not take both.
- Bad: Luna's caching is implicit: no checkpoint guarantees a hit. A cold prefix costs the cache-write rate (1.25 times
  input), which the gateway meters.
- Bad: the judge of the live evaluation, the calibration of the prompt and the validators were tuned on Claude and Nova;
  a new family may fail them in new ways. The A/B is there to see it.
- Neutral: Mantle's Luna provider (`luna.ts`, `models.luna`) stays as it is, disabled.

## Rollback

Set `models.primary` back to `us.anthropic.claude-haiku-4-5-20251001-v1:0` and deploy. No data changes.

## Embeddings and reranking

Nothing changes here yet. The benchmark's numbers decide whether Titan V2 at 1,024 dimensions is replaced (Cohere Embed
v4, Nova Multimodal Embeddings, or Titan at a smaller size) and whether a reranker is worth its price per query. A
different model means embedding every stored passage again (vectors of two models never compare) and, for another size
than 1,024, a migration of the `vector(1024)` columns. Amazon Rerank 1.0 is not offered in us-east-1: using it would send
passages to us-west-2.

## Revisit when

- AWS offers explicit cache checkpoints on Converse for Luna, or lists a price change on its model card.
- The models suite shows a candidate ahead of production's on quality at no more cost and latency.
