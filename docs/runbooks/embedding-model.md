# Changing the embedding model

Retrieval compares vectors of one model only. This is how the platform moves to another embedding model **online**: no
downtime, no migration (the vector columns and their index stay `vector(1024)`), every row keeps a vector throughout, and
each row is compared with the query embedded by its own model.

**Who:** a platform admin with deploy rights. **Cost:** one pass over the stored text (chunks and memory), metered in
the usage ledger under `embedding` and stopped by the daily cap and the kill switch like any embedding call.

## What must be true first

- The new model gives **1024** dimensions (Titan Text V2, Cohere Embed v4 and Nova multimodal embeddings can; another size
  needs a migration and is out of scope here).
- The gateway can call it (`packages/ai/src/gateway`), and the Lambda roles may invoke it **and** the old one until the
  end.
- It has a row in `PLAY_MATCH_PROFILES` (`packages/core/src/path/semantic.ts`), from the models benchmark's "Plays by
  meaning": without one, asks no phrase names are matched to a play only by plainly nearest words.
- It has floors in `EMBEDDING_PROFILES` (`packages/db/src/repositories/retrieval.ts`): see "How retrieval is tuned" below.
  Cosine similarities of two models are not comparable: 0.3 can be "related" for one and noise for another. A model
  without a profile gets a strict default (fewer, never wrong, passages). **The profiles of Titan and Cohere in the code
  are starting values**, to be replaced with what the models benchmark prints; Nova's similarity does not tell a question
  with an answer from one without (AUC 0.26), so its vector alone admits nothing.

## Steps

1. **Look.** `SELECT embedding_model, count(*) FROM knowledge_chunks WHERE embedding IS NOT NULL GROUP BY 1;` and the same
   for `memory_objects` (or `knowledgeRepo.countEmbeddingModels`). Null: embedded before migration 0034.
2. **Switch.** Deploy with `MODEL_EMBEDDINGS_ID` the new model and, on the API function, `MODEL_EMBEDDINGS_PREVIOUS_ID` the
   old one. New text is embedded by the new model at once; each query is embedded by both (two small calls at the same
   time), and each stored row is compared with its own. Without the previous id the change still works: rows not yet
   re-embedded are found by their words and topics only until step 3 is done.
3. **Re-embed.** Send the worker's queue `{"type":"reembed_embeddings","previous":"<old model id>"}`. The job records the
   old model on rows that do not say, then replaces vectors in batches (`maxItems`, default 1,000 a run, within the
   Lambda's time). Its log line `worker.reembed_done` says `remaining`: send the message again until it is `false`. It can
   be interrupted anywhere. `stoppedBy: model_mismatch` means the gateway answered with a model id other than
   `MODEL_EMBEDDINGS_ID` (an inference profile's id): use that id in both places.
4. **Verify.** Step 1 again: one model. Ask a few known questions and look at the evidence.
5. **Finish.** Deploy without `MODEL_EMBEDDINGS_PREVIOUS_ID` and drop the old model's permission.

**Roll back** at any point before step 5: swap the two ids, deploy, and send the job with `previous` the other way round.

While rows of both models exist, no play may be chosen by meaning (the plays' asks are compared only when all of them have
a vector of the same model, the new one or the one named as previous): the phrases and plainly nearest words choose until step 3 is done.

While rows of both models exist, the meaning-based duplicate check of kept memory (`memory.ts`) compares only within a
venture's rows as stored: a duplicate kept under the old model may not be recognised until step 3 is done. The daily
maintenance checks again.

## How retrieval is tuned

Every constant is in `packages/db/src/repositories/retrieval.ts`, and nowhere else: `RETRIEVAL_FUSION` (the order),
`RETRIEVAL_FLOORS` and `EMBEDDING_PROFILES` (what is about the message at all), `SEMANTIC_ADMISSION` (which shared notes no
gate names a turn is shown). The pin of a play's cited note is
`PIN_FLOOR` (`knowledge-pack/corpus.ts`); how much of each kind a turn shows is `DEFAULT_CORE_CONFIG.retrieval` and
`EXCERPT_WINDOW_CHARS` in `packages/core`.

1. **The order.** The vector leads (weight 3); words break near ties (0.25); they count for more (1.5) only for a row whose
   title says a thing the message names by name (`namedTermGroups`: patent, LLC, SAFE, I-Corps, a capstone…). Equal
   weights were measured to lose a third of the first-place answers (Titan, 2026-11-24: 50 % for the vector alone, 31 %
   fused equally). Weights are chosen from the models benchmark's fusion table, on a real embedding model.
2. **The floors.** `floor`: a passage is about the message by its vector alone; `weak`: together with shared words. Take them
   from the benchmark's calibration line and floor table: `suggested` keeps three quarters of the answers, `strict` lets a
   tenth of unanswerable questions through. Prefer precision: a passage shown is a passage cited, and the play, the
   founder's record and the words (topics, named things) still bring what the vector alone does not. Set the pair, run
   `pnpm --filter @foundry/core test:db -- retrieval-eval`, and check the next benchmark's `current` rows.
3. **Words.** Outside the founder's own record words admit a passage only when one of them says what the message is about:
   a word every venture uses ("idea", "campus", "customer") never does alone. A resource or a lesson must also hold such a
   word in its title or tags.
4. **What a play brings.** Its method is the first item; of the sources it cites, the one note that is about the play itself
   (or none: a cited unit is not evidence for a sentence it does not support).

5. **Semantic admission** (`SEMANTIC_ADMISSION`, `EmbeddingProfile.admit`, `admitSemantic`). The gates (topics, vocabulary,
   strong word coverage) showed the answer for 15 to 24 % of paraphrased questions where the whole corpus held it for 67 %.
   So a coaching turn that asks something (core `asksOf`: never a social, crisis, rehearsal or recall turn, never "get me
   organized") also reads the shared notes near the founder's **own words**: an exact scan of the tenant's course notes,
   curriculum, open library and reference library, in the search's own statement. A note is shown when its similarity is
   at least the model's `admit` (plus `guard` for a message that only may ask) and `relative` of the nearest note's, at most
   `limit` a turn (`voiceLimit` on a call) and while the turn has fewer than `room` notes in all; one reference-library
   item a turn, a passage about the course only as the nearest of all, a source that was evidence in the conversation or
   gives another note of the turn only as the nearest. The gates' notes are unchanged but for one rule: the corpus's own
   vector rule (the search query's vector at `floor`, `openRelative` of the nearest) is replaced by this one. A model
   without `admit` admits none. Nothing is embedded for it: the search's vector is the founder's own words' unless the
   query added to them, then the vector the plays were compared with, else no note is read.
   **Choosing the constants**: the benchmark's "admission" rows (conversation lab runbook). Take the highest "answer
   shown" among the rows whose "no answer, nothing shown" is at least the gates' alone and whose precision is not below it
   by more than you would show a founder; prefer a lower limit at equal recall. Set `admit`, `relative`, `limit`, and the
   next run's "code's constants" row must say the same. `CORE_SEMANTIC_NOTES=off` turns it off (the gates alone, exactly
   as before).
6. **The reranker** (optional, off). `MODEL_RERANK_ID` (`amazon.rerank-v1:0`) and `MODEL_RERANK_REGION` (default
   `us-west-2`) give the gateway one, and `CORE_RERANK=on` uses it on typed turns, never on calls: it reads the nearest
   eight notes (from `weak`) and admits by its own score (`rerankScore`, from the benchmark's `keep_…` rows) instead of by
   similarity. It is waited for 600 ms (`RERANK_TIMEOUT_MS`), then the similarity decides; it is billed USD 0.001 a turn and
   metered under `embedding`, so the daily caps count it. Before turning it on, the API's role needs
   `bedrock:InvokeModel` on the model in that Region (only the lab's role has it).

Not tuned on: `retrieval-eval.db.test.ts`. Its embedding is a hash of words, so it measures how words are read and is
biased against a ranking led by the vector; it guards admission, precision and "no evidence", not the weights.

## Measuring retrieval

- `packages/core/src/orchestrator/retrieval-eval.db.test.ts` (runs with every `test:db`): 216 labelled student questions,
  56 of which nothing answers, over the seeded shared knowledge with a deterministic embedding. It prints recall,
  precision and the no-answer rate beside what main did before, and fails under its floors.
  `RETRIEVAL_EVAL_VERBOSE=1` lists the misses of the half the floors were tuned on (`all`: every one).
- The embedding models themselves are compared by the retrieval benchmark (conversation lab, "Models benchmark").
