# The founder path: engine, storage and turn wiring

Code decides a venture's next step; the model explains it. The method (stages, criteria, plays, intents, sources) is data
in `packages/core/src/path/playbook/`; everything here is the machinery that reads it.

## Where things are

| File (`packages/core/src/path/`) | What it does                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `words.ts`, `match.ts`           | Normalised words; phrase rules (word boundaries, gaps, `unless`, referral first) and the plainly nearest ask                    |
| `semantic.ts`                    | The play an ask means when no phrase names one, by its embedding (constants per embedding model); what each play is asked for   |
| `kinds.ts`                       | Kinds of message by rule: social, recall, report, rehearsal, overview, new idea, smaller, commitment, idea, pivot and back      |
| `counts.ts`, `choice.ts`         | How many of whom did what, exact or not counted; a choice they ask to have made, and the pick the record decides                |
| `state.ts`, `progress.ts`        | Stage and criteria from the stored path and the record; work a founder reports ("8 of 10")                                      |
| `steps.ts`                       | One step: from its row or its play, cut to the time they have, taken up again, as it is shown (fitted: in the writer's words)   |
| `engine.ts`                      | `decide(input) -> Decision`: pure (no I/O, model or clock); the turn's step, the path's own, what follows                       |
| `understood.ts`                  | A checked reading as the turn uses it: what of it may be said, who decides, the step that fits                                  |
| `outcome.ts`, `told-counts.ts`   | Whether a message reports an outcome; what its counts show when nobody read the result                                          |
| `asked-sums.ts`, `lint.ts`       | A figure they ask for that nobody worked out; a line of the record as a whole sentence to them                                  |
| `openings.ts`, `sum-said.ts`     | What the server itself says of a message that was read (an asked figure, what nobody here rules on, integrity); a worked figure |
| `denied.ts`, `referrals.ts`      | A claim of growth the record denies; money offered for a part of the company, in any words; a risk's play                       |
| `calc.ts`, `calc-read.ts`        | The sums students ask for, from the numbers they gave and their roles; the one number that is missing                           |
| `reading.ts`                     | What they have and what is missing for a judgement, and the program's answer to it made for them                                |
| `price-change.ts`, `stated.ts`   | The line a changed price has to beat; who, today and why them of the page, in their words                                       |
| `heard.ts`                       | What a call heard badly, put right from the venture's own words                                                                 |
| `news.ts`, `tell.ts`             | What news means, by rule; the record said as a mentor says it, the one prior fact, the story                                    |
| `brief.ts`, `turn.ts`            | The founder brief (at most 1,200 characters), the arc, and what the prompt and the record carry                                 |
| `report.ts`, `apply.ts`          | The model's `path_report` held to the founder's words; the writes                                                               |
| `service.ts`, `view.ts`          | `GET/PUT/PATCH /ventures/:id/path…`                                                                                             |
| `opener.ts`                      | An opening that names the last step with its due state                                                                          |
| `ai-adapter.ts`                  | `@foundry/ai`'s `renderGuidance`, `checkReplyContract`, `buildSupportIndex`; plain forms where a build has none                 |

## The turn's step

A turn's step is the step of what the message is about, never the path's own step again and again:

1. **An explicit ask a play answers** (a phrase of the playbook, a referral's first; else by meaning, below): the step is that play's,
   with its sub-steps, done-when, due day, template and citations, and a derived id. If the play shows a criterion the
   current stage still asks for, it becomes the path's `now` step and the one before waits as `next`, with its id and
   ticks. Otherwise it is **offered**: `TurnGuidance.offered`, not stored, with the path's own step in `pathStep`. Nothing
   displaces a step in the founder's own words.
2. **A follow-up** with no ask of its own stays on the step of the turn before (its stored guidance, in this conversation).
   How to do one of its parts, in words of that part (`partAsked`), is answered by that part; what is never shared answers
   only a message about what others here do (`namesOthers`).
3. **"Get me organised", what next, a report, a recall, the start of a conversation**: the path's own step.
4. **Another idea** (not this venture's): the first step of the first stage, offered beside the path.
5. **What they just told** that moves the customer, whatever the path's own step is (`engine.ts` `NEWS_PLAYS`): somebody
   else pays, asks for it, refuses for a reason, has a spending rule, offers a trial or money, meets them as an investor, a
   page brought sign-ups, someone left, what works goes public. The play that acts on it is offered, the path's step kept
   beside it; what they said they would do is never displaced, and early proof moves nothing of a later stage.

An offered step is stored when the founder takes it: `PATCH add` (waiting behind the step under way, or the step now when
there is none), `tick`, `complete`, or "I'll do that" in the conversation (then it is the step now, on the day they said).
What they were shown is what is stored (`pathRepo.shownStep`).

"That's too much", "I only have an hour", "exam week", "something smaller": the same step, same id, cut to its first items
that fit the minutes, done when those are, due soon. Finishing the small part brings the rest of it back. A step that is only offered is kept in its smaller form
(status `later`, not on the path): asked again, it is that step and no other.

A message in distress, or that only says how hard their life is (`isHardship`), gets no step when it asks nothing of the
work, and is never matched to a play by meaning. Anger at the work or at the advice ("this is useless", "ugh") does: every
other turn that coaches carries its step, in one word, in slang or in broken English; only social turns, thanks, closings,
crisis and role-play have none.

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
what they asked is `standing`: said once, last, as what stands ("On your path, next is: …"), never as a "Next:" of theirs.
A typed reply always has it; a call does not say it twice in a row (`quiet`). A step given for an earlier ask that is not on
their path is not carried to another subject: the path's own step stands there.

## What the server says, and what the model says

The model writes only a natural answer. Everything that must be exact is code's, in the same words on a streamed and a
whole reply (`packages/ai` `validators/reply-contract.ts`, `sentence-gate.ts`):

- **The lead** (`PromptGuidance.lead`, `turn.ts` `leadOf`) opens the reply before the model has written anything, so it costs
  no time to the first word: a sum, what news or a report shows (what they found first, then how far it gets them), "is that
  good?", where they stand ("get me organized", as a numbered list when they ask for a plan), a recall, the story, a change
  of direction, a choice the record decides, the message they asked for, when a step is done. Said once: what the model says
  of it again (its figures, the stage, a second plan, its dates) goes, and a lead said a moment ago is cut to the next blank
  or part. No stage is told to someone who did not ask where they stand. Also leads: an either-or or a yes-or-no on what a
  person decides (what can be said and by when, never the ruling: `holdsAnswer`), "do I need one now?" by their stage, what a
  finding means for what they build (`readMeaning`), a doubter's doubt of a pick, a no, "is it worth my hours?", "what did you
  tell me to do?", how the others seem to do, friends' praise.
- **One reading** (`validators/second-reading.ts`): under a lead that read a result or worked a sum, the model's own reading of
  it ("What this shows is…") goes, as do a number it refuses, their message said back, and a question of something nobody
  told of. A market asked for in dollars is the sum with what they told in it, and the one number to get (`marketLead`).
- **Two things asked** (`parts`) are listed for the model to answer one after the other, and what they set ("10", "this
  month", "one evening": `limits`) is to be kept to; a part or a limit the reply leaves out is said from the play.
- **Nothing twice** (`validators/said-before.ts`): a sentence an earlier reply said, or this one above, is left out, typed and
  spoken; what the program has not said yet of the answer (`more`: its other sentences, the parts with how, the trap, the
  reason) stands in its place, with no second model call. A question asked for the first time after a statement its play had
  answered still opens with what answers it. The step line, a template, a working and who decides may come again.
- **One next thing.** The step acts on what the record or the answer picked (`pickedChannel`, `askWhyStep` after a weak
  result, the first test where nothing was tried, a pitch's own step while they ask on the way to it); a second next thing of
  the model's goes, and where the server gives the one thing to do (`orders`) the model gives none.
- **Read for them** (`reading.ts`). On a judgement (a real business? which money? what will the judges ask? which path?) the
  program's answer is made from the record: their best proof with its number and who, and the nearest thing nobody has shown
  that matters for this ask. A verdict on them ("tell me it is great", "is it a real business?", "would they pay?", "stop or
  go on?") is the lead, word for word and once; the rest is what the model is given to apply, with two to four facts of
  theirs (`PromptGuidance.facts`). A reply that says none of them gets what they have and lack from the server, always; one
  that says what they have gets what is missing (`prior.gap`). With nothing on record it says so, and what to find out first.
- **Whether a fee is right**: what an hour of it brings, and that buyers decide; no verdict before one has answered
  (`validators/own-facts.ts`).
- **The reply before, in other words** (`restate`: plain, shorter, deeper, for a doubter, another language, "what do you
  mean?"): answered from that reply, as short as it is; a rejection ("textbook nonsense") gets what stands on their facts.
- **The thing itself.** A conversation that opens with their idea holds its page, once and whole (`startLead`); so does one
  that asks to have it written out. Its lines are the server's alone (`PromptGuidance.template`): the model's, and what only
  announces them, go. One thing to do ("orders", "one thing", "what would you do?") is no page: the first part, or the ones
  a weak result came from. A reply that starts a step (get me organized, where do I begin, orders, what now, a plan) holds its
  template, with what they told in it and plain [brackets] for the rest (`startOf`); a table reads as lines.
- **A choice** (`choice.ts`, `PromptGuidance.choice`): the model is told exactly the options found and that the first sentence
  picks; `missing_pick` notes one that does not. Code picks only when the record plainly decides (6 of 20 against 11 of 60).
- **What they found** (`PromptGuidance.finding`) goes to the model in their words, to say what it means.
- **A push** on what a person decides, or on what is never shared, gets the answer once and then a short no and the next part
  (`pushAsk`); who decides is said once in a reply (`repeatsReferral`), with what to bring in the same sentence, and a
  ruling of the model's on it goes (`rulesOnIt`). A play's answer is given once: asked again, the parts of its step, one by
  one; a question after a statement it answered gets what was not said yet, with the way to do it.
- **The step line** ends it, once: `**Next:** <title> by <Weekday, Month D>. Done when <done when>.`, on a call "Your next
  step: … by Monday." (a step due today: "today"). Whatever step, deadline, "Next:", done-when or list of the step's parts
  the model writes is left out as a whole block; an answer of fewer than about twelve words left over is the program's own.
- **The one question** is last: a number the calculator lacks (`askBack`), else the model's own.
- **The first part** of the step answers "how do I do that?", with its template filled in from their words (`howTo`,
  `fillTemplate`): what they did not tell keeps its [brackets].
- **One prior fact** (`prior`, `tell.ts` `priorFact`): the confirmed memory, report or sentence of theirs that shares most
  with the ask or bears on the same thing, and tells a number, a name, a decision or an outcome; else the idea, where the
  answer is for it; else none. Never advice of a course, a plan, a label, or a doing with nothing found. The model weaves it
  in; a typed reply that did not gets one sentence, said as a person says it, never of what the coach said in its last
  reply, of what this message takes back, or of an order in a message. An inference ("X are potential customers"), a template,
  another person's or a day counted from when it was told is none. With only their idea the sentence is the first part of the
  step, for it; never a line that puts the idea beside the answer.
- **Length.** A typed answer of the model's own ends at about 110 words, less beside a long lead; a list begun is finished,
  and what they asked to have written is as long as it is (`overTyped`).
- **Their facts only** (`said`, `validators/own-facts.ts`): a line of a template that says more than they did keeps its
  bracket; a sentence that gives them customers, sales, money or other people's words nobody told goes; so do our words ("the
  playbook says"). A cited sentence holds what its source, they or the record say, as strictly as the lab reads it
  (`citable`, `heldBy`); a message or a letter of the step's that nobody asked for is the card's (`template: 'shown'`).
- **Business words** are told in ten words or fewer, once, to who has not said they know them (`validators/glossary.ts`).
- **Sums** are worked out by code, never by the model, in two ways:
  - `calc.ts` (numbers and their roles: `calc-read.ts`) opens the reply when it is **sure**: every role is said beside its
    number, nothing in the same words is left unplaced, and the words can be read one way only. A fee they pay is a cost, what
    others charge is nobody's price, money spent in one go is not what one costs, and an amount told with no role, a change
    ("raise it by 2") or another currency means it says nothing. Below zero is told only when price and costs are both
    explicit. It covers what one leaves (several costs, a share taken), so many less a fixed cost, a month, break-even, an
    hour, a quarter hour, shares and churn, the same share again, two groups compared, what a customer cost, the price that
    keeps a share, a price raised or cut with both prices known (`price-change.ts`: the share of buyers it must keep), what it takes to start, payback, runway, and follow-ups ("and if I do sixty a week?"). With one number
    missing and nothing that could be it, that number is the question.
  - Otherwise (`PromptGuidance.asksSum`) the model writes the sum as a **marker**, `[[a - b dollars]]`, and never its result
    (`packages/ai` `validators/sums.ts`). The gate works it out and says it: "a - b = c dollars", on a call "a minus b, so c
    dollars". Its numbers must be theirs, the record's, the evidence's or a result said before (months, weeks, percent may
    multiply and divide), and its units must fit; else its clause goes, as an ungrounded figure's does. A marker that cannot
    be read never reaches the founder. What is stored is what was shown.
  - A sum the model works out itself all the same ("a minus b leaves c") is checked: a wrong result is put right when its
    numbers are theirs and it reads one way, else it goes; nothing after it builds on the wrong one.
  - A figure the model works out in plain words from given numbers it shows (`validators/worked.ts`: a share of an amount, an amount
    over a percentage, up to three numbers in a row, "90k", "$0.6 million") is no invented one and stays; where a sum was asked, so
    does one in the shape of a sum of theirs, and the figure is the whole answer. One that nothing given comes to goes, and a sum
    nobody could work out asks for its amounts, never the step's parts.
- **The method** (`validators/method.ts`): a sentence of the model's that contradicts what the programme teaches, or reads
  more into a fact than it shows, is put right or left out, unit by unit as it streams and again in the whole reply. A
  question about the future to ask someone ("How much would you pay?") becomes the programme's own about the past (a fixed
  table by kind); a survey as the next thing, a pass line on what people say, sign-ups or a few payments as "proof" or
  "demand", praise, sentences that say nothing, empty brackets, and a question they just answered go. A sentence that warns
  of these says the same words and stays: the rules read who proves what, denied or not, only if or to. Ten or more payments
  told may be read as demand (who paid, never how many were asked). A price set above the workaround or by what people say,
  and a verdict on a price that its numbers cannot carry, go. A draft in quotes is theirs to say. The whole playbook and the shared knowledge base pass it (`path/method.test.ts`). When nothing
  is left, the program's answer, or a reading of the news (`newsFallback`), stands.
- **Beside a lead**: under a sum code worked out, a number that is neither theirs, the sum's nor given this turn is a second
  sum nobody checked, and goes (`besideTheSum`); so do another count of the same whole, the template or the message the lead
  holds, their own words back, and a plan of the model's own ("Next, let's …") with what leans on it.
- **How a fact is read** (`READING_LINES`): on news, a judgement asked for (`PromptGuidance.judgement`: the plays of
  `JUDGEMENT_PLAYS`, "is that good?", "what am I missing?") and an ask nothing answers, the turn's part of the prompt says
  what a reading holds: what the fact shows, what it does not, another explanation, what would change the mind, one verdict.
  Every other turn pays nothing for it.
- **Understand first** (`orchestrator/understand.ts`, `CORE_UNDERSTAND`, off): a short structured call may read the message against
  the record before the path decides; code keeps what it can check (docs/architecture/understand.md).
- **Reasoning first** (`orchestrator/think.ts`, `CORE_THINK=off|judgement|typed`, off): Nova 2 may reason at low effort
  before a typed reply that judges something, or before every typed coaching reply; never on a call, a recall, a social turn
  or a crisis. The lead and the card are shown before it starts. docs/runbooks/latency.md, "Reasoning before a reply".
- **News** (`news.ts`, kind `news`): who paid and who did not, a result against the pass line they set, what people said,
  what stops them, a no and its reason, someone who asks for it, a spending limit, someone who left, an offer, sign-ups and
  the ones who forgot. A sign-up, a spoken yes, a friend's money and boxes sold are never called paying strangers. Something
  that happened and no rule reads is still news, with the finding for the model to read.
- **After a whole answer of the model's own** (its pick in other words, about them, or the line to say) the program's is not
  put (`saysAnswer`); what a person decides, and what is never shared, stays in the program's words.
- **On a call** no list of questions is read out, what was heard badly is put right (`heard.ts`), and a short fact of theirs
  is said.
- **Counts** (`counts.ts`) are the number that did it ("two of the other four" is two) or nothing: an approximation, a rate, a
  plan, a denial is not counted. A number taken back ("seven, not ten") is the number from then on, and what it had reached
  is open again.

## Resting on a reading

With a checked reading of the message (`PathTurnInput.understanding`, docs/architecture/understand.md) the turn rests on it;
without one, or with one that says nothing, every decision, prompt and reply is the same to the byte. A reading is set aside on
a crisis, a rehearsal, a social turn, and a wellbeing or conflict risk. What a report, a commitment or a pivot writes is never
the reading's. A message that is only about how they feel has no step; one that also asks something of the work is answered
although it is in distress (`contractApplies`).

**The reading fills gaps; it overrides no rule that read the message precisely** (`turn.ts` `firedRule`, the `answer` rows of
`PRECEDENCE`). The turn is decided without the reading first. Where a specific rule fired (counts or a refusal read as news, a result,
their report or a step not done, a commitment, a smaller step, a change of direction or back, the record, the calculator, the reply
said again, a message to send, a lead that answers one ask: if no, worth, needed, told, meaning, compares, convince, the pick, holds),
the whole turn is that one: opening, step, prompt and model, to the byte. A general answer (a play's paragraph by a phrase, the whole
path, a page to fill in, a step withheld) stands unless the reading holds what it lacks: an asked figure, a pick, a result, a denial,
who decides, another ask. A rule that counted friends, no customers or a denied growth as proof gives way. Added to a rule's turn: who
decides, where the ask is that decision, and a figure asked beside a recall or a report. With no rule, or one that is only near by
words or meaning, the reading decides, by the table below. The rule's name is logged (`turn.path` `rule`).
A rule that read the message as another kind of thing gives way too (`misreads`): news, a report, a result, a text of the program's
or a smaller step, where the reading is of words to send beside news, of how they feel, of made-up work, or of a complaint read as a
result. A text of the program's asked with no news, and a choice read as news, stay the rule's.

**Who decides** where the rules and the reading disagree is one table, `understood.ts` `PRECEDENCE`; the first row that holds
decides, and each row is a test.

| What     | The rules decide when                                                                                                                                                        | The reading decides when                                              | Otherwise                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------- |
| kind     | their own report, commitment or smaller ask; a change of direction, another idea; something done with the conversation (said again, the template, when it is enough, a plan) | any other message                                                     |                              |
| recall   | a phrase asks for the record and the reading finds no sum, pick, result or contradiction in it                                                                               | it reads a recall                                                     | the reading                  |
| play     | a referral's phrase; what is never shared; a push on either; a report, change or operation; a phrase, when the reading is not sure of another                                | it is sure of a play; it names one, or who decides, and no phrase did | the rules (meaning, or none) |
| step     | a report, change or operation; a referral's phrase or what is never shared; a recall                                                                                         | it names the step, a play or who decides                              | the step they are on         |
| referral | the rules find one                                                                                                                                                           | the rules find none                                                   | none (never taken away)      |
| sum      | both come to the same figure (the calculator's words); the reading has none and the calculator is sure                                                                       | it works out what they ask                                            | what is missing              |
| choice   | both name the same option (their counts say why); the reading picks none                                                                                                     | it picks                                                              | none                         |
| lead     | a report, change or operation; the record's own shapes (story, which idea, has and has not)                                                                                  | any other message                                                     |                              |

- **What of it may be said** (`settled`). A claim that speaks of the mentor, the founder, the reading or the record by its key goes; a
  line of the program's, or that they are new to it, is no fact of theirs. What a person decides (a split of shares, a visa, who
  owns it, terms, signing, the form of the company) is nobody's pick: the choice goes and who decides is found. A pick is one of
  the things they named, never a step's title, and only where they choose; what would change it is kept when one can see it happen.
  A letter that tells them to stop brings a lawyer, with the letter. Any field may be empty.
- **A figure they ask for** is worked out whatever else holds (`asked-sums.ts`): what an offer makes the whole come to, how many cover
  a cost, where their own words hold every number one way only; arithmetic is no ruling, so it opens and who decides follows. Where
  nobody worked it out no verdict opens, the model writes it as a marker, and a conclusion of its own goes. The figure said of the
  same thing before stands beside the new one, "earn or lose?" is answered with the word, and what a number was before they took it
  back is not said.
- **A verdict** is read of an outcome alone (`outcome.ts`): what somebody did, said or paid, a count, a test, a refusal, told now or
  before and asked about. An idea, a plan, a step not done or the time they have has none. Praise asked for is no push.
- **The words themselves** (a recap, a wording, so many lines): the writer's, with nothing added but the step; a line of the record they
  took back since is not given.
- **A part that came late** (no verdict, no claims): what the rules read of it, else its counts (`told-counts.ts`), is a claim of the
  reply.
- **A line of the record** is said as a whole sentence to them or not at all (`lint.ts`).
- **The step** is the reading's when the path allows it and its title (or the play's name) shares a subject with what they ask and
  what it is answered with (`fitsAsk`); who decides comes before anything else. An either-or that is not about money has a small
  test of the pick, named for it; handing it over the hand-over page; "may I stop?" the choice with its evidence; a deliverable of
  a class its own day. It is offered beside an open step, which is never replaced in storage by a reading, and not given when the
  open one is about the same thing, or when they only ask for a figure of their own. A result has the play that reads it or tests what
  it leaves open; a letter that tells them to stop has a lawyer's read of it; after talks come more of them, never a page of the stage
  before; who wants to go on alone has the talk first. A step that is not about the ask only stands
  ("On your path, next is:"), as does one that asks for money against a pick not to.
- **The writer writes the whole reply** (`renderGuidance`, `PromptGuidance.reading`): what they ask, the claims, the result, the pick, what
  their record denies, each with what would settle or turn it, as notes; the answer first, then what it rests on, then what would change
  it, then the step. The server opens only with an asked figure and its working, what nobody here rules on (ownership, terms, a visa,
  regulation, shares), integrity, other teams' privacy and a crisis (`openings.ts`).
- **Code checks it and replaces nothing** (`validators/whole-reply.ts`, `reading.ts`, the gate's whole path). A sentence goes when it is
  false (against a figure's sign or size, says something is what a claim says it is not, agrees with what their record denies, a sum nobody
  worked out, a number or source nobody gave), rules on what a person decides, offers friends as proof, speaks of how the turn was
  prepared, was said in this reply already, or leans on a sentence that went. No rule of style cuts anything.
- **A whole reply** has two sentences that say something (one for a yes or no, a sum, or the words they asked for) and no start that
  points at what went. The first is shown once the second is there. Else the writer writes it again, once, with each sentence cut and why
  (`repairBrief`), within `REPAIR_BUDGET_MS` (typed 2.5 s, call 1.2 s), checked the same way; late, failed or unfit, it is completed from
  the claims (`composedWhole`). An asked figure, who decides and a denial are added when the reply has none of them (`missingOf`).
  `turn.phase_a` logs `cuts`, `repair`, `repairMs`, `repairWhy` and `step`: codes and milliseconds, never words.
- **What they asked opens the reply.** A yes or no ("do we send?", "… right?", "… or not") is said first, with the reason from their
  facts (`reading.yesNo`); "you must decide" or "it depends" goes. Words they ask for (a message, what to say, a sign, a text to send;
  `asksForText`, or a reading of a draft) are the reply: in quotes or as lines of their own, first, shown once the quote is closed, and
  nothing in them is cut but what is false or unsafe, after which they are written again whole. Made-up work (testimonials, reviews,
  interviews nobody gave; `asksToMakeUp`) is integrity, and words for it are never written.
- **A figure cut as false** (no figure of theirs, nobody worked it out, against code's) leaves no scraps: where they asked for a
  figure and code shows none, the reply is written again with code's figure or, with none, what it needs; late, it says it will not
  guess (`NO_GUESS`). An amount they said in words ("forty eight") is theirs in digits.
- **The fitted step** (`validators/fitted-step.ts`). The writer ends with `NEXT: <what to do> | DONE: <what shows it is done>`, or
  `NEXT: same`. It is never shown. The method, its parts, the trap, the open step and the hours they have are in its notes
  (`PromptGuidance.fit`). Code keeps it when it is one thing to do, in their reach, of their words: no figure, name or date nobody gave, not
  what they refused or have done, no ruling, no made-up work. The day is code's, before a meeting or deadline they named. Kept, it is the
  step of the turn (`fitTurn`) and of its stored row, title and done-when, with the play's parts; asked next, it is said as it is stored.
  Their own step is never displaced by it. Not kept, the step is the play's. The step follows the news they bring (a deal, an
  offer, a deadline, a call, a complaint, a refusal, a limit); `same` only where the open step still serves what they ask, and it is
  the one thing the reply tells them to do. A reply that came whole without the line has that line asked for alone, once, within
  `STEP_ASK_BUDGET_MS` (typed 1.5 s, call 1 s); `turn.phase_a` logs `stepAsk` and `stepAskMs`. A stored step asked about again with no news stands as stored,
  in a fresh session too, whatever the writer fits.
- **The writer's manner** (`validators/model-style.ts`, held the same whichever model writes): a stage direction
  ("_leans back_") is not said, and a reply wrapped in quotation marks after one is the mentor's own; a done-check of its own beside
  the step's reads "it is usually enough when"; inside words to send a day of its own is "[day]" and the founder introduces
  themself ("This is …"); an example figure or a made-up value of a sum goes; "any form you signed" is "you may have signed";
  "48 hours" of its own is "two days". Words in quotes are held until they close, and shown whole or, when a sentence of them
  went, not at all; a question in them stays in them. A step of the writer's own in the body ("The next move is …", "Next, …", "The smallest thing
  is …") goes beside the step line; "Next step:" is the step line only in capitals, with its DONE, or as the last line. Under a
  change of direction, "the step hasn't changed" and a first step of its own go. A day of its own goes before a dash too. A
  recall says the change of direction once (a record line that says it again is not added), and a step moved to a new day says
  that day alone. An announcement ("Here's what to do today:") with only a paragraph after
  it goes. A stop for length, in any model's word for it, is a cut reply.
- **Another business they run** ("the pottery is a separate business"; `other-business.ts`) is never the venture's: its facts are not
  kept as the venture's notes and not listed as what the venture has.
- **Who decides** is said once in a conversation, and again only where the new ask is that decision (`toldEnough`).

## Without a reading

The same to the byte, but for what is never right: a verdict and nothing else ("Good price.") goes; a claim of growth their record
denies is named first and nothing agrees with it; money offered for a part of the company, in any words (`offersForShares`), has who
decides, what can be said and no verdict (and the figure it implies where that is asked); telling or showing an invention is never called safe;
a sentence that says nothing where it stands goes; a line as a call heard it is no fact; a fact is put beside an answer only as a sentence of its own that bears on the ask; the
prompt's line for who decides is never said; a question that only asks how they will do the step goes.

## Rules the code keeps

- **One id per step.** A step's id is derived (venture, play, origin, how often the play was closed): known before it is
  stored, the same in every conversation; two turns that give it at once insert one row.
- **Stage.** The furthest of: the stage the path reached, every stage whose criteria are all claimed or met, and the
  program's: before the path has begun when the record holds work of its own (seeded, imported, from before), afterwards
  only when the program set another one than it had then (`venture_paths.program_stage`, migration 0037). The first turn that
  gives a step, offered or not, begins the path and fixes its start; nothing noted later moves it. It goes back in one case
  only: a change of direction, which also takes the program's stage of its day.
- **What the mentor kept by itself** (origin `ai`, approved or corrected by nobody) is no work of the venture's: it counts for
  a criterion only when its own sentence says it happened, with more than the idea again, and no plan in it.
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
  when, what was reported, which idea they are on, what the venture has and has not; the open step and its day end the reply
  as on every turn (one whose day passed has a new day, and "It was due ..."); the story is dated lines after the idea it opens with, each thing once, at most eight, a change of direction with what brought it. A
  change of direction wins over a report or a missed day, keeps the new idea, dates the old one in the arc
  (`venture_paths.pivots`, their words), ends a step of theirs that was about the old one, and opens what the old customer
  had shown, from talking to customers on (their words stay on the criterion, dated). Going back to an earlier idea (the
  first, the one before, or one by its words) restores what that one had shown and keeps the other's as dated words.
- **Who decides.** A referral intent wins over every other ask; a risk the classifier found leads to its play when no
  phrase names one, or brings who decides beside another answer; something said in passing (`note`: "my advisor is on the
  paper") brings it too; a push ("you decide", "what do I take") keeps it. An escalation keeps the model's own next step.
- **No round trip of its own**, but for an ask no rule names ("By meaning"). A turn's path reads are part of its context
  statement (`turn-context.ts`); the decision is pure; writes run beside the turn's own, only when something changed.
- **Who sees what.** `venture_paths`, `path_steps`, `path_criteria` (migrations 0033, 0035, 0036): read by founders, team and the
  assigned EIR, written by founders and team. Program leads read `app.path_overview` (no words). Deleting a conversation
  erases the words it left (evidence, the idea said in it, a change of it, a step in the founder's own words) and its
  turns' guidance. A temporary chat writes nothing.
- **Kill switch.** `CORE_FOUNDER_PATH=off` runs turns without the path.
