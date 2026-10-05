import {
  type EscalationView,
  type MemoryObjectView,
  type PersonaSummary,
  type ResourceView,
} from '@foundry/contracts';
import { type assignmentsRepo, type escalationsRepo, type memoryRepo, type resourcesRepo } from '@foundry/db';

/** Contract view of a memory record (drops tenant id and embedding flag). */
export function toMemoryView(m: memoryRepo.MemoryRecord): MemoryObjectView {
  return {
    id: m.id,
    ventureId: m.ventureId,
    type: m.type,
    title: m.title,
    content: m.content,
    contentLength: m.contentLength,
    attributes: m.attributes,
    status: m.status,
    visibility: m.visibility,
    confidence: m.confidence,
    sourceRefs: m.sourceRefs,
    origin: m.origin,
    createdBy: m.createdBy,
    approvedBy: m.approvedBy,
    approvedAt: m.approvedAt,
    version: m.version,
    supersedesId: m.supersedesId,
    pinned: m.pinned,
    expiresAt: m.expiresAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/**
 * Contract view of an escalation. `includePacket` is false for viewers that may only see metadata;
 * RLS already hides unconsented escalations from assignees.
 */
export function toEscalationView(e: escalationsRepo.EscalationRecord, includePacket = true): EscalationView {
  return {
    id: e.id,
    ventureId: e.ventureId,
    ventureName: e.ventureName,
    sessionId: e.sessionId,
    turnId: e.turnId,
    category: e.category,
    priority: e.priority,
    status: e.status,
    requestedRole: e.requestedRole,
    packet: includePacket ? e.packet : null,
    sharingConsentAt: e.sharingConsentAt,
    assignee: e.assignee,
    dueAt: e.dueAt,
    resolution: e.resolution,
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

export function toResourceView(r: resourcesRepo.ResourceRecord): ResourceView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    description: r.description,
    url: r.url,
    tags: r.tags,
    stages: r.stages,
    eligibility: r.eligibility,
    owner: r.owner,
    freshnessAt: r.freshnessAt,
    status: r.status,
  };
}

/** Persona summary for venture detail (null when the venture has no usable release). */
export function toPersonaSummary(resolved: assignmentsRepo.ResolvedAssignment | null): PersonaSummary | null {
  if (resolved?.release == null) return null;
  return {
    personaId: resolved.persona.id,
    releaseId: resolved.release.id,
    name: resolved.persona.name,
    kind: resolved.persona.kind,
    version: resolved.release.version,
    status: resolved.persona.status,
    disclosure: resolved.release.disclosureText,
    allowedModes: resolved.assignment.allowedModes.filter((m) => resolved.release?.allowedModes.includes(m)),
  };
}
