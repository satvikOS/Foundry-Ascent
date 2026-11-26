# ADR-0025: The coach on Mistral Large 3, every turn read first by Nova 2 Lite with its sums on gpt-oss-120b

- **Status:** Accepted on 2026-11-26. It supersedes [ADR-0024](0024-coach-on-luna.md) for the coach: the coach is
  Mistral Large 3, not Amazon Nova 2 Lite, which stays behind it. ADR-0024's Luna half stands as it is: prepared, off,
  one line. It amends [ADR-0014](0014-bedrock-models-luna-nova-titan.md).
- **Date:** 2026-11-26
- **Deciders:** Platform owner. Decision of **2026-11-26**: "go mistral", then, with the numbers below in front of them,
  "keep mistral".
- **Basis:** the conversation lab's client suite on an unseen set of client conversations (docs/runbooks/conversation-lab.md),
  the lab's understand suite (docs/architecture/understand.md), and the Amazon Bedrock model cards of Mistral Large 3
  and gpt-oss-120b (checked 2026-11-25).

## Context and problem statement

Under ADR-0024 the coach writes on Amazon Nova 2 Lite: cheap and quick, but the client suite's judge scores its
conversations below what the program asks for, and too many turns go unanswered. The lab can put the app's coach on
other Bedrock models (`client.coach` in `ops/lab/models.json`) and grade the same unseen conversations against the
client's seven criteria. Separately, the understand call (docs/architecture/understand.md) reads every turn before the
reply is written; its parts were measured on their own in the understand suite.

## Decision

0. **Production's coach is Mistral Large 3**: `models.primary` `mistral.mistral-large-3-675b-instruct` (its bare
   Bedrock runtime id, through Converse), `models.fallback` `us.amazon.nova-2-lite-v1:0` (another provider's model, so
   an outage of one does not take both), in `infra/cdk/config/production.json`. The background route (Nova 2 Lite `us.`
   then `global.`), the embeddings and the spend caps do not change.

   On the unseen set, the score is the mean of the 7 client criteria (of 5):

   | Lab run, unseen set            | Nova 2 Lite | Mistral Large 3 | DeepSeek V3.2 |
   | ------------------------------ | ----------- | --------------- | ------------- |
   | Score (mean of the 7 criteria) | 3.36        | 4.08            | 4.08          |
   | Not answered (of 70)           | 23          | 7               | 13            |
   | Cost per turn                  | USD 0.0052  | USD 0.0093      | USD 0.0111    |
   | First word, p50                | 2.3 s       | 3.2 s           | 3.8 s         |

   Nova 2 Lite's column is it writing with the reading on. In those runs the reading ran on the coach model itself.
   Mistral and DeepSeek score the same. Mistral leaves fewer turns unanswered, costs less and speaks sooner, so it is
   the coach.

1. **Every turn is read first** (`models.understand.enabled: true`): the reading on Nova 2 Lite (`modelId`
   `us.amazon.nova-2-lite-v1:0`) and its sums on gpt-oss-120b (`sumsModelId` `openai.gpt-oss-120b-1:0`). In the
   understand suite Nova 2 Lite was the best of seven candidates at routing and judging a turn. gpt-oss-120b got about
   90 % of the sums right where the others got about 65 %, in the same time (about 1 s). The split setup (Nova reading,
   gpt-oss sums, Mistral writing) is being measured in the lab now. The numbers above are from runs where the coach
   model did the reading too.

2. **List prices** (Amazon Bedrock on demand, us-east-1, USD per million tokens, input / output), the reason for the
   cost row above:

   | Model             | Input | Output |
   | ----------------- | ----- | ------ |
   | Nova 2 Lite       | 0.30  | 2.50   |
   | Mistral Large 3   | 0.50  | 1.50   |
   | DeepSeek V3.2     | 0.62  | 1.85   |
   | Claude Haiku 4.5  | 1.00  | 5.00   |
   | Claude Sonnet 5.5 | 2.00  | 10.00  |

   `packages/ai/src/pricing.ts` meters Mistral Large 3 and gpt-oss-120b at their rates, so the spend caps see them.

3. **Permissions follow the configuration, and stay as narrow.** Mistral Large 3 and gpt-oss-120b have no inference
   profile: their model cards list in-region serving only, with "Not supported" as the Geo and the Global inference
   ID. So each is granted only as its foundation model in us-east-1
   (`arn:aws:bedrock:us-east-1::foundation-model/<id>`), for `bedrock:InvokeModel` and
   `bedrock:InvokeModelWithResponseStream`. That covers Converse and ConverseStream. No `us.` profile is granted for
   either, because none exists (`infra/cdk/src/lib/models.ts` `IN_REGION_ONLY`). gpt-oss-120b goes to the API role
   alone: only the API runs the understand call and gets its variables (`CORE_UNDERSTAND`, `MODEL_UNDERSTAND_ID`,
   `MODEL_UNDERSTAND_SUMS_ID`). gpt-oss runs on the Bedrock runtime through Converse, not Bedrock Mantle, so no
   Mantle permission is granted, and no Claude model is granted. `infra/cdk/test/models.test.ts` proves these exact
   grants.

4. **The Luna switch is still one line**: `models.primary` `us.openai.gpt-6-luna` replaces Mistral, with Nova 2 Lite
   behind it. `models.luna.enabled` makes Luna primary with the configured primary (Mistral) behind it. Both stay off
   while AWS refuses the account Luna (ADR-0024).

## Consequences

- Good: the judge scores the coach's conversations 4.08 instead of 3.36, and far fewer turns go unanswered (7 of 70,
  not 23).
- Good: the same endpoint, adapter, fallback rules and spend caps. The fallback is another provider's model.
- Bad: a turn costs about 2 to 3 times what it did on Nova 2 Lite.
- Bad: the first word comes about a second later (p50 3.2 s against 2.3 s).
- Bad: Mistral Large 3 is served in region only: no cross-region profile spreads its load when us-east-1 is short of
  capacity. The fallback, Nova 2 Lite through its US profile, takes the turn then.
- Neutral: the prompt and the validators were tuned on Claude and Nova. The client suite's judge, from another family,
  is how a new failure would show.

## Rollback

One line in `infra/cdk/config/production.json`: set `models.primary` back to `us.amazon.nova-2-lite-v1:0`, then deploy
as usual. Optionally also set `models.fallback` back to `global.amazon.nova-2-lite-v1:0` (ADR-0024's pair). Mistral's
permission leaves with it. No data changes. To also stop reading every turn first, set `models.understand.enabled` to
`false`.

## Revisit when

- The lab's measurement of the split setup (Nova reading, gpt-oss sums, Mistral writing) is in: if it scores below
  4.08, or costs or waits more than the table above, decide again.
- A candidate scores higher on the unseen set at no more cost and latency, or the account is granted GPT-6 Luna.
- AWS offers Mistral Large 3 behind a cross-region inference profile.
