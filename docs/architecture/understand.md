# Understand first: one checked reading of a message before anything is written

A founder's message is read against their venture's record by three short structured model calls, made at once, **before** the
path decides and the reply is written. Code checks every field, works out every sum and throws away what nobody gave. It is
**off** (`CORE_UNDERSTAND`). The lab's `understand` suite measures it on the models it may run on (docs/runbooks/conversation-lab.md,
"Understand benchmark").

| Where                                             | What it does                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/understand/types.ts`             | `Understanding`: the checked reading, as the engine, the turn and the prompt use it                      |
| `…/schema.ts`                                     | The three answers (short keys, reasoning first), their bounds, the budgets                               |
| `…/prompt.ts`                                     | The three static system prompts with their worked examples, what each is shown, when SUMS has work       |
| `…/merge.ts`                                      | The parts as one reading: what a late part leaves empty, what the others then justify                    |
| `…/check.ts`                                      | `readParts`, `readUnderstanding`: ids, numbers, days, names, rulings, the method lint                    |
| `…/expr.ts`, `sums.ts`, `figures.ts`, `labels.ts` | The expression parser; the sums, their units and periods; the figures of a text; what a figure is called |
| `packages/core/src/path/record-lines.ts`          | The record as lines `R1`, `R2`, …                                                                        |
| `packages/core/src/orchestrator/understand.ts`    | `prepareUnderstand` (pure), `understandDue`, `understandTurn` (metered, with its budget)                 |
| `packages/ai/src/gateway/mock-understand.ts`      | The mock model's readings, so a turn with it on runs offline                                             |

## The three calls

One call wrote about 380 tokens: 2.3 s at the median and 4.7 s at the 95th percentile on Nova 2 Lite, so most typed turns went on
without it. What each part writes is what its decision needs, so a reading takes as long as its longest part.

| Part  | What it answers                                                                                                                                                       | Asked to write | Shown                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| ROUTE | what they ask, a second ask, the kinds (main first), the record lines, the line the message denies, who must decide, the play, the step's play, whether it is sure    | about 60       | the plays (the only part that needs them), the open step, short record lines, two exchanges |
| SUMS  | the figure this message asks for, how it is worked out in words, the numbers (`price=$70@R1`), the sums as expressions, the number that is missing                    | 60 to 100      | the lines and replies that hold a figure, the founder's own words, three exchanges          |
| JUDGE | what the record says instead, the pick with its reason and what would turn it, what a result shows and what settles it, the points, the first action, what not to say | about 150      | the record, three exchanges                                                                 |

- **When.** Once the turn is admitted, beside the query's embedding (a refused request buys no call). Never for a crisis, a
  rehearsal or a message that is only social (`understandDue`); a message the safety screen reads first waits for its verdict.
  The studio's test conversations have no path, so they have no reading either. SUMS is skipped when neither the message nor the
  conversation nor the record holds a figure **and** the message asks for none (`sumsDue`).
- **What they read.** Each part escaped inside its tag (`escapeData`) after a static system prompt, which is one cached prefix a
  call. The three prompts and schemas together are 23,300 characters (the one call's: 25,200), and with what each is shown the whole
  stays at or under what the one call read. An instruction inside the data is a message to describe.
- **The model.** `MODEL_UNDERSTAND_ID`, else the coach's primary; `MODEL_UNDERSTAND_THINK=low` lets Nova 2 reason first. The
  coach's primary stands behind a model of its own. The gateway routes it (`route: 'understand'`), so no other call changes.
- **Their budget.** 3.0 s on a typed turn, 1.4 s on a call, the fallback included (`CORE_UNDERSTAND_TYPED_MS` 500 to 10,000,
  `CORE_UNDERSTAND_VOICE_MS` 500 to 5,000). The decision needs ROUTE and SUMS; JUDGE is waited for to the end only where the reply
  opens on what it says (a choice, a result, an update, a pushback), else 0.7 s (a call: 0.25 s) beyond the other two. What is late is
  cancelled, and the turn never waits longer, even for a provider that does not hear it.
- **A part that is late or failed** leaves its fields empty. Without ROUTE the others say what the message is: a figure they asked
  for is a `sum`, a pick a `choice`, a verdict a `result`; nothing of those is no reading, and the turn goes on by its rules. ROUTE
  points at the record line a message denies; JUDGE tests it, and its word stands where it came.
- **Their price.** Metered like every call (purpose `turn`, one usage-ledger row per attempt), so the daily caps count them. An
  attempt that was cut off is metered by an estimate of its prompt (`estimateCut`).
- **What is logged.** `turn.understand`: the code (`ok`, `partial`, `nothing_held`, `late`, `cancelled` or the gateway's),
  milliseconds, each part's code and milliseconds (`routeCode`, `routeMs`, …), model, kind, play ids, referral, counts of what was left
  out by code and of the inputs found in another place than named (`inputsMoved`). Never words.

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
  was shown holds leaves the claim out; so does markup, an address, the method's lint (`validators/method.ts`), words of the founder,
  the mentor or the opening (a reply speaks to the founder), and giving it away until enough people have it. A ruling on what
  a person decides (who owns it, a status, the law, what a round or a stake is worth, whether to sign or take) is never one:
  saying what to wait for, and whom to ask, is.
- **A contradiction** names an existing line and says what it holds.
- **A figure they asked for** is one SUMS says they ask for and ROUTE or the message says so too.
- **A choice** stands where options are put; its options are theirs (or one's plain no), and it picks one of them, or both or neither,
  with a reason that holds. None where the referral is equity, an invention, immigration, a valuation or a regulation, none on signing,
  agreeing or a company form beside a lawyer's, none on a split, shares, a visa or a patent whatever the referral, and none for free
  where the other option asks for money.
- **A result** stands where something happened or they push back, and shows a figure or words of theirs.
- **What turns a pick or settles a result** holds a number, a person or an act they could see, else it is left out.
- **A referral** is the reading's to add. The rules' own (`referrals.ts`, the risk classifier) stay whatever it says.

### Sums

The model writes `(halls - 1) * price`, never a result. A parser of its own reads it (numbers, input names, `+ - * / ( )`, a
trailing `%`, `ceil(…)` around the whole; nothing is evaluated as code), and the sum is dropped when

- an input is nowhere in the message, the conversation or the record (a number credited to the wrong one is theirs all the same, and
  counted as moved), or a number written into it is nobody's: a plain constant (12 months, 52 weeks, 7 days, 60 minutes, 100 percent) only
  multiplies or divides. The input it lacked is then what is missing;
- its units do not fit (an amount plus a count, money times money, dollars said as people), it divides by zero, or it is beyond a
  billion;
- its money is not dollars: `$` is the only currency said, and another one is never relabelled.

What the source says wins over what the model says of a number ("15 percent" is a percentage, whatever its unit). A percentage used
as it is stands for its share; `/ 100` and `%` are taken as written. Money is to the cent and shows cents only when it is not whole;
a share has one decimal; a count that is to be reached (break-even, "how many must I …", `round: up`) is rounded up, any other says
"about" when it is not whole. The working is drawn from the expression with the inputs in place: `(4 − 1) × $70 + $70 ÷ 2`.

- **Periods.** A figure carries the time its own words give it ("$85 a month", "20 hours a week", "6 weeks"). An expression that mixes
  them is worked out in one of them, shown as it is (`20 × 52 ÷ 12`), unless it already holds a constant of time. The label says the
  period the result has ("what you keep that day" of monthly numbers is "what you keep a month").
- **On top.** A share that is put on top of a base never comes off the whole: "whole × (1 − 8%)" is whole ÷ (1 + 8%).
- **Labels.** A label that cannot stand before "is" becomes one that can, or the unit's plain one; money under zero is said as lost.
- **Built on each other.** A sum may name the sum before it ("income − costs"); the one they asked for comes first.

## The record as lines

`recordLines` gives what stands now, the newest first: decisions, evidence, tests with their result (or said to have none), facts,
people, milestones, changes of direction, what they reported and finished, then what they said of themself (idea, customer, hours,
deadline, limits). Each is a whole sentence in the second person with its day, at most 24 lines and about 1,600 tokens. Left out:
what a newer item replaced (a price told again, a decision corrected, a fact told again under the same label), what is only
proposed, seeded markers, advice of a course, templates. It is built from the same reads as the rest of the turn
(`pathRepo.memoryPart`: never a founder-private item) and the person's own profile and notebook.

## Turning it on

1. The `understand` suite (about USD 2 a run): each part's accuracy, milliseconds, late calls and tokens, and what a turn would have
   had at the caps.
2. The client suite with `understand=on`, the held-out group included, against the same groups with `off`; `understand_ms` raises the
   caps for a run.
3. `infra/cdk/config/production.json`: `models.understand` `{ "enabled": true, "modelId": "…", "think": "low" }` (the last two
   optional). The CDK passes `CORE_UNDERSTAND`, `MODEL_UNDERSTAND_ID` and `MODEL_UNDERSTAND_THINK` to the API alone and grants the model
   to the app's roles. Without it no variable is passed and the API's own default, off, stands. The caps' variables are not passed: a
   deployment has the defaults.

Nothing in the prompts, the checks or their tests is taken from a lab scenario: the lab fails when five words in a row of a client
line, or four of a held-out one, appear there (`ops/lab/tests/test_understand_bench.py`).
