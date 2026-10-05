import {
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
import { embedMemoryBestEffort } from '../internal/embeddings.js';
import { audit, requireId, type Kit } from '../internal/kit.js';
import { toMemoryView } from '../internal/views.js';

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
  /** Correction history across all versions (read). */
  history(ctx: RequestContext, memoryId: string): Promise<MemoryEventViewValue[]>;
}

/** Where a memory candidate came from (stored as its first source ref). */
export interface CandidateSource {
  readonly kind: 'turn' | 'session';
  readonly id: string;
}

/** Evidence shown to the model, by key, used to turn candidate evidence ids into source refs. */
export type EvidenceIndex = ReadonlyMap<
  string,
  { readonly kind: string; readonly refId: string; readonly title: string }
>;

/**
 * Persists AI memory candidates as `proposed` items (never auto-confirmed; DB constraint backs this),
 * origin `ai`, with `visibility` until a founder approves (and optionally widens) them: `team` normally,
 * `founder_private` when they came from a turn or session that used founder_private evidence
 * (`candidateVisibility`), so they cannot restate a private item to the team. Evidence ids that are not
 * in the turn's evidence pack are ignored.
 */
export async function persistMemoryCandidates(
  tx: SqlExecutor,
  args: {
    readonly tenantId: string;
    readonly ventureId: string;
    readonly createdBy: string;
    readonly candidates: readonly MemoryCandidate[];
    readonly evidence: EvidenceIndex;
    readonly source: CandidateSource;
    readonly visibility: 'founder_private' | 'team';
  },
): Promise<memoryRepo.MemoryRecord[]> {
  const created: memoryRepo.MemoryRecord[] = [];
  for (const candidate of args.candidates) {
    const title = candidate.title.trim().slice(0, 200);
    const content = candidate.content.trim().slice(0, 8000);
    if (title === '') continue;
    const keys = [...new Set(candidate.evidence_ids)].filter((k) => args.evidence.has(k));
    const refs: SourceRef[] = [{ kind: args.source.kind, id: args.source.id, label: 'AI proposal' }];
    for (const key of keys) {
      const item = args.evidence.get(key);
      if (!item) continue;
      if (item.kind === 'memory') refs.push({ kind: 'memory', id: item.refId, label: key });
      else if (item.kind === 'chunk') refs.push({ kind: 'chunk', id: item.refId, label: key });
    }
    created.push(
      await memoryRepo.createMemory(tx, {
        tenantId: args.tenantId,
        ventureId: args.ventureId,
        type: candidate.type,
        title,
        content,
        status: 'proposed',
        visibility: args.visibility,
        confidence: Number.isFinite(candidate.confidence)
          ? Math.min(1, Math.max(0, candidate.confidence))
          : 0.5,
        origin: 'ai',
        createdBy: args.createdBy,
        sourceRefs: refs,
        attributes: { evidence_keys: keys },
      }),
    );
  }
  return created;
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
