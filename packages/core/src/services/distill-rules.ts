import { type DistillDraft } from '@foundry/ai';
import { notebooksRepo, type sessionsRepo } from '@foundry/db';

import { notebookFingerprint } from './notebook.js';

/**
 * Pure rules of the distillation job (unit tested): when a queued job does nothing, when starting a
 * conversation distils the previous one, and how a merged notebook respects what people changed.
 */

/** Why a `distill_session` job ends without a model call. */
export type DistillSkipReason =
  'not_found' | 'deleted' | 'ephemeral' | 'digest_deleted' | 'no_turns' | 'up_to_date' | 'active';

type DistillStateFields = Pick<
  sessionsRepo.DistillState,
  | 'privacy'
  | 'deletedAt'
  | 'digestDeletedAt'
  | 'completedTurns'
  | 'distillVersion'
  | 'status'
  | 'lastActivityAt'
>;

/** Whether the conversation had a turn within the active window (it is still going on). */
export function isActive(
  state: Pick<DistillStateFields, 'status' | 'lastActivityAt'>,
  now: Date,
  activeWindowSeconds: number,
): boolean {
  return (
    state.status === 'active' &&
    now.getTime() - new Date(state.lastActivityAt).getTime() < activeWindowSeconds * 1000
  );
}

/**
 * Cheap checks before any model call, in order: the conversation is gone, deleted, temporary, its digest was
 * deleted by a person, it has no completed turn, the digest already covers every completed turn, or it is
 * still active (a turn within the active window: the job queued by that later turn covers it). Null when the
 * conversation should be distilled now. An ended conversation is never "active".
 */
export function distillSkipReason(
  state: DistillStateFields | null,
  now: Date,
  activeWindowSeconds: number,
): DistillSkipReason | null {
  if (state === null) return 'not_found';
  if (state.deletedAt !== null) return 'deleted';
  if (state.privacy !== 'standard') return 'ephemeral';
  if (state.digestDeletedAt !== null) return 'digest_deleted';
  if (state.completedTurns === 0) return 'no_turns';
  if (state.distillVersion >= state.completedTurns) return 'up_to_date';
  if (isActive(state, now, activeWindowSeconds)) return 'active';
  return null;
}

/**
 * Re-check inside the writing transaction (the conversation row is locked): why the distillation of `turns`
 * turns must not be written after all (deleted, temporary, digest deleted meanwhile, or another run already
 * covered as many turns), or null.
 */
export function staleWriteReason(
  locked: Pick<DistillStateFields, 'privacy' | 'deletedAt' | 'digestDeletedAt' | 'distillVersion'> | null,
  turns: number,
): DistillSkipReason | null {
  if (locked === null) return 'not_found';
  if (locked.deletedAt !== null) return 'deleted';
  if (locked.privacy !== 'standard') return 'ephemeral';
  if (locked.digestDeletedAt !== null) return 'digest_deleted';
  if (locked.distillVersion >= turns) return 'up_to_date';
  return null;
}

/**
 * Whether starting a conversation should distil the person's previous one now: it is a standard
 * conversation, its digest was not deleted, it has completed turns no digest covers yet, and it is idle
 * (ended, or no turn within the active window).
 */
export function previousNeedsDistill(
  previous: sessionsRepo.PreviousConversation | null,
  now: Date,
  activeWindowSeconds: number,
): boolean {
  if (previous?.privacy !== 'standard' || previous.digestDeleted) return false;
  if (previous.completedTurns <= previous.distillVersion) return false;
  return !isActive(previous, now, activeWindowSeconds);
}

/**
 * The model's draft without rewrites of lines a person edited: sanitizeDistill keeps a pinned entry as the
 * person left it, so a proposal with the same id but other wording would otherwise be added as a second,
 * contradicting line. Commitments are matched by id inside sanitizeDistill already.
 */
export function withoutPinnedRewrites(draft: DistillDraft, pinned: ReadonlySet<string>): DistillDraft {
  const keep = <T extends { id: string | null }>(notes: readonly T[]): T[] =>
    notes.filter((n) => n.id === null || !pinned.has(n.id));
  return {
    ...draft,
    notebook: {
      ...draft.notebook,
      founder_profile: keep(draft.notebook.founder_profile),
      open_questions: keep(draft.notebook.open_questions),
      last_advice: keep(draft.notebook.last_advice),
    },
  };
}

const ENTRY_SECTIONS = ['founderProfile', 'openQuestions', 'lastAdvice'] as const;

/**
 * Texts of lines a person removed or reworded between `before` (what the model was shown) and `after` (the
 * notebook now): passed to sanitizeDistill as suppressed texts so near-duplicates of them are dropped too.
 * They exist only in memory during the job; the notebook keeps fingerprints, never removed text.
 */
export function removedSince(
  before: notebooksRepo.NotebookContent | null,
  after: notebooksRepo.NotebookContent | null,
): string[] {
  if (before === null) return [];
  const out: string[] = [];
  const changed = (text: string, current: string | null | undefined): void => {
    if (text.trim() !== '' && current !== text) out.push(text);
  };
  for (const section of ENTRY_SECTIONS) {
    for (const entry of before[section]) {
      changed(entry.text, after?.[section].find((e) => e.id === entry.id)?.text);
    }
  }
  for (const commitment of before.commitments) {
    changed(commitment.text, after?.commitments.find((c) => c.id === commitment.id)?.text);
  }
  changed(before.summary, after?.summary);
  if (before.nextOpener !== null) changed(before.nextOpener, after?.nextOpener);
  return out;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

/**
 * Drops every line of a merged notebook whose fingerprint a person suppressed (removed or corrected it), in
 * any section: entries, commitments, sentences of the summary and the opener. Returns the content and how many
 * lines were dropped.
 */
export function dropSuppressed(
  content: notebooksRepo.NotebookContent,
  suppressed: readonly notebooksRepo.SuppressedLine[],
): { content: notebooksRepo.NotebookContent; dropped: number } {
  if (suppressed.length === 0) return { content, dropped: 0 };
  const fingerprints = new Set(suppressed.map((line) => line.fingerprint));
  const hidden = (text: string): boolean => fingerprints.has(notebookFingerprint(text));
  let dropped = 0;
  const filter = <T extends { text: string }>(items: readonly T[]): T[] =>
    items.filter((item) => {
      if (!hidden(item.text)) return true;
      dropped += 1;
      return false;
    });
  let summary = content.summary;
  if (summary !== '' && hidden(summary)) {
    dropped += 1;
    summary = '';
  } else if (summary !== '') {
    const sentences = sentencesOf(summary);
    const kept = sentences.filter((s) => !hidden(s));
    dropped += sentences.length - kept.length;
    summary = kept.join(' ');
  }
  let nextOpener = content.nextOpener;
  if (nextOpener !== null && hidden(nextOpener)) {
    dropped += 1;
    nextOpener = null;
  }
  return {
    content: {
      summary,
      founderProfile: filter(content.founderProfile),
      commitments: filter(content.commitments),
      openQuestions: filter(content.openQuestions),
      lastAdvice: filter(content.lastAdvice),
      nextOpener,
    },
    dropped,
  };
}

/** Whether two notebook contents are the same (a distillation that changes nothing writes nothing). */
export function sameNotebook(
  a: notebooksRepo.NotebookContent | null,
  b: notebooksRepo.NotebookContent,
): boolean {
  // Parsing puts every object's keys in schema order, so the comparison ignores key order.
  const canonical = (c: notebooksRepo.NotebookContent): string =>
    JSON.stringify(notebooksRepo.NotebookContent.parse(c));
  return a !== null && canonical(a) === canonical(b);
}

/** Words of a document file name, for the lesson denylist ("northfield-pilot-terms.pdf" → its words). */
export function filenameWords(filename: string): string {
  return filename
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[_\-.]+/g, ' ')
    .trim();
}
