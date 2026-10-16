import { DISTILL_LIMITS, sanitizePlainText } from '@foundry/ai';
import { type EscalationCategory } from '@foundry/contracts';
import { assignmentsRepo, auditRepo, notebooksRepo, type escalationsRepo } from '@foundry/db';

import { type Kit } from '../internal/kit.js';
import { notebookFingerprint } from './notebook.js';

/**
 * Human help feeds the vEIR notebook: when an EIR or program lead resolves a founder's escalation, the
 * resolution becomes a `lastAdvice` line, attributed to the person who gave it, so the vEIR can pick the
 * thread up. It is an AI-notebook line like any other: visible to the venture team, correctable and removable,
 * never cited as a fact. Wellbeing and conflict cases stay out of the coaching notebook.
 */

/** Categories whose resolutions are personal matters, not venture advice: never written to the notebook. */
const PRIVATE_CATEGORIES: ReadonlySet<EscalationCategory> = new Set([
  'safety_wellbeing',
  'conflict_harassment',
]);
const NOTEBOOK_WRITE_ATTEMPTS = 3;
const ENTRY_MAX_CHARS = 400;

/** The notebook entry id of an escalation's resolution (one line per escalation, so retries are no-ops). */
export function resolutionEntryId(escalationId: string): string {
  return `esc-${escalationId}`;
}

/** Whole words up to `max` characters, with an ellipsis when cut. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** "From Corin Halvorsen (human help): <summary> Next: <step>; <step>" — plain text, at most 400 characters. */
export function resolutionNote(
  resolverName: string,
  resolution: { readonly summary: string; readonly nextSteps: readonly string[] },
): string {
  const plain = (value: string): string => sanitizePlainText(value).text.replace(/\s+/g, ' ').trim();
  const summary = plain(resolution.summary).replace(/([^.!?])$/, '$1.');
  const steps = resolution.nextSteps.map(plain).filter((s) => s !== '');
  const next = steps.length > 0 ? ` Next: ${steps.join('; ')}` : '';
  return clamp(`From ${plain(resolverName)} (human help): ${summary}${next}`, ENTRY_MAX_CHARS);
}

/**
 * Adds a resolved escalation's advice to the notebook of the venture's current vEIR (owner role; the assignee
 * cannot write the notebook under RLS). The line is newest first; the section keeps at most five lines,
 * dropping the oldest lines no person edited. Skipped for private categories, ventures without an active
 * vEIR, a line a person already removed (suppressed), or an escalation already recorded. Audited with ids.
 */
export async function addResolutionToNotebook(
  kit: Kit,
  args: {
    readonly requestId: string;
    readonly escalation: escalationsRepo.EscalationRecord;
    readonly resolverId: string;
  },
): Promise<'added' | 'skipped'> {
  const { escalation } = args;
  if (escalation.status !== 'resolved' || escalation.resolution === null) return 'skipped';
  if (PRIVATE_CATEGORIES.has(escalation.category)) return 'skipped';
  const resolverName = escalation.assignee?.displayName ?? 'Human help';
  const text = resolutionNote(resolverName, escalation.resolution);
  const id = resolutionEntryId(escalation.id);
  return kit.system(async (sx) => {
    const active = await assignmentsRepo.resolveActiveAssignment(sx, escalation.ventureId);
    if (active === null) return 'skipped';
    const scope = { ventureId: escalation.ventureId, personaId: active.persona.id };
    for (let attempt = 0; attempt < NOTEBOOK_WRITE_ATTEMPTS; attempt += 1) {
      const current = await notebooksRepo.getNotebook(sx, scope);
      const content = current?.content ?? notebooksRepo.EMPTY_NOTEBOOK;
      const fingerprint = notebookFingerprint(text);
      if (
        content.lastAdvice.some((e) => e.id === id) ||
        (current?.suppressed ?? []).some((line) => line.fingerprint === fingerprint)
      ) {
        return 'skipped';
      }
      const edited = new Set(current ? await notebooksRepo.getPersonEdits(sx, scope) : []);
      const lastAdvice = [
        { id, text, sourceSessionId: escalation.sessionId, createdAt: kit.now().toISOString() },
        ...content.lastAdvice,
      ];
      // Oldest first out, but never a line a person edited.
      for (let i = lastAdvice.length - 1; lastAdvice.length > DISTILL_LIMITS.lastAdviceMax && i > 0; i -= 1) {
        const entry = lastAdvice[i];
        if (entry !== undefined && !edited.has(entry.id)) lastAdvice.splice(i, 1);
      }
      const saved = await notebooksRepo.saveNotebook(sx, {
        tenantId: escalation.tenantId,
        ...scope,
        expectedVersion: current?.version ?? 0,
        content: { ...content, lastAdvice },
        suppressed: current?.suppressed ?? [],
        editedBy: 'person',
        principalId: args.resolverId,
      });
      if (saved === null) continue;
      await auditRepo.appendAudit(sx, {
        action: 'notebook.advice_added',
        outcome: 'succeeded',
        tenantId: escalation.tenantId,
        actorId: args.resolverId,
        ventureId: escalation.ventureId,
        objectType: 'notebook',
        objectId: saved.id,
        requestId: args.requestId,
        metadata: { escalationId: escalation.id, personaId: scope.personaId, version: saved.version },
      });
      return 'added';
    }
    kit.deps.logger.warn('notebook.advice_conflict', {
      requestId: args.requestId,
      escalationId: escalation.id,
    });
    return 'skipped';
  });
}
