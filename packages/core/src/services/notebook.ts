import { createHash } from 'node:crypto';

import {
  type NotebookEdit,
  type NotebookSection,
  UpdateNotebookRequest,
  type VeirNotebook,
} from '@foundry/contracts';
import { NotebookIntegrityError, assignmentsRepo, notebooksRepo, personasRepo } from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { type DirectoryCache, type OtherVentures } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { openerProblem, validatedOpener, type OpenerProblem } from '../orchestrator/continuity.js';

/**
 * The vEIR notebook: "what <vEIR> knows about you and <venture>", one per venture × the persona that coaches
 * it. Everything in it is an AI note: the founder/team see every line, correct or remove any of them, or
 * clear it; the assigned EIR reads it. Edits carry the version they were made against (409 on a stale
 * edit), and every removed or corrected line is remembered as a fingerprint so distillation never writes
 * it back. A stored notebook that does not match its contract fails loudly (500, logged with ids only)
 * instead of being shown or saved as if it were empty.
 */
export interface NotebookService {
  /** The notebook of the venture's current vEIR (founder/team or the assigned EIR). Empty at version 0. */
  get(ctx: RequestContext, ventureId: string): Promise<VeirNotebook>;
  /** Applies one edit made against `expectedVersion` (founder/team). 409 `conflict` when it is stale. */
  update(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof UpdateNotebookRequest>,
  ): Promise<VeirNotebook>;
}

/** What the opener checks need from the tenant's directory. */
interface OpenerDirectory {
  readonly others: OtherVentures;
  readonly eirNames: readonly string[];
}

const SECTIONS: readonly NotebookSection[] = ['founderProfile', 'openQuestions', 'lastAdvice'];

/**
 * Fingerprint of a notebook line for the suppression list: SHA-256 (first 32 hex) of its words, lower-cased,
 * without punctuation, so the same statement re-worded only in case, spacing or punctuation matches. Not
 * reversible: removed text is not kept.
 */
export function notebookFingerprint(text: string): string {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
  return createHash('sha256').update(words.join(' '), 'utf8').digest('hex').slice(0, 32);
}

/** Whether `text` in `section` was removed or corrected by a person (distillation must not write it back). */
export function isSuppressed(
  suppressed: readonly notebooksRepo.SuppressedLine[],
  section: notebooksRepo.SuppressedLine['section'],
  text: string,
): boolean {
  const fingerprint = notebookFingerprint(text);
  return suppressed.some((line) => line.section === section && line.fingerprint === fingerprint);
}

export interface NotebookEditResult {
  readonly content: notebooksRepo.NotebookContent;
  readonly suppressed: notebooksRepo.SuppressedLine[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Pure edit rule (unit tested). Throws `not_found` for an unknown line and `validation_failed` for a bad
 * date; every replaced or removed line is added to the suppression list. Where the summary and opener were
 * drawn from is recorded by `saveNotebook`, not here.
 */
export function applyNotebookEdit(
  current: notebooksRepo.NotebookContent,
  suppressed: readonly notebooksRepo.SuppressedLine[],
  edit: NotebookEdit,
  now: Date,
): NotebookEditResult {
  const at = now.toISOString();
  const out = [...suppressed];
  const suppress = (section: notebooksRepo.SuppressedLine['section'], text: string | null): void => {
    if (text === null || text.trim() === '') return;
    const fingerprint = notebookFingerprint(text);
    if (!out.some((line) => line.section === section && line.fingerprint === fingerprint)) {
      out.push({ section, fingerprint, at });
    }
  };
  switch (edit.action) {
    case 'edit_summary': {
      if (edit.summary === current.summary) return { content: current, suppressed: out };
      suppress('summary', current.summary);
      return { content: { ...current, summary: edit.summary }, suppressed: out };
    }
    case 'edit_entry':
    case 'remove_entry': {
      const entries = current[edit.section];
      const index = entries.findIndex((e) => e.id === edit.id);
      const entry = entries[index];
      if (entry === undefined) throw fail.notFound('Notebook line');
      suppress(edit.section, entry.text);
      const next =
        edit.action === 'remove_entry'
          ? entries.filter((e) => e.id !== edit.id)
          : entries.map((e) => (e.id === edit.id ? { ...e, text: edit.text } : e));
      return { content: { ...current, [edit.section]: next }, suppressed: out };
    }
    case 'edit_commitment':
    case 'remove_commitment': {
      const commitment = current.commitments.find((c) => c.id === edit.id);
      if (commitment === undefined) throw fail.notFound('Commitment');
      if (edit.action === 'remove_commitment') {
        suppress('commitments', commitment.text);
        return {
          content: { ...current, commitments: current.commitments.filter((c) => c.id !== edit.id) },
          suppressed: out,
        };
      }
      if (edit.due !== undefined && edit.due !== null && !validDate(edit.due)) {
        throw fail.validation('The due date is not valid', [{ path: 'edit.due', message: 'Use YYYY-MM-DD' }]);
      }
      if (edit.text !== undefined && edit.text !== commitment.text) suppress('commitments', commitment.text);
      const updated = {
        ...commitment,
        ...(edit.text === undefined ? {} : { text: edit.text }),
        ...(edit.due === undefined ? {} : { due: edit.due }),
        ...(edit.status === undefined ? {} : { status: edit.status }),
      };
      return {
        content: {
          ...current,
          commitments: current.commitments.map((c) => (c.id === edit.id ? updated : c)),
        },
        suppressed: out,
      };
    }
    case 'edit_opener': {
      if (edit.text === current.nextOpener) return { content: current, suppressed: out };
      suppress('nextOpener', current.nextOpener);
      return { content: { ...current, nextOpener: edit.text }, suppressed: out };
    }
    case 'remove_opener': {
      if (current.nextOpener === null) return { content: current, suppressed: out };
      suppress('nextOpener', current.nextOpener);
      return { content: { ...current, nextOpener: null }, suppressed: out };
    }
    case 'clear': {
      suppress('summary', current.summary);
      suppress('nextOpener', current.nextOpener);
      for (const section of SECTIONS) for (const entry of current[section]) suppress(section, entry.text);
      for (const commitment of current.commitments) suppress('commitments', commitment.text);
      return { content: notebooksRepo.EMPTY_NOTEBOOK, suppressed: out };
    }
  }
}

/** What the notebook editor shows when the vEIR could not say an opener a person wrote (422 at `edit.text`). */
const OPENER_PROBLEMS: Record<OpenerProblem, string> = {
  not_plain: 'Write the opening line as plain text on one line.',
  too_long: 'Keep the opening line to 300 characters or fewer.',
  identity:
    'The vEIR says this line itself, so it can’t name an EIR, speak as a person, or say anyone reviewed or approved something.',
  other_venture: 'The opening line can’t name another venture or its people.',
};

export function createNotebookService(kit: Kit, directory: DirectoryCache): NotebookService {
  /** A notebook that cannot be read in full is never shown or saved as if it were complete. */
  function requireIntact(
    scope: RequestScope,
    ventureId: string,
    record: notebooksRepo.NotebookRecord | null,
  ): void {
    if (record === null || record.intact) return;
    kit.deps.logger.error('notebook.integrity_failed', {
      requestId: scope.ctx.requestId,
      ventureId,
      notebookId: record.id,
      version: record.version,
    });
    throw new NotebookIntegrityError(record.id);
  }

  /** The directory facts the opener checks need (owner role, read before the request transaction). */
  async function openerDirectory(ctx: RequestContext, ventureId: string): Promise<OpenerDirectory> {
    return {
      others: await directory.others(ctx.tenantId, ventureId),
      eirNames: (await directory.get(ctx.tenantId)).eirNames,
    };
  }

  /**
   * The notebook's opener as New chat may show it: the same checks as at the start of a conversation and of a
   * call (a person may have edited it, and distillation does not check EIR names).
   */
  async function greetingOf(
    scope: RequestScope,
    persona: { id: string; name: string },
    opener: string | null,
    guards: OpenerDirectory,
  ): Promise<string | null> {
    if (opener === null) return null;
    return validatedOpener(opener, {
      personaName: persona.name,
      personaEirName: await personasRepo.getPersonaEirName(scope.tx, persona.id),
      eirNames: guards.eirNames,
      otherVentureNames: guards.others.names,
      otherVentureCanaries: guards.others.canaries,
      otherVentureMemberNames: guards.others.memberNames,
    });
  }

  /** The persona coaching the venture now (its notebook is the one shown). */
  async function currentPersona(
    scope: RequestScope,
    ventureId: string,
  ): Promise<{ id: string; name: string }> {
    const resolved = await assignmentsRepo.resolveActiveAssignment(scope.tx, ventureId);
    if (resolved === null) {
      throw new DomainError('assignment_inactive', 'This venture has no active coaching assignment', {
        reason: 'no_active_assignment',
      });
    }
    return { id: resolved.persona.id, name: resolved.persona.name };
  }

  return {
    get: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const guards = await openerDirectory(ctx, ventureId);
      return await kit.inRequest(ctx, async (scope) => {
        const decision = await requireVentureAccess(scope, ventureId, 'read', { objectType: 'notebook' });
        if (!decision.canWrite && !decision.isAssignedEir) {
          // Advisors never read conversations, so they never read what was distilled from them.
          scope.deferAudit({
            action: 'venture.access',
            outcome: 'denied',
            ventureId,
            objectType: 'notebook',
            policyReason: 'notebook_not_shared',
          });
          throw fail.notFound('Notebook');
        }
        const persona = await currentPersona(scope, ventureId);
        const record = await notebooksRepo.getNotebook(scope.tx, { ventureId, personaId: persona.id });
        requireIntact(scope, ventureId, record);
        return notebooksRepo.toNotebookView(
          { ventureId, personaId: persona.id, personaName: persona.name },
          record,
          await greetingOf(scope, persona, record?.content.nextOpener ?? null, guards),
        );
      });
    },

    update: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(UpdateNotebookRequest, rawInput);
      // An opener a person writes is shown and spoken as the vEIR (the first bubble of the next conversation
      // and the call intro), so it passes the checks applied there; the directory (owner role) is read before
      // the writing transaction, as at session start.
      const openerGuards = await openerDirectory(ctx, ventureId);
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'notebook' });
        const persona = await currentPersona(scope, ventureId);
        if (input.edit.action === 'edit_opener') {
          const problem = openerProblem(input.edit.text, {
            personaName: persona.name,
            personaEirName: await personasRepo.getPersonaEirName(scope.tx, persona.id),
            eirNames: openerGuards.eirNames,
            otherVentureNames: openerGuards.others.names,
            otherVentureCanaries: openerGuards.others.canaries,
            otherVentureMemberNames: openerGuards.others.memberNames,
          });
          if (problem !== null) {
            scope.deferAudit({
              action: 'notebook.edited',
              outcome: 'blocked',
              ventureId,
              objectType: 'notebook',
              policyReason: `opener_${problem}`,
            });
            throw fail.validation('The vEIR can’t say this opening line', [
              { path: 'edit.text', message: OPENER_PROBLEMS[problem] },
            ]);
          }
        }
        const record = await notebooksRepo.getNotebook(scope.tx, { ventureId, personaId: persona.id });
        requireIntact(scope, ventureId, record);
        const version = record?.version ?? 0;
        const stale = (): DomainError =>
          new DomainError('conflict', 'The notebook changed since you opened it. Reload it and try again.', {
            reason: 'notebook_version',
          });
        if (input.expectedVersion !== version) throw stale();
        const next = applyNotebookEdit(
          record?.content ?? notebooksRepo.EMPTY_NOTEBOOK,
          record?.suppressed ?? [],
          input.edit,
          kit.now(),
        );
        const saved = await notebooksRepo.saveNotebook(scope.tx, {
          tenantId: ctx.tenantId,
          ventureId,
          personaId: persona.id,
          expectedVersion: version,
          content: next.content,
          suppressed: next.suppressed,
          editedBy: 'person',
          principalId: ctx.principalId,
        });
        if (saved === null) throw stale();
        await audit(scope, {
          action: 'notebook.edited',
          outcome: 'succeeded',
          ventureId,
          objectType: 'notebook',
          objectId: saved.id,
          metadata: {
            personaId: persona.id,
            edit: input.edit.action,
            section: 'section' in input.edit ? input.edit.section : null,
            version: saved.version,
          },
        });
        return notebooksRepo.toNotebookView(
          { ventureId, personaId: persona.id, personaName: persona.name },
          saved,
          await greetingOf(scope, persona, saved.content.nextOpener, openerGuards),
        );
      });
    },
  };
}
