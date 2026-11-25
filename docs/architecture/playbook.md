# The founder playbook

What a student founder hears from Thomas about method: which answer, which steps, what counts as done, who must decide.
It is data (`packages/core/src/path/playbook/`), the same for every founder. The path engine picks from it; the model
explains what was picked and never invents a step, a figure or a source.

| File               | Holds                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `index.ts`         | `PLAYBOOK: Playbook` and `PLAYBOOK_VERSION` (raise it with any change; it is kept with each venture path)  |
| `stages.ts`        | the seven `VentureStage`s with a title and goal in a student's words                                       |
| `criteria.ts`      | 2 to 4 criteria per stage, each tied to one play of its stage; the three Ain capstones are criteria        |
| `plays/<stage>.ts` | 114 plays: answer, why, 3 to 5 steps, done when, days, template, traps, referral, citations, next          |
| `intents.ts`       | one intent per play, 8 to 40 phrases; `referral` wins, `note` only brings who decides, `overview`, `holds` |
| `sources.ts`       | the reading list the citations resolve to                                                                  |
| `make.ts`          | small helpers (`step`, `cite`, `ain`, `REFERRALS`)                                                         |
| `test-fixtures.ts` | the asks of `playbook.test.ts` and `turns.test.ts`, in our own words; not shipped                          |

## How a play is written

- **Answer first.** A pick or a decision rule, second person, plain words, short sentences, read aloud (no signs, lists
  or links). Never "it depends" without the rule, never a question, never "before we". No flattery: "tell me my idea is
  great" gets a strength, a weak spot and the test.
- **Steps for a busy student.** Two to five, in the imperative, with how and minutes; the whole play fits in `days`.
- **Counts are the programme's operating targets** ("aim for 10"), said as targets and never as statistics. No price,
  percentage, market figure or legal threshold, unless it comes from a cited government page (today: the patent play's
  one-year clock and 12 months, from the USPTO). Formulas use letters and the founder's own numbers.
- **Templates** leave the founder's details in `[brackets]`.
- **Referral** when a qualified person must decide: the answer gives orientation, says who decides and what to bring.
  Referral-required intents: who owns lab work, patents, biotech and medical rules, regulated data, visas, valuation,
  term sheets, money from family or a crowd, equity split, founder agreement, legal structure, contracts and insurance,
  taxes, food and campus permits. Other plays carry a referral without being forced (pilot, letter of intent, hiring,
  grants or investors, leaving the Ain Center).
- **Citations** name the reading list, the programme by module and unit, or a government page. The plays paraphrase.
  No text of a book or of the programme's videos is stored, and presenters are not named.

## Where the sources were checked (2026-11-24)

| Source                                                                                                                      | Contents read on                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Ain Foundry, Modules 1 to 3                                                                                                 | the programme's own transcripts (not stored); curriculum titles: `curriculum.ts`        |
| The Mom Test                                                                                                                | author's site; chapter list on readingraphics.com                                       |
| Competing Against Luck                                                                                                      | publisher description; contents on the Everand product page                             |
| The Innovator's Solution                                                                                                    | library contents page (toc.uni.li)                                                      |
| The Innovator's Dilemma, Business Model Generation, The Lean Startup, The Founder's Dilemmas, Traction, The Art of Strategy | Open Library records (contents note)                                                    |
| Testing Business Ideas                                                                                                      | University of Wisconsin library catalogue (contents note)                               |
| Disciplined Entrepreneurship                                                                                                | O'Reilly listing and a public list of the 24 steps                                      |
| The Startup Owner's Manual (Wiley 2020 numbering)                                                                           | Wiley sample and O'Reilly chapter pages                                                 |
| Venture Deals (4th edition)                                                                                                 | Wiley contents page                                                                     |
| High Growth Handbook                                                                                                        | author's site (growth.eladgil.com)                                                      |
| The Cold Start Problem                                                                                                      | NeoDB record (contents)                                                                 |
| Lean Analytics                                                                                                              | O'Reilly listing                                                                        |
| Crossing the Chasm (3rd edition)                                                                                            | public listings of the contents                                                         |
| Obviously Awesome                                                                                                           | contents not found on a public page: cited as a whole (`locator: null`)                 |
| Entrepreneurship (OpenStax)                                                                                                 | openstax.org (chapter titles only; the page states CC BY-NC-SA, so nothing is ingested) |
| SBA, USPTO, FDA, IRS, SEC, USCIS, DHS, FTC, HHS, ED, SBIR, NSF, Monroe County                                               | the agencies' pages                                                                     |
| UR Ventures (the technology transfer office), ISO, OHSP, UCC, Ain Center                                                    | rochester.edu                                                                           |

In copy, "UR Ventures" is the University of Rochester's technology transfer office; its intellectual property policy
covers undergraduate and graduate students.

## Tests (`playbook.test.ts`)

- Contract: every play, criterion and source parses; ids are unique; every reference resolves; every criterion is made
  by a play of its stage that lists it; every source is cited; every stage is reachable from the first play.
- Voice: banned words, ASCII, answer first, reads aloud, sentence length, Flesch-Kincaid grade 8 or lower per answer,
  imperative steps, checkable endings, bracketed templates.
- Nothing invented: no money, percentage or statistic; legal terms in numbers need a government citation; programme
  citations name the module, unit and topic, never who recorded it.
- Referrals: valid category and role; a referral intent leads to a play that hands over.
- Intents (`match.ts`): each phrase answers its own play; the evaluation's 20 questions (but the recall), its protocol and
  the live test's messages (in our own words, never the client's) are named by a phrase or a rule, whatever an embedding
  says; near-misses are not. What no phrase names is for meaning to say (measured on real embeddings by the models
  benchmark, never here). Without it (`near: 'unavailable'`) the phrases, risks and plainly nearest words answer about 60
  percent of 231 paraphrases, 50 of 346 short asks and 30 of `HELD_OUT_ASKS`, and at most 2 percent of any wrongly; of the
  asks that need a person all but two are told who. Recall asks ("what did I say my idea was?") and small talk are the
  engine's own turn kinds, not intents. Whole turns are in `turns.test.ts`.

A play's title is the name of a step ("Next: …"), so it is an instruction.

To add a play: write it in its stage's file, add an intent under the same id with 8 or more phrases, add two asks to
`test-fixtures.ts`, raise `PLAYBOOK_VERSION`, run `pnpm --filter @foundry/core exec vitest run src/path`.
A play's title, the first sentence of its answer and its intent's phrases are also what an ask is compared with by
meaning (docs/architecture/founder-path.md, "By meaning"): the next deploy stores and embeds what changed. Never copy an
ask of `path/play-benchmark/` into a phrase: those measure the matching and are kept apart (a test checks).
