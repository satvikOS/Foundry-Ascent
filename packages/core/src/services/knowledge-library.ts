import {
  CreateDocumentRequest,
  CreatePersonaKnowledgeRequest,
  type CreatePersonaUploadResponse,
  type PersonaKnowledgeSourceView,
  UpdatePersonaKnowledgeRequest,
} from '@foundry/contracts';
import { documentsRepo, eirRepo, knowledgeRepo, personasRepo, settingsRepo, usageRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { chunkText, normalizeExtractedText } from '../ingestion/chunker.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { spendCapExceeded } from '../orchestrator/guards.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { storageFilename } from './documents.js';

type CreateUploadResult = z.infer<typeof CreatePersonaUploadResponse>;

/**
 * A persona's knowledge library: the common pool every venture the persona coaches draws on (retrieved as
 * doctrine evidence for the assigned persona only). Curated by program leads and the EIR the persona is built
 * from; read by every EIR-studio role. Authored notes, cases, FAQs and transcripts are chunked when saved
 * (lexical retrieval works at once) and embedded after commit within the spend caps; uploaded documents go
 * through the ingestion worker like venture documents. The pool grows only through these people, approved
 * lessons and approved releases, never through raw venture text.
 */
export interface KnowledgeLibraryService {
  list(ctx: RequestContext, personaId: string): Promise<PersonaKnowledgeSourceView[]>;
  create(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof CreatePersonaKnowledgeRequest>,
  ): Promise<PersonaKnowledgeSourceView>;
  update(
    ctx: RequestContext,
    personaId: string,
    sourceId: string,
    input: z.input<typeof UpdatePersonaKnowledgeRequest>,
  ): Promise<PersonaKnowledgeSourceView>;
  /** Withdraws a source: its chunks leave retrieval at once (an uploaded file is deleted too). */
  remove(ctx: RequestContext, personaId: string, sourceId: string): Promise<void>;
  /** Registers a document upload (daily upload quota applies) and returns a presigned PUT. */
  createUpload(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof CreateDocumentRequest>,
  ): Promise<CreateUploadResult>;
  /** Marks the upload complete (or retries a failed one) and queues its ingestion. */
  completeUpload(
    ctx: RequestContext,
    personaId: string,
    sourceId: string,
  ): Promise<PersonaKnowledgeSourceView>;
}

const STUDIO_ROLES = ['eir', 'program_lead', 'platform_admin'] as const;

/** Object key of a persona library upload (under the documents bucket's `tenants/` prefix). */
export function personaSourceKey(args: {
  tenantId: string;
  personaId: string;
  sourceId: string;
  filename: string;
}): string {
  return `tenants/${args.tenantId}/personas/${args.personaId}/sources/${args.sourceId}/${storageFilename(args.filename)}`;
}

/** A short plain-text summary of authored Markdown: its first paragraph, cut at a word (≤ 280 characters). */
export function summarize(body: string): string | null {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/^#{1,6}\s+.*$/gm, '')
        .replace(/[*_`>#]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((p) => p.length >= 20);
  if (paragraph === undefined) return null;
  if (paragraph.length <= 280) return paragraph;
  return `${paragraph.slice(0, 279).replace(/\s+\S*$/, '')}…`;
}

export function createKnowledgeLibraryService(kit: Kit): KnowledgeLibraryService {
  const { objectStore, jobQueue, logger } = kit.deps;
  const cfg = kit.config.ingestion;

  async function loadPersona(scope: RequestScope, personaId: string): Promise<personasRepo.PersonaRecord> {
    const persona = await personasRepo.getPersona(scope.tx, personaId);
    if (persona?.tenantId !== scope.ctx.tenantId) throw fail.notFound('Persona');
    return persona;
  }

  /** Program lead, or the EIR the persona is built from (the same rule RLS applies to the corpus). */
  async function requireCurator(scope: RequestScope, personaId: string): Promise<personasRepo.PersonaRecord> {
    const persona = await loadPersona(scope, personaId);
    const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
    if (hasAnyRole(roles, ['program_lead'])) return persona;
    if (persona.eirProfileId !== null && hasAnyRole(roles, ['eir'])) {
      const profile = await eirRepo.getEirProfile(scope.tx, persona.eirProfileId);
      if (profile?.principalId === scope.ctx.principalId) return persona;
    }
    scope.deferAudit({
      action: 'authz.denied',
      outcome: 'denied',
      objectType: 'persona',
      objectId: personaId,
      policyReason: 'requires_persona_curator',
    });
    throw fail.forbidden(
      'requires_persona_curator',
      'Only program leads and this persona’s EIR curate its library',
    );
  }

  async function loadSource(
    scope: RequestScope,
    personaId: string,
    sourceId: string,
  ): Promise<knowledgeRepo.KnowledgeSourceRecord> {
    const source = await knowledgeRepo.getKnowledgeSource(scope.tx, sourceId);
    if (source?.scope !== 'persona' || source.personaId !== personaId || source.status === 'withdrawn') {
      throw fail.notFound('Knowledge source');
    }
    return source;
  }

  async function view(scope: RequestScope, sourceId: string): Promise<PersonaKnowledgeSourceView> {
    const result = await knowledgeRepo.getPersonaLibrarySource(scope.tx, sourceId);
    if (result === null) throw fail.notFound('Knowledge source');
    return result;
  }

  /** Chunks authored text (heading-aware, like documents) into the source; returns the chunk count. */
  async function storeChunks(
    scope: RequestScope,
    source: Pick<knowledgeRepo.KnowledgeSourceRecord, 'id' | 'tenantId' | 'personaId'>,
    title: string,
    body: string,
  ): Promise<number> {
    const { chunks } = chunkText(normalizeExtractedText(`# ${title}\n\n${body}`), {
      targetTokens: cfg.chunkTokens,
      overlapRatio: cfg.overlapRatio,
      maxChunks: cfg.maxChunks,
    });
    return knowledgeRepo.insertChunks(scope.tx, {
      sourceId: source.id,
      tenantId: source.tenantId,
      scope: 'persona',
      personaId: source.personaId,
      chunks: chunks.map((c) => ({
        ordinal: c.ordinal,
        heading: c.heading,
        content: c.content,
        tokenCount: c.tokenCount,
      })),
    });
  }

  /**
   * Embeds a source's chunks after commit, best effort: skipped when AI is off or a daily spend cap is reached
   * (the backfill embeds them later; lexical retrieval works meanwhile). Usage is attributed to the editor.
   */
  async function embedBestEffort(ctx: RequestContext, sourceId: string): Promise<void> {
    try {
      const { settings, texts, state } = await kit.system(
        async (sx) => ({
          settings: await settingsRepo.getPlatformSettings(sx),
          texts: await knowledgeRepo.listChunkTexts(sx, sourceId),
          state: {
            globalUsd: await usageRepo.spendToday(sx),
            principalUsd: await usageRepo.spendToday(sx, { principalId: ctx.principalId }),
          },
        }),
        { transaction: false },
      );
      if (!settings.aiEnabled || texts.length === 0 || spendCapExceeded(state, settings) !== null) return;
      for (let i = 0; i < texts.length; i += cfg.embedBatchSize) {
        const batch = texts.slice(i, i + cfg.embedBatchSize);
        const result = await kit.deps.gateway.embed(
          batch.map((t) => t.text),
          { purpose: 'embedding', requestId: ctx.requestId },
        );
        await kit.recordUsage({
          ctx,
          ventureId: null,
          purpose: 'embedding',
          attempts: [{ modelId: result.modelId, usage: result.usage, costUsd: result.costUsd }],
        });
        const vectors = batch.flatMap((chunk, j) => {
          const embedding = result.vectors[j];
          return embedding?.length === knowledgeRepo.EMBEDDING_DIMENSIONS
            ? [{ id: chunk.id, embedding }]
            : [];
        });
        if (vectors.length > 0) await kit.system((sx) => knowledgeRepo.setChunkEmbeddings(sx, vectors));
      }
    } catch (err) {
      logger.warn('knowledge.embedding_deferred', {
        requestId: ctx.requestId,
        sourceId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  return {
    list: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, STUDIO_ROLES, { objectType: 'persona', objectId: personaId });
        await loadPersona(scope, personaId);
        return knowledgeRepo.listPersonaLibrary(scope.tx, { personaId });
      });
    },

    create: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(CreatePersonaKnowledgeRequest, rawInput);
      const result = await kit.inRequest(ctx, async (scope) => {
        const persona = await requireCurator(scope, personaId);
        if (persona.status === 'retired') throw fail.conflict('The persona is retired', 'persona_retired');
        const source = await knowledgeRepo.createKnowledgeSource(scope.tx, {
          tenantId: ctx.tenantId,
          scope: 'persona',
          personaId,
          kind: input.kind,
          title: input.title,
          summary: summarize(input.body),
          body: input.body,
          classification: 'program_internal',
          createdBy: ctx.principalId,
        });
        const chunks = await storeChunks(scope, source, input.title, input.body);
        await audit(scope, {
          action: 'knowledge.source_created',
          outcome: 'succeeded',
          objectType: 'knowledge_source',
          objectId: source.id,
          metadata: { personaId, kind: input.kind, chunks },
        });
        scope.afterCommit(() => embedBestEffort(ctx, source.id));
        return source.id;
      });
      return kit.inRequest(ctx, (scope) => view(scope, result));
    },

    update: async (ctx, rawPersonaId, rawSourceId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const sourceId = requireId(rawSourceId, 'Knowledge source');
      const input = parseInput(UpdatePersonaKnowledgeRequest, rawInput);
      const rechunked = await kit.inRequest(ctx, async (scope) => {
        await requireCurator(scope, personaId);
        const source = await loadSource(scope, personaId, sourceId);
        if (source.kind === 'document' && input.body !== undefined) {
          throw fail.validation('An uploaded document’s text cannot be edited; upload a new version', [
            { path: 'body', message: 'Not editable for documents' },
          ]);
        }
        const title = input.title ?? source.title;
        const body = input.body ?? source.body;
        const textChanged =
          source.kind !== 'document' && (input.body !== undefined || input.title !== undefined);
        await knowledgeRepo.updateKnowledgeSource(scope.tx, sourceId, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body, summary: summarize(input.body) }),
        });
        let chunks: number | null = null;
        if (textChanged && body !== null) {
          await knowledgeRepo.deleteChunksForSource(scope.tx, sourceId);
          chunks = await storeChunks(scope, source, title, body);
        }
        await audit(scope, {
          action: 'knowledge.source_updated',
          outcome: 'succeeded',
          objectType: 'knowledge_source',
          objectId: sourceId,
          metadata: { personaId, title: input.title !== undefined, body: input.body !== undefined, chunks },
        });
        return chunks !== null;
      });
      if (rechunked) await embedBestEffort(ctx, sourceId);
      return kit.inRequest(ctx, (scope) => view(scope, sourceId));
    },

    remove: async (ctx, rawPersonaId, rawSourceId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const sourceId = requireId(rawSourceId, 'Knowledge source');
      const key = await kit.inRequest(ctx, async (scope) => {
        await requireCurator(scope, personaId);
        const source = await loadSource(scope, personaId, sourceId);
        const removed = await knowledgeRepo.deleteChunksForSource(scope.tx, sourceId);
        await knowledgeRepo.setKnowledgeSourceStatus(scope.tx, { sourceId, status: 'withdrawn' });
        await audit(scope, {
          action: 'knowledge.source_withdrawn',
          outcome: 'succeeded',
          objectType: 'knowledge_source',
          objectId: sourceId,
          metadata: { personaId, kind: source.kind, chunks: removed },
        });
        return source.s3Key;
      });
      if (key !== null) {
        try {
          await objectStore.delete(key);
        } catch (err) {
          logger.warn('knowledge.object_delete_failed', {
            requestId: ctx.requestId,
            sourceId,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
    },

    createUpload: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(CreateDocumentRequest, rawInput);
      const sourceId = kit.deps.ids.uuid();
      const key = personaSourceKey({ tenantId: ctx.tenantId, personaId, sourceId, filename: input.filename });
      const source = await kit.inRequest(ctx, async (scope) => {
        const persona = await requireCurator(scope, personaId);
        if (persona.status === 'retired') throw fail.conflict('The persona is retired', 'persona_retired');
        await documentsRepo.lockUploadAdmission(scope.tx, ctx.principalId);
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        const usage = await documentsRepo.uploadUsageToday(scope.tx);
        const overCount = usage.documents + 1 > settings.dailyUploadDocumentsPerPrincipal;
        const overBytes = usage.bytes + input.sizeBytes > settings.dailyUploadBytesPerPrincipal;
        if (overCount || overBytes) {
          const reason = overCount ? 'daily_upload_count' : 'daily_upload_bytes';
          scope.deferAudit({
            action: 'knowledge.upload_quota',
            outcome: 'blocked',
            objectType: 'knowledge_source',
            policyReason: reason,
            metadata: { personaId, documentsToday: usage.documents, sizeBytes: input.sizeBytes },
          });
          throw new DomainError(
            'rate_limited',
            overCount
              ? `You can upload up to ${String(settings.dailyUploadDocumentsPerPrincipal)} documents per day. Try again after midnight UTC.`
              : 'You have reached your daily upload volume. Try again after midnight UTC.',
            { reason, retryAfterSeconds: secondsUntilUtcMidnight(kit.now()) },
          );
        }
        await knowledgeRepo.createKnowledgeSource(scope.tx, {
          id: sourceId,
          tenantId: ctx.tenantId,
          scope: 'persona',
          personaId,
          kind: 'document',
          title: input.filename,
          classification: 'program_internal',
          status: 'pending_upload',
          createdBy: ctx.principalId,
          upload: {
            s3Key: key,
            filename: input.filename,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
          },
        });
        await audit(scope, {
          action: 'knowledge.upload_requested',
          outcome: 'succeeded',
          objectType: 'knowledge_source',
          objectId: sourceId,
          metadata: { personaId, contentType: input.contentType, sizeBytes: input.sizeBytes },
        });
        return view(scope, sourceId);
      });
      const presigned = await objectStore.presignPut({
        key,
        contentType: input.contentType,
        contentLength: input.sizeBytes,
        expiresInSeconds: kit.config.uploads.presignTtlSeconds,
      });
      return {
        source,
        upload: {
          url: presigned.url,
          method: 'PUT',
          headers: { ...presigned.headers },
          expiresAt: presigned.expiresAt,
        },
      };
    },

    completeUpload: async (ctx, rawPersonaId, rawSourceId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const sourceId = requireId(rawSourceId, 'Knowledge source');
      const queued = await kit.inRequest(ctx, async (scope) => {
        await requireCurator(scope, personaId);
        const source = await loadSource(scope, personaId, sourceId);
        if (source.s3Key === null) throw fail.conflict('This source has no upload', 'not_an_upload');
        if (source.status === 'processing' || source.status === 'active') return null;
        const moved = await knowledgeRepo.setKnowledgeSourceStatus(scope.tx, {
          sourceId,
          status: 'processing',
          fromStatuses: ['pending_upload', 'failed'],
        });
        if (!moved) throw fail.conflict('The upload cannot be processed in its current state');
        await audit(scope, {
          action: 'knowledge.ingestion_requested',
          outcome: 'succeeded',
          objectType: 'knowledge_source',
          objectId: sourceId,
          metadata: { personaId, retry: source.status === 'failed' },
        });
        return { tenantId: source.tenantId, updatedAt: kit.now().toISOString() };
      });
      if (queued !== null) {
        try {
          await jobQueue.enqueue(
            {
              type: 'ingest_knowledge_source',
              sourceId,
              tenantId: queued.tenantId,
              personaId,
              requestId: ctx.requestId,
            },
            { deduplicationId: `${sourceId}:${queued.updatedAt}` },
          );
        } catch (err) {
          await kit.inRequest(ctx, (scope) =>
            knowledgeRepo.setKnowledgeSourceStatus(scope.tx, {
              sourceId,
              status: 'failed',
              failureReason: 'enqueue_failed',
              fromStatuses: ['processing'],
            }),
          );
          throw new DomainError('internal', 'Processing could not be started; please retry', {
            reason: 'enqueue_failed',
            cause: err,
          });
        }
      }
      return kit.inRequest(ctx, (scope) => view(scope, sourceId));
    },
  };
}
