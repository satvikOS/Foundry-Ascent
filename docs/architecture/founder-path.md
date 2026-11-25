# The founder path: engine, storage and turn wiring

Code decides a venture's next step; the model explains it. The method (stages, criteria, plays, intents, sources) is data
in `packages/core/src/path/playbook/`; everything here is the machinery that reads it.

## Where things are

| File (`packages/core/src/path/`) | What it does                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `words.ts`, `match.ts`           | Normalised words; phrase rules (word boundaries, gaps, `unless`, referral first) and the plainly nearest ask                  |
| `semantic.ts`                    | The play an ask means when no phrase names one, by its embedding (constants per embedding model); what each play is asked for |
| `kinds.ts`                       | Kinds of message by rule: social, recall, report, rehearsal, overview, A-or-B, new idea, smaller, commitment, idea, pivot     |
| `referrals.ts`                   | The risk classifier's categories to the play whose person decides                                                             |
| `state.ts`, `progress.ts`        | Stage and criteria from the stored path and the record; work a founder reports ("8 of 10")                                    |
| `steps.ts`                       | One step: from its row or its play, cut to the time they have, taken up again, as it is shown                                 |
| `engine.ts`                      | `decide(input) -> Decision`: pure (no I/O, model or clock); the turn's step, the path's own, what follows                     |
| `calc.ts`                        | The sums students ask for, from the numbers they gave; the one number that is missing                                         |
| `news.ts`, `tell.ts`             | What news means, by rule; the record said as a mentor says it, the one prior fact, the story                                  |
| `brief.ts`, `turn.ts`            | The founder brief (at most 1,200 characters), the arc, and what the prompt and the record carry                               |
| `report.ts`, `apply.ts`          | The model's `path_report` held to the founder's words; the writes                                                             |
| `service.ts`, `view.ts`          | `GET/PUT/PATCH /ventures/:id/path…`                                                                                           |
| `opener.ts`                      | An opening that names the last step with its due state                                                                        |
| `ai-adapter.ts`                  | `@foundry/ai`'s `renderGuidance`, `checkReplyContract`, `buildSupportIndex`; plain forms where a build has none               |

## The turn's step

A turn's step is the step of what the message is about, never the path's own step again and again:

1. **An explicit ask a play answers** (a phrase of the playbook, a referral's first; else by meaning, below): the step is that play's,
   with its sub-steps, done-when, due day, template and citations, and a derived id. If the play shows a criterion the
   current stage still asks for, it becomes the path's `now` step and the one before waits as `next`, with its id and
   ticks. Otherwise it is **offered**: `TurnGuidance.offered`, not stored, with the path's own step in `pathStep`. Nothing
   displaces a step in the founder's own words.
2. **A follow-up** with no ask of its own stays on the step of the turn before (its stored guidance, in this conversation).
3. **"Get me organised", what next, a report, a recall, the start of a conversation**: the path's own step.
4. **Another idea** (not this venture's): the first step of the first stage, offered beside the path.

An offered step is stored when the founder takes it: `PATCH add` (waiting behind the step under way, or the step now when
there is none), `tick`, `complete`, or "I'll do that" in the conversation (then it is the step now, on the day they said).
What they were shown is what is stored (`pathRepo.shownStep`).

"That's too much", "I only have an hour", "exam week", "something smaller": the same step, same id, cut to its first items
that fit the minutes, done when those are, due soon. Finishing the small part brings the rest of it back.

A message in distress, or that only says how hard things are, gets no step when it asks nothing of the work, and is never
matched to a play by meaning.

## Which play: a phrase, then meaning, then nothing

A wrong play is worse than none: it answers a question nobody asked, with a step. The order is

1. **a referral's phrase** (a qualified person must decide), then **a phrase of any other play**: the playbook's own
   words, found whole. Courtesy, a reaction ("fair enough", "wait, really?") and a word of a play in passing ("the pricing
   page is blue") are never one;
2. **the risk classifier**, when no phrase named an ask;
3. **meaning**: the founder's **own message** (never the retrieval query, which may add the goal) compared with what
   founders ask each play for (`matched: 'semantic'`, with its `score`);
4. **nothing**: the model answers the question itself, and the path's own step stands beside it.

The nearest words (`match.ts` `NEAREST_WORDS`) are in none of these. They stand in for meaning only when it could not be
asked (the embedding failed or was late, the asks have no vectors yet, the model has no constants, the switch is off), held
to a likeness, evidence and margin at which they give **no** play to the messages that ask for nothing and a wrong one to at
most 3 in 100 blind asks (`playbook.test.ts`, `path/play-benchmark`): about half of the playbook's tests' asks, 1 in 16 of
the blind ones.

- **What is stored.** One to three short texts of each play (`playAsks`: its title with the first sentence of its answer,
  and its intent's phrases in two groups), in every tenant, as passages of one source (`knowledge-pack/play-asks.ts`, uri
  `playbook:asks`). The deploy's seed syncs them (nothing is written while `PLAYBOOK_VERSION` and the texts are the stored
  ones; a change replaces only the asks that changed) and its backfill embeds them; a change of embedding model re-embeds
  them like any passage. They are never evidence: the shared search leaves them out of its candidates and its word counts,
  and the document viewer refuses their source. Withdrawing the source (status `withdrawn`) turns the stage off for a tenant.
- **When.** Every message no phrase or rule reads (`Decision.open`), but never a social one, a crisis, distress, venting, a
  reaction, a recall, a report, a commitment, a rehearsal, another idea, a change of direction, "something smaller", or a
  follow-up. A statement only when it says what they want, lack or fear (a plain fact is none), a bare noun phrase, a
  question beside a report, and, while another step is under way, only a question of its own: at a higher floor
  (`guarded`).
- **Which.** The three nearest plays, each by its closest ask (exact, the same every time; equal scores by id), without
  those whose `unless` words the message holds. The first is the answer when it is at the model's `floor` and nearer than
  the next **different** play by `margin`; a play with a referral needs `referralFloor`. A referral play at the floor, about
  as near as the first and not chosen, still brings who decides, as a note. Every constant is in `PLAY_MATCH_PROFILES`
  (`semantic.ts`), by embedding model, and nowhere else. Titan's come from the models benchmark of
  2026-11-24 ("Plays by meaning", docs/runbooks/conversation-lab.md): 68 % of the asks no phrase names get their play, 2.5 %
  another one. A model without a row cannot be asked.
- **What it costs.** A turn a phrase or a rule decided waits for nothing and reads nothing. The others wait for the embedding their
  retrieval needs anyway, at most 400 ms, and make one statement more in the retrieval's own transaction: the play decides
  what the search looks for, so it cannot be the same statement (pinned in `perf/round-trips.db.test.ts`). A late or failed
  embedding, or asks that do not all have a vector of one model yet, leaves the turn to the phrases and plainly nearest
  words. When the message and the
  retrieval query differ, the message is embedded too (the same cache). `turn.path` logs the ids and scores of the three
  nearest, never words.
- **Off.** `CORE_SEMANTIC_PLAYS=off`: the phrases, the rules and plainly nearest words.

**A way out.** The prompt is told how the ask was found (`PromptGuidance.matched`). `phrase`: the program's answer first, as
always. `semantic` (by meaning, or by nearest words): if that answer is not about what they asked, the model answers what
they asked, and the reply contract puts the program's answer in only for a reply that asks, puts off or says nothing. `none`: the model answers, substance first, nothing invented; a step that shares no word with
what they asked is `standing`: said once, last, as what stands ("On your path, next is: …"), at most once in three turns
(`quiet` in between: not said, the card under the reply has it), and never as a "Next:" of theirs. A step given for an
earlier ask that is not on their path is not said to another subject at all.

## What the server says, and what the model says

The model writes only a natural answer. Everything that must be exact is code's, in the same words on a streamed and a
whole reply (`packages/ai` `validators/reply-contract.ts`, `sentence-gate.ts`):

- **The lead** (`PromptGuidance.lead`, `turn.ts` `leadOf`) opens the reply before the model has written anything, so it costs
  no time to the first word: a sum, what news or a report shows, "is that good?", where they stand ("get me organized", as
  a numbered list when they ask for a plan), a recall, the story, a change of direction. Said once: what the model says of
  it again (its figures, the stage, a second plan, its dates) goes, and a lead said a moment ago is cut to where to start.
- **The step line** ends it, once: `**Next:** <title> by <Weekday, Month D>. Done when <done when>.`, on a call "Your next
  step: … by Monday." (a step due today: "today"). Whatever step, deadline, "Next:", done-when or list of the step's parts
  the model writes is left out as a whole block; an answer of fewer than about twelve words left over is the program's own.
- **The one question** is last: a number the calculator lacks (`askBack`), else the model's own.
- **The first part** of the step answers "how do I do that?", with its template filled in from their words (`howTo`,
  `fillTemplate`): what they did not tell keeps its [brackets].
- **One prior fact** (`prior`, `tell.ts` `priorFact`): the confirmed memory, report or sentence of theirs that shares most
  with the ask, else the idea. The model weaves it in; a typed reply that did not gets one sentence, never of what the
  coach said in its last reply, of what this message takes back, or of an order in a message.
- **Their facts only** (`said`, `validators/own-facts.ts`): a line of a template that says more than they did keeps its
  bracket; a sentence that gives them customers, sales or money nobody told goes; so do our words ("the playbook says").
- **Business words** are told in ten words or fewer, once, to who has not said they know them (`validators/glossary.ts`).
- **Sums** (`calc.ts`): price less costs, margin, break-even, a month at a volume, a rate, payback, a share. Deterministic,
  shown with its working; units are never mixed (per box and per month), a missing number is the question.
- **News** (`news.ts`, kind `news`): who paid and who did not, a result against the pass line they set, what people said,
  someone who left, an offer, sign-ups. A sign-up is never called a sale.

## Rules the code keeps

- **One id per step.** A step's id is derived (venture, play, origin, how often the play was closed): known before it is
  stored, the same in every conversation; two turns that give it at once insert one row.
- **Stage.** The furthest of: the stage the path reached, the program's stage when the venture's record holds work of its
  own, and every stage whose criteria are all claimed or met. It goes back in one case only: a change of direction.
- **The record claims, plans do not.** Confirmed evidence, experiments with a result, decisions, milestones and facts claim
  a criterion (a count it asks for must be reached); hypotheses, offers, plans and proposals never do.
- **Due dates.** Today plus the play's days, on a weekday, pulled in by a deadline in the intake. A step past its day is
  named with a day they can still make; the check-in and the opening say what was due.
- **Capstones.** A curriculum capstone's step waits for the venture's own evidence of its stage, unless the deadline in the
  intake is the course's (then it comes first) or they ask for it.
- **Reports.** A founder's own plain report with something to show finishes the step in that turn (its step is the next
  one). Work of a later stage ("I did eight interviews") moves the stage there, claims the earlier criteria in their words,
  and keeps progress and the finding on the criterion (`8 of 10: …`); the step shown is what remains. A step not done moves
  to a new day, with the smaller version offered. "I'll email the five clubs by Friday" becomes their step, in their words, done when that can be counted.
  The annotation call's `path_report` counts only with a quote that is in the message word for word, in a sentence that
  says it happened, and never short of a count.
- **The idea.** Stated in a conversation while the intake has none, it is kept word for word (at most 400 characters), and
  leads the brief, with the latest decision. A recall carries in its lead what they asked for: the idea, what was decided and
  when, what was reported, the open step and its day; the story is dated lines, each thing once, at most eight. A change of direction keeps the new idea, dates the old one in the
  arc (`venture_paths.pivots`), and opens what the old customer had shown, from talking to customers on (their words stay on the criterion, dated).
- **Who decides.** A referral intent wins over every other ask; a risk the classifier found leads to its play when no
  phrase names one, or brings who decides beside another answer; something said in passing (`note`: "my advisor is on the
  paper") brings it too; a push ("you decide", "what do I take") keeps it. An escalation keeps the model's own next step.
- **No round trip of its own**, but for an ask no rule names ("By meaning"). A turn's path reads are part of its context
  statement (`turn-context.ts`); the decision is pure; writes run beside the turn's own, only when something changed.
- **Who sees what.** `venture_paths`, `path_steps`, `path_criteria` (migrations 0033, 0035): read by founders, team and the
  assigned EIR, written by founders and team. Program leads read `app.path_overview` (no words). Deleting a conversation
  erases the words it left (evidence, the idea said in it, a change of it, a step in the founder's own words) and its
  turns' guidance. A temporary chat writes nothing.
- **Kill switch.** `CORE_FOUNDER_PATH=off` runs turns without the path.
