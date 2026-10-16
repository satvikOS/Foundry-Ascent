import {
  BatchMemoryActionRequest,
  type BatchMemoryActionResponse,
  CreateMemoryRequest,
  MEMORY_LIST_EXCERPT_CHARS,
  MemoryAction,
  MemoryQuery,
  type MemoryCandidate,
  type MemoryEventView,
  type MemoryObjectView,
  type SourceRef,
} from '@foundry/contracts';
import { knowledgeRepo, memoryRepo, settingsRepo, turnsRepo, type SqlExecutor } from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { embedMemoryBestEffort, memoryEmbeddingText, type EmbeddableMemory } from '../internal/embeddings.js';
import { meteredEmbed } from '../internal/metered.js';
import { audit, requireId, type Kit } from '../internal/kit.js';
import { toMemoryView } from '../internal/views.js';
import {
  addsNothingTo,
  conversationGrounding,
  forgottenPrintOf,
  founderSaid,
  isCoachEcho,
  matchesForgotten,
  MEMORY_DUPLICATE_COSINE,
  sameMemoryContent,
  sameNumbers,
  type ConversationGrounding,
} from './memory-dedupe.js';

type MemoryEventViewValue = z.infer<typeof MemoryEventView>;

/** One page of a memory list (contract `MemoryListResponse`). */
export interface MemoryPage {
  readonly items: MemoryObjectView[];
  readonly nextCursor: string | null;
}

/** Default memory list page size. */
export const MEMORY_PAGE_DEFAULT = 50;

export interface MemoryService {
  /**
   * One page of venture memory with filters / full-text search (read; RLS applies per-item visibility).
   * Items carry an excerpt of their content (`contentLength` is the full length): pages stay far below the
   * RDS Data API's 1 MB limit. {@link MemoryService.get} returns a full item.
   */
  list(ctx: RequestContext, ventureId: string, query?: z.input<typeof MemoryQuery>): Promise<MemoryPage>;
  /** One item with its full content (read; RLS applies per-item visibility). */
  get(ctx: RequestContext, memoryId: string): Promise<MemoryObjectView>;
  /**
   * Founder/team: creates a `confirmed` item with origin `founder`. Assigned EIR: creates a `proposed`
   * item with origin `eir` (visibility venture/advisors only). Others: forbidden.
   */
  create(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof CreateMemoryRequest>,
  ): Promise<MemoryObjectView>;
  /**
   * approve / reject / correct (new superseding version, history kept) / dispute / pin / unpin /
   * delete (soft: content erased for every version). Founder or team only. Returns the resulting item
   * (the new version for `correct`) or null after `delete`.
   */
  act(
    ctx: RequestContext,
    memoryId: string,
    action: z.input<typeof MemoryAction>,
  ): Promise<MemoryObjectView | null>;
  /**
   * Approves or rejects several pending proposals of one venture at once (founder/team, the "To review"
   * queue), with the same authorization and audit as single actions. Ids that are not pending proposals of
   * this venture visible to the caller are reported in `skippedIds`; the others change.
   */
  batch(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof BatchMemoryActionRequest>,
  ): Promise<BatchMemoryActionResponse>;
  /** Correction history across all versions (read). */
  history(ctx: RequestContext, memoryId: string): Promise<MemoryEventViewValue[]>;
}

/**
 * Where a memory candidate came from: a turn (with its conversation) or a conversation. Stored as the first
 * source refs: the conversation first, so the item names what it was learned from.
 */
export type CandidateSource =
  | { readonly kind: 'turn'; readonly id: string; readonly sessionId: string }
  | { readonly kind: 'session'; readonly id: string };

/** Label of the source ref naming the conversation an AI item was learned from. */
export const LEARNED_FROM_LABEL = 'Learned from the conversation';

/** Evidence shown to the model, by key, used to turn candidate evidence ids into source refs. */
export type EvidenceIndex = ReadonlyMap<
  string,
  { readonly kind: string; readonly refId: string; readonly title: string }
>;

/** Venture items a new AI candidate is compared against (most recent first, content cut to an excerpt). */
const DEDUPE_SCAN_LIMIT = 200;
const DEDUPE_EXCERPT_CHARS = 1_000;

/** What happened to a batch of AI memory candidates. */
export interface ProposalResult {
  /** New items plus the AI items raised again: what the vEIR remembered from these candidates. */
  readonly records: memoryRepo.MemoryRecord[];
  /** The new items alone (what {@link settleKeptMemory} settles by meaning after a turn). */
  readonly createdRecords: memoryRepo.MemoryRecord[];
  readonly created: number;
  /** Candidates that repeated AI memory nobody approved or corrected, which got the new source instead. */
  readonly repeated: number;
  /**
   * Candidates that restated an item a person made, approved or rejected, or that were only the coach's own
   * advice ({@link isCoachEcho}).
   */
  readonly dropped: number;
}

/** The conversation candidates are drawn from: its id and its turns' ids, and who spoke in it. */
export interface CandidateConversation {
  readonly sourceIds: ReadonlySet<string>;
  /** Names the founder goes by in it (a candidate may name them where a turn said "I"). */
  readonly speakers: readonly string[];
}

/**
 * AI memory nobody approved or corrected: a pending proposal, or an item the vEIR kept by itself. A candidate
 * that restates one raises it again (new source) instead of becoming a duplicate.
 */
function unreviewedAi(item: memoryRepo.MemoryRecord): boolean {
  return (
    item.origin === 'ai' &&
    (item.status === 'proposed' ||
      (item.status === 'confirmed' && item.keptAutomatically && item.approvedBy === null))
  );
}

/** Whether an item is AI memory nobody reviewed, drawn from one of `sources` (a conversation and its turns). */
function learnedFrom(item: memoryRepo.MemoryRecord, sources: ReadonlySet<string>): boolean {
  return (
    unreviewedAi(item) &&
    item.sourceRefs.some((r) => (r.kind === 'turn' || r.kind === 'session') && sources.has(r.id))
  );
}

/**
 * The existing item a candidate restates: lexically ({@link sameMemoryContent}); AI memory of the same
 * conversation the candidate adds nothing to ({@link addsNothingTo}, when `conversation` is given); or else,
 * when the candidate has an embedding, the closest embedded item at {@link MEMORY_DUPLICATE_COSINE} or above.
 * Null when it is new.
 */
async function findDuplicate(
  tx: SqlExecutor,
  ventureId: string,
  candidate: {
    readonly id?: string;
    readonly title: string;
    readonly content: string;
    readonly embedding: readonly number[] | null;
  },
  existing: readonly memoryRepo.MemoryRecord[],
  conversation: CandidateConversation | undefined,
): Promise<memoryRepo.MemoryRecord | null> {
  const others = existing.filter((e) => e.id !== candidate.id);
  const lexical = others.find((e) => sameMemoryContent(e.content, candidate.content));
  if (lexical !== undefined) return lexical;
  if (conversation !== undefined) {
    const restated = others.find(
      (e) =>
        learnedFrom(e, conversation.sourceIds) &&
        addsNothingTo(candidate.content, e.content, conversation.speakers),
    );
    if (restated !== undefined) return restated;
  }
  if (candidate.embedding === null) return null;
  const near = await memoryRepo.nearestMemory(tx, { ventureId, embedding: candidate.embedding, limit: 3 });
  for (const hit of near) {
    if (hit.similarity < MEMORY_DUPLICATE_COSINE) break;
    if (hit.id === candidate.id) continue;
    const item = others.find((e) => e.id === hit.id) ?? (await memoryRepo.getMemory(tx, hit.id));
    // Embeddings barely see numbers: "capped at $500" and "capped at $700" are different facts.
    if (
      item !== null &&
      sameNumbers(`${item.title} ${item.content}`, `${candidate.title} ${candidate.content}`)
    )
      return item;
  }
  return null;
}

/**
 * Keeps AI memory candidates (owner decision 2026-10-16: what a conversation teaches goes to memory by itself,
 * without an "add to memory" step). Each new candidate becomes an item of origin `ai` that is kept
 * automatically: `confirmed` with no approver and `auto_kept_at` (migration 0013), so the founder and their team
 * see it in Knowledge at once and can correct, dispute or delete it like any item. Its source refs name the
 * conversation it was learned from (and the turn, for a turn's candidates), so deleting that conversation
 * erases it. `visibility` is `team` normally, `founder_private` when it came from a turn or session that used
 * founder_private evidence (`candidateVisibility`), so it never restates a private item to the team. Evidence
 * ids that are not in the evidence pack are ignored. Callers write nothing for a temporary chat.
 *
 * A candidate that is only the coach's own advice or framing ({@link isCoachEcho}: the model's `source` label,
 * checked against what the founder said and explicitly agreed to) is never kept as a fact about the venture, and
 * neither is anything the founder made the vEIR forget ({@link matchesForgotten}): forgetting an item is never
 * undone by the next distillation of the conversation it came from.
 *
 * Hygiene before every insert: a candidate that restates AI memory nobody approved or corrected (an item kept
 * automatically, or a pending proposal from before) of the same visibility adds its source to that item
 * instead of a duplicate; one that restates anything else the venture has (an item a person made, approved,
 * corrected or disputed, or something a person rejected) is dropped. Comparison is lexical against the
 * venture's recent items (`existing`, read here when not given), by containment against the AI memory of the
 * same conversation (`conversation`), and by cosine similarity when `embeddings` (one per candidate,
 * unit-length) are given; new items store their embedding.
 */
export async function proposeMemoryCandidates(
  tx: SqlExecutor,
  args: {
    readonly tenantId: string;
    readonly ventureId: string;
    readonly createdBy: string;
    readonly candidates: readonly MemoryCandidate[];
    readonly evidence: EvidenceIndex;
    readonly source: CandidateSource;
    readonly visibility: 'founder_private' | 'team';
    readonly existing?: readonly memoryRepo.MemoryRecord[];
    readonly embeddings?: readonly (readonly number[] | null)[];
    readonly conversation?: CandidateConversation;
    /** What was said where the candidates come from (the founder's words and the coach's). */
    readonly grounding?: ConversationGrounding;
    /**
     * What the founder made the vEIR forget in this venture (`memoryRepo.listForgottenMemory`): a candidate that
     * matches one is never kept again ({@link matchesForgotten}).
     */
    readonly forgotten: readonly memoryRepo.ForgottenMemory[];
  },
): Promise<ProposalResult> {
  const usable = args.candidates.filter((c) => c.title.trim() !== '');
  if (usable.length === 0) return { records: [], createdRecords: [], created: 0, repeated: 0, dropped: 0 };
  const existing = [
    ...(args.existing ??
      (await memoryRepo.listMemory(tx, {
        ventureId: args.ventureId,
        statuses: memoryRepo.DEDUPE_MEMORY_STATUSES,
        limit: DEDUPE_SCAN_LIMIT,
        excerptChars: DEDUPE_EXCERPT_CHARS,
      }))),
  ];
  const records: memoryRepo.MemoryRecord[] = [];
  const createdRecords: memoryRepo.MemoryRecord[] = [];
  let created = 0;
  let repeated = 0;
  let dropped = 0;
  const conversationRefs: SourceRef[] =
    args.source.kind === 'turn'
      ? [
          { kind: 'session', id: args.source.sessionId, label: LEARNED_FROM_LABEL },
          { kind: 'turn', id: args.source.id },
        ]
      : [{ kind: 'session', id: args.source.id, label: LEARNED_FROM_LABEL }];
  const conversationId = args.source.kind === 'turn' ? args.source.sessionId : args.source.id;
  for (const [index, candidate] of args.candidates.entries()) {
    const title = candidate.title.trim().slice(0, 200);
    const content = candidate.content.trim().slice(0, 8000);
    if (title === '') continue;
    const keys = [...new Set(candidate.evidence_ids)].filter((k) => args.evidence.has(k));
    const embedding = args.embeddings?.[index] ?? null;
    if (
      (args.grounding !== undefined &&
        isCoachEcho({ title, content }, args.grounding, {
          speakers: args.conversation?.speakers ?? [],
          source: candidate.source ?? null,
        })) ||
      matchesForgotten({ type: candidate.type, title, content }, embedding, conversationId, args.forgotten, {
        saidAgain:
          args.grounding !== undefined &&
          founderSaid({ title, content }, args.grounding, args.conversation?.speakers ?? []),
      })
    ) {
      dropped += 1;
      continue;
    }
    const refs: SourceRef[] = [...conversationRefs];
    for (const key of keys) {
      const item = args.evidence.get(key);
      if (!item) continue;
      if (item.kind === 'memory') refs.push({ kind: 'memory', id: item.refId, label: key });
      else if (item.kind === 'chunk') refs.push({ kind: 'chunk', id: item.refId, label: key });
    }
    const confidence = Number.isFinite(candidate.confidence)
      ? Math.min(1, Math.max(0, candidate.confidence))
      : 0.5;
    const duplicate = await findDuplicate(
      tx,
      args.ventureId,
      { title, content, embedding },
      existing,
      args.conversation,
    );
    if (duplicate !== null) {
      const again =
        unreviewedAi(duplicate) &&
        duplicate.visibility === args.visibility &&
        !records.some((r) => r.id === duplicate.id)
          ? await memoryRepo.repeatProposal(tx, {
              memoryId: duplicate.id,
              actorId: args.createdBy,
              sourceRefs: refs,
              confidence,
            })
          : null;
      if (again === null) {
        dropped += 1;
      } else {
        records.push(again);
        repeated += 1;
      }
      continue;
    }
    const record = await memoryRepo.createMemory(tx, {
      tenantId: args.tenantId,
      ventureId: args.ventureId,
      type: candidate.type,
      title,
      content,
      keptAutomatically: true,
      visibility: args.visibility,
      confidence,
      origin: 'ai',
      createdBy: args.createdBy,
      sourceRefs: refs,
      attributes: { evidence_keys: keys },
      embedding,
    });
    records.push(record);
    createdRecords.push(record);
    existing.unshift(record);
    created += 1;
  }
  return { records, createdRecords, created, repeated, dropped };
}

/**
 * {@link proposeMemoryCandidates} for callers that only need what was remembered (turns and recaps): the new
 * items and the AI items raised again.
 */
export async function persistMemoryCandidates(
  tx: SqlExecutor,
  args: Parameters<typeof proposeMemoryCandidates>[1],
): Promise<memoryRepo.MemoryRecord[]> {
  return (await proposeMemoryCandidates(tx, args)).records;
}

/** What settling a turn's kept memory by meaning did (counts only). */
export interface SettleResult {
  readonly embedded: number;
  /** Items that restated another item: their source went to that item instead. */
  readonly merged: number;
  /** Items that were something the founder made the vEIR forget. */
  readonly forgotten: number;
}

/**
 * Settles by meaning what a turn just kept (owner decision 2026-10-16: the turn's reply never waits for this, so
 * it runs after the turn completed). A turn keeps its candidates at once, checked lexically; here they are
 * embedded (one metered call) and, in one transaction: an item that is something the founder made the vEIR forget
 * is taken back; one that restates another item by meaning ({@link MEMORY_DUPLICATE_COSINE}, same numbers) is
 * taken back too, its conversation added to that item when it is AI memory nobody reviewed; every other item keeps
 * its vector, so "do you remember…" finds it by meaning. Best effort: on any failure (or with AI switched off)
 * the items stay as kept, and the embedding backfill and the next distillation catch up. Never throws; logs
 * counts only.
 */
export async function settleKeptMemory(
  kit: Kit,
  ctx: RequestContext,
  args: {
    readonly ventureId: string;
    /** The conversation the items were learned from. */
    readonly sessionId: string;
    readonly items: readonly memoryRepo.MemoryRecord[];
    /** What was said in it (whether the founder said an item again after making the vEIR forget it). */
    readonly grounding?: ConversationGrounding;
  },
): Promise<SettleResult> {
  const none: SettleResult = { embedded: 0, merged: 0, forgotten: 0 };
  const items = args.items.filter((m) => m.keptAutomatically && !m.hasEmbedding && m.status === 'confirmed');
  if (items.length === 0) return none;
  try {
    const settings = await kit.inRequest(ctx, ({ tx }) => settingsRepo.getPlatformSettings(tx));
    if (!settings.aiEnabled) return none;
    const embedded = await meteredEmbed(
      kit,
      { ctx, ventureId: args.ventureId, purpose: 'embedding' },
      items.map(memoryEmbeddingText),
    );
    return await kit.inRequest(ctx, async ({ tx }) => {
      const forgotten = await memoryRepo.listForgottenMemory(tx, { ventureId: args.ventureId });
      let done = 0;
      let merged = 0;
      let forgot = 0;
      for (const [i, item] of items.entries()) {
        const vector = embedded.vectors[i];
        if (vector?.length !== knowledgeRepo.EMBEDDING_DIMENSIONS) continue;
        const saidAgain = args.grounding !== undefined && founderSaid(item, args.grounding);
        if (matchesForgotten(item, vector, args.sessionId, forgotten, { saidAgain })) {
          if (await memoryRepo.discardKeptMemory(tx, { memoryId: item.id, reason: 'forgotten' })) forgot += 1;
          continue;
        }
        const duplicate = await findDuplicate(
          tx,
          args.ventureId,
          { id: item.id, title: item.title, content: item.content, embedding: vector },
          [],
          undefined,
        );
        if (duplicate !== null) {
          if (unreviewedAi(duplicate) && duplicate.visibility === item.visibility) {
            await memoryRepo.repeatProposal(tx, {
              memoryId: duplicate.id,
              actorId: ctx.principalId,
              sourceRefs: item.sourceRefs.filter((r) => r.kind === 'session' || r.kind === 'turn'),
              confidence: item.confidence,
            });
          }
          if (
            await memoryRepo.discardKeptMemory(tx, {
              memoryId: item.id,
              reason: 'duplicate',
              intoId: duplicate.id,
            })
          ) {
            merged += 1;
          }
          continue;
        }
        await knowledgeRepo.setMemoryEmbeddings(tx, [{ id: item.id, embedding: vector }]);
        done += 1;
      }
      return { embedded: done, merged, forgotten: forgot };
    });
  } catch (err) {
    kit.deps.logger.warn('memory.settle_deferred', {
      requestId: ctx.requestId,
      items: items.length,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return none;
  }
}

/** What settling the proposals left from before automatic memory did (counts only). */
export interface PendingSettleResult {
  readonly kept: number;
  /** Retired because they restated another item (their conversations went to that item when it was AI memory). */
  readonly duplicates: number;
  /** Retired because they were only the coach's advice, or something the founder made the vEIR forget. */
  readonly notTheFounders: number;
}

/** Turns of a proposal's conversations read to judge where it came from. */
const PENDING_GROUNDING_CONVERSATIONS = 3;

/**
 * Settles the AI memory proposals left from before automatic memory (migration 0013 leaves them pending; owner
 * role, the daily maintenance): each, oldest first, goes through the checks new memory goes through. One that is
 * only the coach's advice ({@link isCoachEcho}, judged against the conversations it was drawn from) or something
 * the founder made the vEIR forget is retired; one that restates an item the venture has (lexically, or by its
 * stored embedding at {@link MEMORY_DUPLICATE_COSINE} with the same numbers) is retired and its conversations go to
 * that item when it is AI memory nobody reviewed; every other one is kept automatically, as new memory is. Older
 * proposals are settled first, so of two that say the same the older is kept. At most `limit` per run.
 */
export async function settlePendingAiProposals(
  kit: Kit,
  args: { readonly limit?: number } = {},
): Promise<PendingSettleResult> {
  return kit.system(async (sx) => {
    const pending = await memoryRepo.listPendingAiProposals(sx, { limit: args.limit ?? 200 });
    let kept = 0;
    let duplicates = 0;
    let notTheFounders = 0;
    const ventures = new Map<string, memoryRepo.PendingAiProposal[]>();
    for (const item of pending) ventures.set(item.ventureId, [...(ventures.get(item.ventureId) ?? []), item]);
    for (const [ventureId, items] of ventures) {
      const known = await memoryRepo.listMemory(sx, {
        ventureId,
        statuses: ['confirmed', 'disputed', 'rejected', 'superseded'],
        limit: DEDUPE_SCAN_LIMIT,
        excerptChars: DEDUPE_EXCERPT_CHARS,
      });
      const forgotten = await memoryRepo.listForgottenMemory(sx, { ventureId, system: true });
      const groundings = new Map<string, ConversationGrounding>();
      const groundingOf = async (sessionId: string): Promise<ConversationGrounding> => {
        const cached = groundings.get(sessionId);
        if (cached !== undefined) return cached;
        const turns = (await turnsRepo.listTurns(sx, sessionId)).filter(
          (t) => t.status === 'completed' && t.riskLabel !== 'crisis',
        );
        const grounding = conversationGrounding(
          turns.map((t) => ({ founder: t.founderText, answer: t.response?.answer ?? null })),
        );
        groundings.set(sessionId, grounding);
        return grounding;
      };
      for (const item of items) {
        const conversations = item.conversationIds.slice(0, PENDING_GROUNDING_CONVERSATIONS);
        const parts = await Promise.all(conversations.map(groundingOf));
        const grounding: ConversationGrounding = {
          founder: parts.flatMap((g) => g.founder),
          agreed: parts.flatMap((g) => g.agreed),
        };
        const embedding = item.hasEmbedding ? await memoryRepo.getMemoryEmbedding(sx, item.id) : null;
        const echo = conversations.length > 0 && isCoachEcho(item, grounding);
        const forgot = matchesForgotten(item, embedding, conversations[0] ?? '', forgotten, {
          saidAgain: conversations.length > 0 && founderSaid(item, grounding),
        });
        if (echo || forgot) {
          if (
            await memoryRepo.settlePendingAiProposal(sx, {
              memoryId: item.id,
              outcome: 'expire',
              reason: echo ? 'coach_advice' : 'forgotten',
            })
          )
            notTheFounders += 1;
          continue;
        }
        let duplicate =
          known.find((e) => e.id !== item.id && sameMemoryContent(e.content, item.content)) ?? null;
        if (duplicate === null && item.hasEmbedding) {
          for (const hit of await memoryRepo.nearestToMemory(sx, {
            memoryId: item.id,
            ventureId,
            statuses: ['confirmed', 'disputed', 'rejected', 'superseded'],
          })) {
            if (hit.similarity < MEMORY_DUPLICATE_COSINE) break;
            const other = known.find((e) => e.id === hit.id) ?? (await memoryRepo.getMemory(sx, hit.id));
            if (
              other !== null &&
              sameNumbers(`${other.title} ${other.content}`, `${item.title} ${item.content}`)
            ) {
              duplicate = other;
              break;
            }
          }
        }
        if (duplicate !== null) {
          if (unreviewedAi(duplicate) && duplicate.visibility === item.visibility) {
            await memoryRepo.repeatProposal(sx, {
              memoryId: duplicate.id,
              actorId: item.createdBy,
              sourceRefs: item.sourceRefs.filter((r) => r.kind === 'session' || r.kind === 'turn'),
              confidence: 0,
            });
          }
          if (
            await memoryRepo.settlePendingAiProposal(sx, {
              memoryId: item.id,
              outcome: 'expire',
              reason: 'duplicate',
            })
          )
            duplicates += 1;
          continue;
        }
        if (
          await memoryRepo.settlePendingAiProposal(sx, {
            memoryId: item.id,
            outcome: 'keep',
            reason: memoryRepo.KEPT_AUTOMATICALLY,
          })
        ) {
          kept += 1;
          const now = await memoryRepo.getMemory(sx, item.id);
          if (now !== null) known.unshift(now);
        }
      }
    }
    return { kept, duplicates, notTheFounders };
  });
}

/**
 * Records what the founder makes the vEIR forget before `current` is deleted (every version) or corrected (the
 * version they corrected away from), when it was learned from a conversation: hashes and a meaning signature per
 * conversation (`memory_forgotten`), never text, so the next distillation of that conversation never keeps it again.
 */
async function rememberForgetting(
  tx: SqlExecutor,
  current: memoryRepo.MemoryRecord,
  reason: 'deleted' | 'corrected',
): Promise<void> {
  if (!current.sourceRefs.some((r) => r.kind === 'session' || r.kind === 'turn')) return;
  const versions = await memoryRepo.listMemoryVersions(tx, current.id);
  const chosen = reason === 'deleted' ? versions : versions.filter((v) => v.id === current.id);
  await memoryRepo.recordForgottenMemory(tx, {
    memoryId: current.id,
    reason,
    fingerprints: chosen.map((v) => forgottenPrintOf(v, v.embedding)),
  });
}

const ACTION_EVENTS = {
  approve: 'memory.approved',
  reject: 'memory.rejected',
  correct: 'memory.corrected',
  dispute: 'memory.disputed',
  pin: 'memory.pinned',
  unpin: 'memory.unpinned',
  delete: 'memory.deleted',
} as const;

const ACTION_PAST = {
  approve: 'approved',
  reject: 'rejected',
  correct: 'corrected',
  dispute: 'disputed',
  pin: 'pinned',
  unpin: 'unpinned',
} as const;

export function createMemoryService(kit: Kit): MemoryService {
  return {
    list: async (ctx, rawVentureId, rawQuery = {}) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const query = parseInput(MemoryQuery, rawQuery);
      const limit = query.limit ?? MEMORY_PAGE_DEFAULT;
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'read');
        // One extra row tells whether another page exists.
        const rows = await memoryRepo.listMemory(scope.tx, {
          ventureId,
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.q === undefined || query.q === '' ? {} : { q: query.q }),
          ...(query.pinned === undefined ? {} : { pinned: query.pinned }),
          limit: limit + 1,
          offset,
          excerptChars: MEMORY_LIST_EXCERPT_CHARS,
        });
        return {
          items: rows.slice(0, limit).map(toMemoryView),
          nextCursor: rows.length > limit ? String(offset + limit) : null,
        };
      });
    },

    get: async (ctx, rawMemoryId) => {
      const memoryId = requireId(rawMemoryId, 'Memory item');
      return await kit.inRequest(ctx, async (scope) => {
        const item = await memoryRepo.getMemory(scope.tx, memoryId);
        if (item === null) throw fail.notFound('Memory item');
        await requireVentureAccess(scope, item.ventureId, 'read', {
          objectType: 'memory',
          objectId: memoryId,
        });
        return toMemoryView(item);
      });
    },

    create: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(CreateMemoryRequest, rawInput);
      const created = await kit.inRequest(ctx, async (scope) => {
        const decision = await requireVentureAccess(scope, ventureId, 'read');
        let record: memoryRepo.MemoryRecord;
        if (decision.canWrite) {
          record = await memoryRepo.createMemory(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId,
            type: input.type,
            title: input.title,
            content: input.content,
            attributes: input.attributes,
            status: 'confirmed',
            visibility: input.visibility,
            confidence: 1,
            sourceRefs: input.sourceRefs,
            origin: 'founder',
            createdBy: ctx.principalId,
            approvedBy: ctx.principalId,
          });
        } else if (decision.isAssignedEir) {
          if (input.visibility === 'founder_private' || input.visibility === 'team') {
            throw fail.validation('EIR proposals must be visible to the venture', [
              { path: 'visibility', message: 'Use "venture" or "advisors"' },
            ]);
          }
          record = await memoryRepo.createMemory(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId,
            type: input.type,
            title: input.title,
            content: input.content,
            attributes: input.attributes,
            status: 'proposed',
            visibility: input.visibility,
            confidence: 0.5,
            sourceRefs: input.sourceRefs,
            origin: 'eir',
            createdBy: ctx.principalId,
          });
        } else {
          scope.deferAudit({
            action: 'venture.access',
            outcome: 'denied',
            ventureId,
            objectType: 'memory',
            objectId: null,
            policyReason: `write:insufficient_relation:${decision.relation}`,
          });
          throw fail.forbidden(`insufficient_relation:${decision.relation}`);
        }
        await audit(scope, {
          action: 'memory.created',
          outcome: 'succeeded',
          ventureId,
          objectType: 'memory',
          objectId: record.id,
          metadata: {
            type: record.type,
            status: record.status,
            origin: record.origin,
            visibility: record.visibility,
          },
        });
        if (record.status === 'confirmed') {
          const item = { id: record.id, ventureId, title: record.title, content: record.content };
          scope.afterCommit(() => embedMemoryBestEffort(kit, ctx, [item]));
        }
        return record;
      });
      return toMemoryView(created);
    },

    act: async (ctx, rawMemoryId, rawAction) => {
      const memoryId = requireId(rawMemoryId, 'Memory item');
      const action = parseInput(MemoryAction, rawAction);
      return kit.inRequest(ctx, async (scope) => {
        const { tx } = scope;
        const current = await memoryRepo.getMemory(tx, memoryId);
        if (current === null) throw fail.notFound('Memory item');
        await requireVentureAccess(scope, current.ventureId, 'write', {
          objectType: 'memory',
          objectId: memoryId,
        });
        const actorId = ctx.principalId;
        let result: memoryRepo.MemoryRecord | null = null;
        let deletedVersions = 0;
        switch (action.action) {
          case 'approve':
            result = await memoryRepo.approveMemory(tx, { memoryId, actorId });
            break;
          case 'reject':
            result = await memoryRepo.rejectMemory(tx, { memoryId, actorId, reason: action.reason ?? null });
            break;
          case 'correct': {
            const patch = action.patch;
            if (Object.keys(patch).length === 0)
              throw fail.validation('A correction must change at least one field');
            // What the vEIR kept and the founder corrected is never kept again in its old words.
            if (current.origin === 'ai' && current.approvedBy === null)
              await rememberForgetting(tx, current, 'corrected');
            result = await memoryRepo.correctMemory(tx, {
              memoryId,
              actorId,
              patch,
              reason: action.reason ?? null,
            });
            break;
          }
          case 'dispute':
            result = await memoryRepo.disputeMemory(tx, { memoryId, actorId, reason: action.reason });
            break;
          case 'pin':
          case 'unpin':
            result = await memoryRepo.setMemoryPinned(tx, {
              memoryId,
              actorId,
              pinned: action.action === 'pin',
            });
            break;
          case 'delete':
            // Forgetting is durable: the next distillation of the conversation never keeps it again.
            await rememberForgetting(tx, current, 'deleted');
            deletedVersions = await memoryRepo.deleteMemory(tx, memoryId);
            if (deletedVersions === 0) throw fail.notFound('Memory item');
            break;
        }
        if (action.action !== 'delete' && result === null) {
          throw fail.conflict(
            `This memory item cannot be ${ACTION_PAST[action.action]} in its current state`,
            'invalid_transition',
          );
        }
        await audit(scope, {
          action: ACTION_EVENTS[action.action],
          outcome: 'succeeded',
          ventureId: current.ventureId,
          objectType: 'memory',
          objectId: result?.id ?? memoryId,
          metadata: {
            from: current.status,
            to: result?.status ?? 'deleted',
            version: result?.version ?? current.version,
            ...(action.action === 'correct'
              ? { supersedes: memoryId, fields: Object.keys(action.patch).sort() }
              : {}),
            ...(action.action === 'delete' ? { versions: deletedVersions } : {}),
          },
        });
        if (
          result &&
          (action.action === 'approve' || action.action === 'correct') &&
          result.status === 'confirmed'
        ) {
          const item = {
            id: result.id,
            ventureId: result.ventureId,
            title: result.title,
            content: result.content,
          };
          scope.afterCommit(() => embedMemoryBestEffort(kit, ctx, [item]));
        }
        return result ? toMemoryView(result) : null;
      });
    },

    batch: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(BatchMemoryActionRequest, rawInput);
      const ids = [...new Set(input.ids.map((id) => id.toLowerCase()))];
      return kit.inRequest(ctx, async (scope) => {
        const { tx } = scope;
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'memory' });
        const visible = new Map((await memoryRepo.getMemoryByIds(tx, ids)).map((m) => [m.id, m]));
        const items: MemoryObjectView[] = [];
        const skippedIds: string[] = [];
        const confirmed: EmbeddableMemory[] = [];
        for (const memoryId of ids) {
          const current = visible.get(memoryId);
          if (current?.ventureId !== ventureId || current.status !== 'proposed') {
            skippedIds.push(memoryId);
            continue;
          }
          const result =
            input.action === 'approve'
              ? await memoryRepo.approveMemory(tx, { memoryId, actorId: ctx.principalId })
              : await memoryRepo.rejectMemory(tx, { memoryId, actorId: ctx.principalId, reason: null });
          if (result === null) {
            skippedIds.push(memoryId);
            continue;
          }
          await audit(scope, {
            action: ACTION_EVENTS[input.action],
            outcome: 'succeeded',
            ventureId,
            objectType: 'memory',
            objectId: memoryId,
            metadata: { from: current.status, to: result.status, version: result.version, batch: true },
          });
          items.push(toMemoryView(result));
          if (result.status === 'confirmed') {
            confirmed.push({ id: result.id, ventureId, title: result.title, content: result.content });
          }
        }
        if (confirmed.length > 0) scope.afterCommit(() => embedMemoryBestEffort(kit, ctx, confirmed));
        return { items, skippedIds };
      });
    },

    history: async (ctx, rawMemoryId) => {
      const memoryId = requireId(rawMemoryId, 'Memory item');
      return await kit.inRequest(ctx, async (scope) => {
        const current = await memoryRepo.getMemory(scope.tx, memoryId);
        if (current === null) throw fail.notFound('Memory item');
        await requireVentureAccess(scope, current.ventureId, 'read', {
          objectType: 'memory',
          objectId: memoryId,
        });
        return memoryRepo.listMemoryHistory(scope.tx, memoryId);
      });
    },
  };
}
