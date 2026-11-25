# The founder path: engine, storage and turn wiring

Code decides a venture's next step; the model explains it. The method (stages, criteria, plays, intents, sources) is data
in `packages/core/src/path/playbook/`; everything here is the machinery that reads it.

## Where things are

| File (`packages/core/src/path/`) | What it does                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `words.ts`, `match.ts`           | Normalised words; phrase rules (word boundaries, gaps, `unless`, referral first) and the nearest ask                      |
| `kinds.ts`                       | Kinds of message by rule: social, recall, report, rehearsal, overview, A-or-B, new idea, smaller, commitment, idea, pivot |
| `referrals.ts`                   | The risk classifier's categories to the play whose person decides                                                         |
| `state.ts`, `progress.ts`        | Stage and criteria from the stored path and the record; work a founder reports ("8 of 10")                                |
| `steps.ts`                       | One step: from its row or its play, cut to the time they have, taken up again, as it is shown                             |
| `engine.ts`                      | `decide(input) -> Decision`: pure (no I/O, model or clock); the turn's step, the path's own, what follows                 |
| `brief.ts`, `turn.ts`            | The founder brief (at most 1,200 characters), the arc, and what the prompt and the record carry                           |
| `report.ts`, `apply.ts`          | The model's `path_report` held to the founder's words; the writes                                                         |
| `service.ts`, `view.ts`          | `GET/PUT/PATCH /ventures/:id/path…`                                                                                       |
| `opener.ts`                      | An opening that names the last step with its due state                                                                    |
| `ai-adapter.ts`                  | `@foundry/ai`'s `renderGuidance`, `checkReplyContract`, `buildSupportIndex`; plain forms where a build has none           |

## The turn's step

A turn's step is the step of what the message is about, never the path's own step again and again:

1. **An explicit ask a play answers** (a phrase of the playbook, or the nearest one by its words): the step is that play's,
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

A message in distress that asks nothing of the work gets no step, and is never matched to a play by likeness.

## Rules the code keeps

- **One id per step.** A step's id is derived (venture, play, origin, how often the play was closed): known before it is
  stored, the same in every conversation; two turns that give it at once insert one row.
- **Stage.** The furthest of: the stage the path reached, the program's stage when the venture's record holds work of its
  own, and every stage whose criteria are all claimed or met. It goes back in one case only: a change of direction.
- **The record claims, plans do not.** Confirmed evidence, experiments with a result, decisions, milestones and facts claim
  a criterion (a count it asks for must be reached); hypotheses, offers, plans and proposals never do.
- **Due dates.** Today plus the play's days, on a weekday, pulled in by a deadline in the intake. A step past its day is
  named with a day they can still make; the check-in and the opening say what was due.
- **Reports.** A founder's own plain report with something to show finishes the step in that turn (its step is the next
  one). Work of a later stage ("I did eight interviews") moves the stage there, claims the earlier criteria in their words,
  and keeps progress and the finding on the criterion (`8 of 10: …`); the step shown is what remains. A step not done moves
  to a new day, with the smaller version offered. "I'll email the five clubs by Friday" becomes their step, in their words.
  The annotation call's `path_report` counts only with a quote that is in the message word for word, in a sentence that
  says it happened, and never short of a count.
- **The idea.** Stated in a conversation while the intake has none, it is kept word for word (at most 400 characters), and
  leads the brief, with the latest decision. A recall carries the facts in `ask.answer`: the idea, what was decided and
  when, what was reported, the open step and its day. A change of direction keeps the new idea, dates the old one in the
  arc (`venture_paths.pivots`), and opens what the old customer had shown, from talking to customers on (their words stay on the criterion, dated).
- **Who decides.** A referral intent wins over every other ask; a risk the classifier found leads to its play when no
  phrase names one, or brings who decides beside another answer; something said in passing (`note`: "my advisor is on the
  paper") brings it too; a push ("you decide", "what do I take") keeps it. An escalation keeps the model's own next step.
- **No round trip of its own.** A turn's path reads are part of its context statement (`turn-context.ts`); the decision is
  pure; writes run beside the turn's own, only when something changed.
- **Who sees what.** `venture_paths`, `path_steps`, `path_criteria` (migrations 0033, 0035): read by founders, team and the
  assigned EIR, written by founders and team. Program leads read `app.path_overview` (no words). Deleting a conversation
  erases the words it left (evidence, the idea said in it, a change of it, a step in the founder's own words) and its
  turns' guidance. A temporary chat writes nothing.
- **Kill switch.** `CORE_FOUNDER_PATH=off` runs turns without the path.
