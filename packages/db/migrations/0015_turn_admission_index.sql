-- Foundry Ascent — an index for the per-person turn limits (docs/runbooks/latency.md). Expand-only and
-- re-runnable: nothing an older build reads or writes changes.
--
-- Every typed message is admitted after counting its author's recent messages and those still being answered
-- (turnsRepo.countRecentTurnsByAuthor, countPendingTurnsByAuthor: the message limit runs in the preflight and
-- again in the admission transaction, under the person's admission lock). No index led with the author, so
-- both counts walked the turns of the recent past across every venture and applied row-level security to each
-- (0.65 ms at 200,000 turns, growing with the table); with the author first they read only that person's
-- recent turns (0.02 ms). turns_author_voice_idx (0004) stays for the spoken-turn limit it serves.

CREATE INDEX IF NOT EXISTS turns_author_created_idx ON turns (author_id, created_at);
