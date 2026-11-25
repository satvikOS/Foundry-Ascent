# Understand first: one checked reading of a message before anything is written

A founder's message is read against their venture's record by one short structured model call **before** the path decides and
the reply is written. Code checks every field, works out every sum and throws away what nobody gave. It is **off**
(`CORE_UNDERSTAND`), and no model has been measured on it yet: the lab's `understand` suite measures it first
(docs/runbooks/conversation-lab.md, "Understand benchmark").

| Where                                          | What it does                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/ai/src/understand/types.ts`          | `Understanding`: the checked reading, as the engine, the turn and the prompt use it                |
| `…/schema.ts`                                  | `RawUnderstanding`: what the model fills (one level deep, reasoning fields first), and the budgets |
| `…/prompt.ts`                                  | The static system prompt (rules, play catalogue, worked examples) and the message builder          |
| `…/check.ts`                                   | `checkUnderstanding`: ids, numbers, days, names, rulings, the method lint                          |
| `…/expr.ts`, `sums.ts`, `figures.ts`           | The expression parser, the sums and their units, the figures of a text                             |
| `packages/core/src/path/record-lines.ts`       | The record as lines `R1`, `R2`, …                                                                  |
| `packages/core/src/orchestrator/understand.ts` | `prepareUnderstand` (pure), `understandDue`, `understandTurn` (metered, with its budget)           |
| `packages/ai/src/gateway/mock-understand.ts`   | The mock model's reading, so a turn with it on runs offline                                        |

## The call

- **When.** Once the turn is admitted, beside the query's embedding (a refused request buys no call). Never for a crisis, a
  rehearsal or a message that is only social (`understandDue`); a message the safety screen reads first waits for its verdict.
  The studio's test conversations have no path, so they have no reading either.
- **What it reads.** The day; the venture's line, stage and goal; the open step with its day; the record's lines; the last four
  exchanges (the founder's words whole, a reply cut to 360 characters); the message. About 1,500 tokens of the venture's own, each
  part escaped inside its tag (`escapeData`), after a system prompt of about 5,700 tokens that is the same on every turn of every
  venture, so it is one cached prefix. An instruction inside the data is a message to describe.
- **What it answers** (`RawUnderstanding`, at most 800 tokens, about 450 asked for): what they ask; the kind of message; the record
  lines that bear on it; what the record denies; the sums as expressions over named inputs, or the number that is missing; the
  options and the pick; what a result shows and does not; who must decide it; the play, the step's play and how sure; two to four
  points the answer must make with what each rests on; one first action; the one thing not to say. A field of the wrong form costs
  that field alone.
- **The model.** `MODEL_UNDERSTAND_ID`, else the coach's primary; `MODEL_UNDERSTAND_THINK=low` lets Nova 2 reason first. The
  coach's primary stands behind a model of its own. The gateway routes it (`route: 'understand'`), so no other call changes.
- **Its budget.** 2.5 s on a typed turn, 1.2 s on a call, the fallback included (`UNDERSTAND_TIMEOUT_MS`). A late, failed or empty
  reading is none: the turn goes on by its rules, exactly as with the switch off. The turn never waits longer than the budget,
  even for a provider that does not hear its cancellation.
- **Its price.** Metered like every call (purpose `turn`, one usage-ledger row per attempt), so the daily caps count it. An attempt
  that was cut off is metered by an estimate of its prompt (`estimateCut`), because a short budget makes that ordinary.
- **What is logged.** `turn.understand`: the code (`ok`, `nothing_held`, `late`, `cancelled` or the gateway's), milliseconds, model,
  kind, play ids, referral, counts of what was left out by code. Never words.

## The turn

The decision is made, announced (`turn.guidance`, once) and used with the reading: the turn waits for it after "retrieving" is
shown and before the retrieval's transaction opens (a transaction that holds a connection waits for no model), because which play
it is decides what the search looks for. The query's embedding runs meanwhile. Off, nothing of this happens: the same calls, writes,
events and prompts (`orchestrator/understand.db.test.ts`). `pathTurn` gets it as `PathTurnInput.understanding` (null: not read).

## The checks

Everything a reading says is of the message, the conversation in view, the record, the play it names or a sum worked out here.

- **Ids.** A record key or a play that does not exist is dropped; the step's play must be of the path's stage, the one before or the
  one after, or the play of the ask; `sure` counts only with a play.
- **Claims** (points, reasons, what a result shows, the first action, …): one plain line; a number, a day or a name that nothing it
  was shown holds leaves the claim out; so does markup, an address, or the method's lint (`validators/method.ts`). A ruling on what
  a person decides (who owns it, a status, the law, what a round or a stake is worth, whether to sign or take) is never one:
  saying what to wait for, and whom to ask, is.
- **A contradiction** names an existing line and says what it holds.
- **A choice** picks one of the options they named, or both or neither, with a reason that holds; never whether to sign, accept or
  take what a person decides.
- **A referral** is the reading's to add. The rules' own (`referrals.ts`, the risk classifier) stay whatever it says.

### Sums

The model writes `(halls - 1) * price`, never a result. A parser of its own reads it (numbers, input names, `+ - * / ( )`, a
trailing `%`, `ceil(…)` around the whole; nothing is evaluated as code), and the sum is dropped when

- an input is not where it says it is (`message` and `history` are one place; a record key is that line; the message itself always
  counts), or a number written into it is nobody's: a plain constant (12 months, 52 weeks, 7 days, 60 minutes, 100 percent) only
  multiplies or divides. The input it lacked is then what is missing;
- its units do not fit (an amount plus a count, money times money, dollars said as people), it divides by zero, or it is beyond a
  billion;
- its money is not dollars: `$` is the only currency said, and another one is never relabelled.

What the source says wins over what the model says of a number ("15 percent" is a percentage, whatever its unit). A percentage used
as it is stands for its share; `/ 100` and `%` are taken as written. Money is to the cent and shows cents only when it is not whole;
a share has one decimal; a count that is to be reached (break-even, "how many must I …", `round: up`) is rounded up, any other says
"about" when it is not whole. The working is drawn from the expression with the inputs in place: `(4 − 1) × $70 + $70 ÷ 2`.

## The record as lines

`recordLines` gives what stands now, the newest first: decisions, evidence, tests with their result (or said to have none), facts,
people, milestones, changes of direction, what they reported and finished, then what they said of themself (idea, customer, hours,
deadline, limits). Each is a whole sentence in the second person with its day, at most 24 lines and about 1,600 tokens. Left out:
what a newer item replaced (a price told again, a decision corrected, a fact told again under the same label), what is only
proposed, seeded markers, advice of a course, templates. It is built from the same reads as the rest of the turn
(`pathRepo.memoryPart`: never a founder-private item) and the person's own profile and notebook.

## Turning it on

1. The `understand` suite (about USD 2 a run) names the model: sums right, referrals right and none false, picks, results read,
   kinds, inputs found, milliseconds against the budgets, price.
2. The client suite with `understand=on` and that model, the held-out group included, against the same groups with `off`.
3. `infra/cdk/config/production.json`: `models.understand` `{ "enabled": true, "modelId": "…", "think": "low" }` (the last two
   optional). The CDK passes `CORE_UNDERSTAND`, `MODEL_UNDERSTAND_ID` and `MODEL_UNDERSTAND_THINK` to the API alone and grants the model
   to the app's roles. Without it no variable is passed and the API's own default, off, stands.

Nothing in the prompt, the checks or their tests is taken from a lab scenario: the lab fails when five words in a row of a client
line, or four of a held-out one, appear there (`ops/lab/tests/test_understand_bench.py`).
