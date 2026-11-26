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
| `…/conflicts.ts`, `salvage.ts`                    | When the record denies what they say; an answer one field swallowed                                      |
| `…/check.ts`                                      | `readParts`, `readUnderstanding`: ids, numbers, days, names, rulings, the method lint                    |
| `…/expr.ts`, `sums.ts`, `figures.ts`, `labels.ts` | The expression parser; the sums, their units and periods; the figures of a text; what a figure is called |
| `packages/core/src/path/record-lines.ts`          | The record as lines `R1`, `R2`, …                                                                        |
| `packages/core/src/orchestrator/understand.ts`    | `prepareUnderstand` (pure), `understandDue`, `understandTurn` (metered, with its budget)                 |
| `packages/ai/src/gateway/mock-understand.ts`      | The mock model's readings, so a turn with it on runs offline                                             |

## What a turn does with it

Where no rule read the message precisely, the reading decides the turn and goes to the writer as notes: the writer writes the whole reply
and its one fitted step, and code checks them (founder-path.md, "Resting on a reading"). Where a rule did, or the switch is off, the turn is
the one without a reading, to the byte. A reply that is none once its false sentences are out is written again once, within
`REPAIR_BUDGET_MS` (`orchestrator/generate.ts`: 2.5 s typed, 1.2 s on a call, counted from the end of the first draft). A whole reply without its
step line has that line asked for alone, once (`STEP_ASK_BUDGET_MS`: 1.5 s typed, 1 s on a call). Both short edits, the line and the
reply written again, go to the reading's model (`route: 'understand'`, Nova 2 Lite in production, the coach behind it): the coach
(Mistral Large 3, about 96 output tokens a second and 1.3 s to a short answer) does not fit their budgets. A rule that read the message as
another kind of thing (words to send beside news, feelings, made-up work, a complaint) gives way to the reading.

## The three calls

One call wrote about 380 tokens: 2.3 s at the median and 4.7 s at the 95th percentile on Nova 2 Lite, so most typed turns went on
without it. What each part writes is what its decision needs, so a reading takes as long as its longest part.

| Part  | What it answers                                                                                                                                                    | Asked to write | Shown                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------- |
| ROUTE | what they ask, a second ask, the kinds (main first), the record lines, the line the message denies, who must decide, the play, the step's play, whether it is sure | about 60       | the plays (the only part that needs them), the open step, short record lines, two exchanges |
| SUMS  | the figure this message asks for, how it is worked out in words, the numbers (`price=$70@R1`), the sums as expressions, the number that is missing                 | 60 to 100      | the lines and replies that hold a figure, the founder's own words, three exchanges          |
| JUDGE | what the record says instead, the pick with its reason and what would turn it, what a result shows and what settles it, the points                                 | about 150      | the record, three exchanges                                                                 |

- **When.** Once the turn is admitted, beside the query's embedding (a refused request buys no call). Never for a crisis, a
  rehearsal or a message that is only social (`understandDue`); a message the safety screen reads first waits for its verdict.
  The studio's test conversations have no path, so they have no reading either. SUMS is skipped when neither the message nor the
  conversation nor the record holds a figure **and** the message asks for none (`sumsDue`).
- **What they read.** Each part escaped inside its tag (`escapeData`) after a static system prompt, which is one cached prefix a
  call. Measured on Nova 2 Lite (lab-bench2): 8,700 tokens in together, 7,700 of them cached, against 7,290 for the one call; each
  call pays the provider's own tool instructions. An instruction inside the data is a message to describe.
- **The model.** `MODEL_UNDERSTAND_ID`, else the coach's primary; `MODEL_UNDERSTAND_THINK=low` lets Nova 2 reason first. The
  coach's primary stands behind a model of its own. The gateway routes it (`route: 'understand'`), so no other call changes.
  SUMS may have a model of its own (`MODEL_UNDERSTAND_SUMS_ID`, `route: 'understand_sums'`; `MODEL_UNDERSTAND_SUMS_THINK` `low`,
  `medium` or `high`: an OpenAI model's reasoning effort, Nova 2's thinking at low), off by default. On the lab's bench gpt-oss-120b
  at low effort read SUMS better than Nova 2 Lite (lab-bench3-oss: the own cases' open half 21/24 against 16/24, the held half 19/21
  against 14/21) at about the same median (978 ms against 947) and for less, while its ROUTE and JUDGE were worse: so only SUMS. It
  has no fallback: a SUMS that fails or is late on it is not asked of the other model (there is no time), and the turn goes on with
  the parts it has, as for any late part. gpt-oss reports no cached tokens, so the SUMS prompt is kept short (about 4,400
  characters). Production named gpt-oss-120b for its sums for one release and went back to Nova 2 Lite (ADR-0025): on the
  lab's set 3 it was late on 9 of the 16 asked figures that went missing, while after the code-side fixes the two sum the
  same on the bench's common cases (21 of 24).
- **On a call** JUDGE has a form of its own (`judgeVoice`): the pick and what happened, which open the reply, and nothing else (about 70
  tokens); a contradiction, points and a first action are the typed turn's.
- **Their budget.** 3.0 s on a typed turn, 1.7 s on a call, the fallback included (`CORE_UNDERSTAND_TYPED_MS` 500 to 10,000,
  `CORE_UNDERSTAND_VOICE_MS` 500 to 5,000). The decision needs ROUTE and SUMS; JUDGE is waited for to the end only where the reply
  opens on what it says (a choice, a result, an update, a pushback), else 0.7 s (a call: 0.25 s) beyond the other two. What is late is
  cancelled, and the turn never waits longer, even for a provider that does not hear it.
- **A part that is late or failed** leaves its fields empty. Without ROUTE the others say what the message is: a figure they asked
  for is a `sum`, a pick a `choice`, a verdict a `result`; nothing of those is no reading, and the turn goes on by its rules. ROUTE
  and JUDGE each name a line the message denies; without either there is no contradiction.
- **Meanings code puts right** (`meaning.ts`), each over the same numbers: a share they take used as yours, yours used as
  theirs, a share of yours used as what reaches another person ("we hold back 10%" and the sitter's hour: the 90%), margins and
  markups, needless period turns, and a follow-up's new number put where the like one stood ("and at 25 instead?" after
  "$1,500 × (20% − 2%)": 25% for 20%, never $25 for $1,500).
- **What code decides of a sum.** Whether it was **asked**: ROUTE reads the message as a sum, or the message's own words ask for
  a figure (how much, how many, what is the total, what is left after, what does that make, what am I into, written as people
  write them). "What's next", "what now", "what's left to do", "what can the page say" ask for a step or words, never a figure,
  even beside numbers they tell; "so far" and "all in" count only where no step is asked. Without ROUTE, SUMS's own word stands
  for a question that asks for no step. Only an asked sum opens or decides a reply. What is **missing** where nothing can be worked out: the model's `m`, else the number that is nowhere, else, for a sum of
  one number of theirs whose plan takes something off it, "the other numbers it needs". How a number is read: "a third" is a share,
  "350 every week" an amount and not a time, a number before one thing ("the 600 website") is no count of it, a number at a line's end
  counts nothing of the next line, and a bracket left at the end of an expression is the answer's. A sum asked as named shapes with
  slots that code builds was measured worse on the models (lab-bench4: the common 24 open cases, Nova 2 Lite 16 to 11, gpt-oss 21 to
  10), so SUMS writes the expression.
- **SUMS again.** A cheap check that disagrees with the sum asks for it once more, in what is left of the budget (`again.ts`): a plan
  with no sum, a sum code could not work out (with the reason), or a figure of what is kept, reached or charged that leaves out an
  amount, a share or a count told in the line it takes a number from, or a count of other things than the message asks for
  ("tins" where it asks how many studios; such a sum is never the asked figure). It is asked only with a second left of
  the budget (a second call on Nova 2 Lite takes 0.6 to 1.0 s). The second stands only where it answers the doubt. A field that
  swallowed the rest of its object is read back (`salvage.ts`). `sumsAgain` in the log says which check it was.
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
  the mentor or the opening (a reply speaks to the founder; "the founder keeps" is said as "you keep" where that is all it takes), and giving it away until enough people have it. A ruling on what
  a person decides (who owns it, a status, the law, what a round or a stake is worth, whether to sign or take) is never one:
  saying what to wait for, and whom to ask, is.
- **A contradiction** is rare, because the reply opens on it (`conflicts.ts`). ROUTE and JUDGE name the same line, each for itself; the
  line is evidence, a test, a fact, a decision or a milestone (never who they are, what they hope or what is to be done, nor a
  decision the message moves on from); JUDGE quotes the claim word for word, and the claim rates or generalises (everyone, always,
  growing, proven) against counts that fall short (steady and growing: against two counts of the line that go another way), or gives another number for the same thing; what is said of it holds both sides.
  None in a recall, a draft, small talk or a report that asks nothing, and a new figure in place of an old one denies nothing.
- **A figure they asked for** is one SUMS says they ask for and ROUTE or the message says so too.
- **A choice** stands where options are put; its options are theirs (or one's plain no), and it picks one of them, or both or neither,
  with a reason that holds. None where the referral is equity, an invention, immigration, a valuation or a regulation, none on signing,
  agreeing or a company form beside a lawyer's, none on a split, shares, a visa or a patent whatever the referral, and where the
  other option asks for money, free is never the pick: the paying one is, if the record says nobody was asked.
- **A result** stands over an outcome alone (`told.ts`): what somebody did, said or paid, or a count of it, told now or just before and
  asked about, or where they push back. A fear, a plan, a question or a what-if has none. It shows a figure or words of theirs, against
  their own earlier ones where there are some; what settles it is a thing to do with a number and what each side means. Kind words of
  people close by are never more than weak, and strong is money, a signature or coming back.
- **A second question** the call left out is read from the message's own words, where it asks two.
- **What turns a pick or settles a result** holds a number, a person or an act they could see, else it is left out. There, and in the
  first action, a small or round size of something to do ("ask 10 of them", "for 2 weeks") is a test and no invented fact; an amount,
  a share, and whatever is told as having happened, never. An amount somebody is to pay in it is a price they charge or were told
  (`pricesIn`): the clause with their budget, savings or a cost goes. What would turn a pick has somebody who does it.
- **A referral** is the reading's to add, and `told.ts` adds one where the words leave no doubt (a letter about a name or a seal,
  exclusivity or code rights in a paper, shares for money, a trial on patients or children, a claim to heal, pay on a visa). The rules' own (`referrals.ts`, the risk classifier) stay whatever it says.

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
as it is stands for its share; `/ 100` and `%` are taken as written. Money is to the cent under a thousand dollars and whole from there on;
a share has one decimal; a count that is to be reached (break-even, "how many must I …", `round: up`) is rounded up, any other says
"about" when it is not whole. The working is drawn from the expression with the inputs in place: `(4 − 1) × $70 + $70 ÷ 2`.

- **Bare numbers.** "Glaze 3" beside dollars is dollars; a number that counts something ("30 kits") never is. Numbers of theirs may
  be written into the expression. One that nobody wrote is taken when two numbers of one line come to it in one way (18 − 5), and they
  stand in the working; else it is nobody's.
- **Periods.** A figure carries the time its own words give it ("$85 a month", "20 hours a week", "6 weeks"). An expression that mixes
  them is worked out in one of them, shown as it is (`20 × 52 ÷ 12`), unless it already holds a constant of time. The label says the
  period the result has ("what you keep that day" of monthly numbers is "what you keep a month").
- **Meaning** (`meaning.ts`). A share says who it goes to by the words around it ("we skim 8%", "the gallery keeps 35%") and what it is of
  ("a third of the price"). What they take is that share and never its complement, what is taken from them the reverse; a share of the
  price solves for the price (cost ÷ (1 − share)); a constant of time among numbers of one period goes, unless another period is asked;
  a share above 100% of a whole was divided the wrong way round. Each rewrites the expression over the same inputs (`sumMends` in the
  log).
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

Every line is a sentence to them: what a record says of nobody it names ("Uses a notebook") is left out, "Has $80" is "You have $80", a
risk is one they see. What a later telling or the message itself says otherwise (somebody in it has left or is back, the price is
another one now) is told as how it was, "(was true until November 15)", and denies nothing.

## Turning it on

1. The `understand` suite (about USD 2 a run): each part's accuracy, milliseconds, late calls and tokens, and what a turn would have
   had at the caps.
2. The client suite with `understand=on`, the held-out group included, against the same groups with `off`; `understand_ms` raises the
   caps for a run.
3. `infra/cdk/config/production.json`: `models.understand` `{ "enabled": true, "modelId": "…", "think": "low", "sumsModelId":
"…", "sumsThink": "low" }` (all but `enabled` optional; no `sumsModelId`: SUMS is on the understand model). The CDK passes
   `CORE_UNDERSTAND`, `MODEL_UNDERSTAND_ID`, `MODEL_UNDERSTAND_THINK`, `MODEL_UNDERSTAND_SUMS_ID` and `MODEL_UNDERSTAND_SUMS_THINK`
   to the API alone and grants the models to the app's roles. Without it no variable is passed and the API's own default, off, stands. The caps' variables are not passed: a
   deployment has the defaults.

Nothing in the prompts, the checks or their tests is taken from a lab scenario: the lab fails when five words in a row of a client
line, or four of a held-out one, appear there (`ops/lab/tests/test_understand_bench.py`).
