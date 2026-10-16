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
import { memoryRepo, type SqlExecutor } from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { embedMemoryBestEffort, type EmbeddableMemory } from '../internal/embeddings.js';
import { audit, requireId, type Kit } from '../internal/kit.js';
import { toMemoryView } from '../internal/views.js';
import {
  addsNothingTo,
  isCoachEcho,
  MEMORY_DUPLICATE_COSINE,
  sameMemoryContent,
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
    readonly title: string;
    readonly content: string;
    readonly embedding: readonly number[] | null;
  },
  existing: readonly memoryRepo.MemoryRecord[],
  conversation: CandidateConversation | undefined,
): Promise<memoryRepo.MemoryRecord | null> {
  const lexical = existing.find((e) => sameMemoryContent(e.content, candidate.content));
  if (lexical !== undefined) return lexical;
  if (conversation !== undefined) {
    const restated = existing.find(
      (e) =>
        learnedFrom(e, conversation.sourceIds) &&
        addsNothingTo(candidate.content, e.content, conversation.speakers),
    );
    if (restated !== undefined) return restated;
  }
  if (candidate.embedding === null) return null;
  const [nearest] = await memoryRepo.nearestMemory(tx, { ventureId, embedding: candidate.embedding });
  if (nearest === undefined || nearest.similarity < MEMORY_DUPLICATE_COSINE) return null;
  return existing.find((e) => e.id === nearest.id) ?? (await memoryRepo.getMemory(tx, nearest.id)) ?? null;
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
 * A candidate that is only the coach's own advice or framing (nothing of it comes from the founder or advice they
 * agreed to, and it cites none of the venture's records: {@link isCoachEcho}) is never kept as a fact about the
 * venture.
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
  },
): Promise<ProposalResult> {
  const usable = args.candidates.filter((c) => c.title.trim() !== '');
  if (usable.length === 0) return { records: [], created: 0, repeated: 0, dropped: 0 };
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
  for (const [index, candidate] of args.candidates.entries()) {
    const title = candidate.title.trim().slice(0, 200);
    const content = candidate.content.trim().slice(0, 8000);
    if (title === '') continue;
    const keys = [...new Set(candidate.evidence_ids)].filter((k) => args.evidence.has(k));
    if (
      args.grounding !== undefined &&
      isCoachEcho({ title, content }, args.grounding, {
        speakers: args.conversation?.speakers ?? [],
        cited: keys.length > 0,
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
    const embedding = args.embeddings?.[index] ?? null;
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
    existing.unshift(record);
    created += 1;
  }
  return { records, created, repeated, dropped };
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
