import {
  MAX_LINE_SOURCES,
  type ConversationDigest,
  type MemoryCandidate,
  type NotebookCommitment,
  type NotebookEntry,
  type VeirNotebook,
} from '@foundry/contracts';

import { fnv1a } from '../gateway/hash-embedding.js';
import { lastQuestionOf } from '../prompts/continuity.js';
import { truncate } from '../prompts/escape.js';
import { COMMON_WORDS } from '../risk/common-words.js';
import { textsContainOtherVenture } from '../validators/coach-response.js';
import { IDENTITY_MARGIN_CHARS, rewriteIdentity } from '../validators/identity.js';
import { sanitizePlainText } from '../validators/markdown.js';
import { checkDeidentified, type DeidentifyReason, type LessonDeidentifyContext } from './deidentify.js';
import {
  DISTILL_LIMITS,
  type DistillCommitment,
  type DistillDraft,
  type DistillNote,
  type LessonCandidate,
} from './schema.js';
import { isNearDuplicate, repeatsNote, textKey } from './similarity.js';
import { isAboutThread, mentions, threadWords, tookUp, untakenThread } from './threads.js';

/** Text kept past a field's limit for the identity check, so a sentence that crosses the limit is judged whole. */

/** Pinned keys for the two notebook fields that have no entry id. */
export const NOTEBOOK_SUMMARY_PIN = 'summary';
export const NOTEBOOK_OPENER_PIN = 'nextOpener';

export type PreviousNotebook = Pick<
  VeirNotebook,
  'summary' | 'founderProfile' | 'commitments' | 'openQuestions' | 'lastAdvice' | 'nextOpener' | 'nextTopic'
>;

export interface DistillSanitizeContext {
  /** The distilled conversation: source of new notebook entries, and the seed of their stable ids. */
  sessionId: string;
  /** ISO timestamp: the digest's `generatedAt` and the `createdAt` of new notebook entries. */
  now: string;
  personaName: string;
  /** EIR display names the vEIR must never speak as (identity rewrite), its own EIR included. */
  eirNames: readonly string[];
  /** The persona's own EIR display name, when known (see `IdentityCheckOptions.personaEirName`). */
  personaEirName?: string | null;
  /** The notebook the model started from (null for the first conversation). */
  previousNotebook?: PreviousNotebook | null;
  /**
   * The conversation the previous notebook's opener (and its thread) was drawn from: null when a person wrote it,
   * undefined when unknown. A thread drawn from an earlier conversation that this one never took up is stale.
   */
  previousOpenerSource?: string | null;
  /**
   * The conversation as it was said, so the next opener is never a thread the founder did not take up: what it
   * opened with (its first bubble, or what a call's greeting said), and every completed turn so far, oldest first
   * (all of them, not only the part distilled now). Absent: not checked.
   */
  conversation?: DistillConversation;
  /**
   * Texts the founder's team removed from the notebook or replaced with a correction. Anything that
   * repeats one of them (near-duplicates included) is never written back.
   */
  suppressed?: readonly string[];
  /**
   * Notebook entry and commitment ids a person edited since the last distillation, plus
   * `NOTEBOOK_SUMMARY_PIN` / `NOTEBOOK_OPENER_PIN` for a person-edited summary or opener. They are kept
   * exactly as the person left them, whatever the model proposes.
   */
  pinnedEntryIds?: readonly string[];
  /** Evidence keys shown in the distillation prompt (`E1…En`): the only ids memory candidates may cite. */
  evidenceKeys?: Iterable<string>;
  /** Existing venture memory (titles and contents) that candidates must not repeat. */
  existingMemory?: readonly { title: string; content: string }[];
  otherVentureNames: readonly string[];
  otherVentureCanaries: readonly string[];
  otherVentureMemberNames?: readonly string[];
  /**
   * What a lesson must never mention. The other ventures' names, canaries and members and the EIR names
   * above are added automatically; supply this venture's name, canary and people, its customers, labs
   * and sponsors.
   */
  lessons: LessonDeidentifyContext;
}

/** What a conversation raised and what the founder said (see `DistillSanitizeContext.conversation`). */
export interface DistillConversation {
  /** What it opened with: the first bubble, or a call's greeting; null when it opened with nothing. */
  readonly opener: string | null;
  /** The founder's words of each completed turn, oldest first. */
  readonly founderTurns: readonly string[];
  /** The vEIR's answer of each of those turns (null when none): a question it asked raises a thread too. */
  readonly answers?: readonly (string | null)[];
  /** Names said in it that are no thread (the founder's, the persona's, the EIR's): "Hi Idris, …". */
  readonly names?: readonly string[];
}

/** The next notebook content (the full sections, merged with the previous notebook). */
export interface NotebookDelta {
  summary: string;
  founderProfile: NotebookEntry[];
  commitments: NotebookCommitment[];
  openQuestions: NotebookEntry[];
  lastAdvice: NotebookEntry[];
  nextOpener: string | null;
  /** The thread to come back to, as a short phrase (null with a null opener). */
  nextTopic: string | null;
}

/** Counts for the audit log (never content). */
export interface DistillStats {
  suppressedDropped: number;
  duplicatesDropped: number;
  pinnedKept: number;
  /** Proposals that would have replaced an entry a person edited (by id or by text). */
  pinnedRewritesDropped: number;
  /** Closed commitments left out to keep the notebook within its cap. */
  commitmentsDropped: number;
  /** New commitments refused because open and person-edited ones already fill the cap. */
  commitmentsRefused: number;
  memoryCandidatesDropped: number;
  lessonCandidatesDropped: number;
  lessonDropReasons: DeidentifyReason[];
  identityRewrites: number;
  /**
   * 1 when the proposed next opener (with its thread) was dropped: a thread the founder did not take up when it was
   * raised, or a thread kept from an earlier conversation that this one never took up.
   */
  untakenOpenerDropped: number;
}

export interface SanitizedDistill {
  /** Conversation title (≤ 80 characters), or null when the model gave none worth keeping. */
  title: string | null;
  digest: ConversationDigest;
  notebookDelta: NotebookDelta;
  /** At most 3, deduplicated against each other and existing memory; proposed, never confirmed. */
  memoryCandidates: MemoryCandidate[];
  /** At most 2, each passed the de-identification check; created as drafts for human review. */
  lessonCandidates: LessonCandidate[];
  stats: DistillStats;
}

function isIsoDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** A title: no wrapping quotes, no closing full stop, at most `max` characters cut at a word boundary. */
function titleText(value: string, max: number): string {
  let title = value
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();
  if (title.length > max) {
    const cut = title.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    title = (space > max * 0.5 ? cut.slice(0, space) : title.slice(0, max)).replace(/[\s,;:–—-]+$/, '');
  }
  return title;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

/**
 * The sources of a line this distillation changed: drawn from `sessionId` now, and still from every
 * conversation the line it replaces was drawn from (its words may carry theirs), so deleting any of them
 * removes it.
 */
function drawnFrom(
  origin: Pick<NotebookEntry, 'sourceSessionId' | 'sourceSessionIds'> | undefined,
  sessionId: string,
): Pick<NotebookEntry, 'sourceSessionId' | 'sourceSessionIds'> {
  const earlier = origin === undefined ? [] : [...(origin.sourceSessionIds ?? []), origin.sourceSessionId];
  const ids = [...new Set(earlier.filter((id): id is string => id !== null && id !== sessionId))];
  return ids.length === 0
    ? { sourceSessionId: sessionId }
    : { sourceSessionId: sessionId, sourceSessionIds: ids.slice(-MAX_LINE_SOURCES) };
}

/** A line without its earlier sources (they are replaced, not merged, by {@link drawnFrom}). */
function withoutSources<T extends { sourceSessionIds?: string[] }>(line: T): Omit<T, 'sourceSessionIds'> {
  const { sourceSessionIds: _earlier, ...rest } = line;
  return rest;
}

/** Open commitments first (soonest due first, then oldest), then closed ones (newest first). */
function byCommitmentOrder(a: NotebookCommitment, b: NotebookCommitment): number {
  const rank = (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1);
  if (rank !== 0) return rank;
  if (a.status === 'open') {
    if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due.localeCompare(b.due);
    return a.createdAt.localeCompare(b.createdAt);
  }
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * The threads a conversation raised that the founder did not take up ({@link untakenThread}): what it opened with;
 * each question the vEIR asked that no later founder message took up (the last answer's question had no reply yet,
 * so it is not counted); and the previous notebook's thread when it was drawn from an earlier conversation (or a
 * person, or nobody knows) and this conversation never took it up: a thread that survived a newer conversation
 * untouched is stale.
 */
function untakenThreads(
  conversation: DistillConversation,
  previous: PreviousNotebook | null,
  previousSource: string | null | undefined,
  sessionId: string,
): Set<string>[] {
  const names = conversation.names ?? [];
  const said = conversation.founderTurns;
  const out: Set<string>[] = [];
  const add = (thread: Set<string> | null): void => {
    if (thread !== null) out.push(thread);
  };
  add(untakenThread(conversation.opener, said, names));
  const answers = conversation.answers ?? [];
  for (let i = 0; i < answers.length - 1 && i < said.length - 1; i += 1) {
    const answer = answers[i];
    const question = answer === null || answer === undefined ? null : lastQuestionOf(answer);
    add(untakenThread(question, said.slice(i + 1), names));
  }
  if (previous !== null && previousSource !== sessionId) {
    const opener = conversation.opener;
    for (const thread of [previous.nextTopic ?? null, previous.nextOpener]) {
      if (thread === null) continue;
      const words = threadWords(thread, names);
      if (words.size === 0) continue;
      // Raised as the opener, a short yes takes it up; otherwise the founder has to speak of it.
      const raised = opener !== null && isAboutThread(opener, words, names);
      if (raised ? !tookUp(words, said) : !mentions(words, said)) out.push(words);
    }
  }
  return out;
}

/**
 * Deterministic checks on a distillation (the same guards as recaps, plus the notebook merge):
 *
 * - every text is plain (HTML and control characters removed), identity-rewritten (never the EIR, never
 *   human, never an endorsement) and bounded;
 * - the digest has at most 8 topics, 8 commitments and 6 open questions, with valid due dates;
 * - the notebook is merged with the previous one (see below);
 * - at most 3 memory candidates, citing only shown evidence, none repeating existing memory, a removed
 *   note or each other;
 * - at most 2 lesson candidates, each passing `checkDeidentified` (anything doubtful is dropped);
 * - when any newly written text names another venture, one of its members or a canary, the whole
 *   distillation is dropped (null), like a recap;
 * - the next opener and its thread are dropped (null) when they are about a thread the founder did not take up
 *   when it was raised (the conversation's opener, a question the vEIR asked) or a thread kept from an earlier
 *   conversation that this one never took up, unless the founder spoke of it themselves (`conversation`).
 *
 * Notebook merge semantics: the model returns the full proposed notebook, starting from the previous one.
 * Entries a person edited (`pinnedEntryIds`) are kept as the person left them, and a proposal with a
 * pinned id, or that restates a pinned entry, is dropped. A proposed entry whose
 * text is unchanged from a previous entry keeps that entry's id, creation time and source conversation;
 * a new or reworded entry gets a new id that is stable for this conversation and text (so a retry
 * produces the same notebook). A line this conversation changed (a reworded entry, by id or as a
 * near-duplicate; a commitment reworded, re-dated or closed) is drawn from this conversation and keeps the
 * conversations the line it replaces was drawn from (`sourceSessionIds`): its words may carry theirs, so
 * deleting any of them removes it. Anything that repeats a suppressed text is dropped, near-duplicates are
 * merged, and each section is capped (8 profile notes, 10 commitments, 6 open questions, 5 advice
 * notes). Previous commitments the model left out are kept: only an explicit "done" or "dropped" closes
 * one, so a forgetful model never silently loses a founder's commitment. The 10-commitment cap never
 * drops an open or person-edited commitment: closed ones go first, and new ones beyond the cap are
 * refused (both counted in `stats`). Open commitments come first (soonest due first), then closed ones.
 */
export function sanitizeDistill(draft: DistillDraft, ctx: DistillSanitizeContext): SanitizedDistill | null {
  const L = DISTILL_LIMITS;
  const stats: DistillStats = {
    suppressedDropped: 0,
    duplicatesDropped: 0,
    pinnedKept: 0,
    pinnedRewritesDropped: 0,
    commitmentsDropped: 0,
    commitmentsRefused: 0,
    memoryCandidatesDropped: 0,
    lessonCandidatesDropped: 0,
    lessonDropReasons: [],
    identityRewrites: 0,
    untakenOpenerDropped: 0,
  };
  const identity = {
    personaName: ctx.personaName,
    eirNames: ctx.eirNames,
    ...(ctx.personaEirName !== undefined ? { personaEirName: ctx.personaEirName } : {}),
  };
  // Cut to the limit (plus a sentence of margin) before the identity check, so an over-long field cannot
  // make it expensive; the result is bounded again after the rewrite.
  const clean = (value: string, max: number): string => {
    const plain = sanitizePlainText(value).text.replace(/\s+/g, ' ').trim();
    const rewrite = rewriteIdentity(truncate(plain, max + IDENTITY_MARGIN_CHARS), identity);
    stats.identityRewrites += rewrite.findings.length;
    return truncate(rewrite.text, max);
  };
  const suppressed = (ctx.suppressed ?? []).map((s) => s.trim()).filter((s) => s !== '');
  const isCommonWord = (word: string): boolean => COMMON_WORDS.has(word);
  const mentionsSuppressed = (text: string): boolean =>
    suppressed.some((s) => repeatsNote(text, s, isCommonWord));
  const pinned = new Set(ctx.pinnedEntryIds ?? []);
  const previous = ctx.previousNotebook ?? null;
  /** Model-written texts kept in the result: scanned for other ventures before anything is returned. */
  const fresh: string[] = [];
  const usedIds = new Set<string>(
    previous
      ? [
          ...previous.founderProfile,
          ...previous.commitments,
          ...previous.openQuestions,
          ...previous.lastAdvice,
        ].map((e) => e.id)
      : [],
  );
  const newId = (prefix: string, text: string): string => {
    const base = `${prefix}-${fnv1a(`${ctx.sessionId}|${prefix}|${textKey(text)}`).toString(36)}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };

  // Title and digest ------------------------------------------------------------------------------
  const title = titleText(clean(draft.title, L.titleMaxChars * 2), L.titleMaxChars);
  if (title !== '') fresh.push(title);

  const uniqueTexts = (values: readonly string[], max: number, maxChars: number): string[] => {
    const out: string[] = [];
    for (const value of values) {
      const text = clean(value, maxChars);
      if (text === '' || out.some((o) => isNearDuplicate(o, text))) continue;
      out.push(text);
    }
    return out.slice(0, max);
  };
  const digestCommitments: ConversationDigest['commitments'] = [];
  for (const c of draft.digest.commitments) {
    const text = clean(c.text, L.commitmentMaxChars);
    if (text === '' || digestCommitments.some((d) => isNearDuplicate(d.text, text))) continue;
    const due = c.due?.trim() ?? null;
    digestCommitments.push({ text, due: isIsoDate(due) ? due : null });
  }
  const digest: ConversationDigest = {
    summary: clean(draft.digest.summary, L.digestSummaryMaxChars),
    topics: uniqueTexts(draft.digest.topics, L.topicsMax, L.topicMaxChars),
    commitments: digestCommitments.slice(0, L.digestCommitmentsMax),
    openQuestions: uniqueTexts(draft.digest.open_questions, L.digestOpenQuestionsMax, L.openQuestionMaxChars),
    generatedAt: ctx.now,
  };
  fresh.push(
    digest.summary,
    ...digest.topics,
    ...digest.commitments.map((c) => c.text),
    ...digest.openQuestions,
  );

  // Notebook ----------------------------------------------------------------------------------------
  const mergeEntries = (
    prefix: string,
    proposed: readonly DistillNote[],
    before: readonly NotebookEntry[],
    max: number,
  ): NotebookEntry[] => {
    const kept = before.filter((e) => pinned.has(e.id));
    const out: NotebookEntry[] = kept.map((e) => ({ ...e }));
    stats.pinnedKept += out.length;
    for (const note of proposed) {
      const text = clean(note.text, L.entryMaxChars);
      if (text === '') continue;
      const key = textKey(text);
      // A person's edit is final: the model may neither reword it (same id) nor restate it. Echoing it
      // unchanged is expected and not counted.
      const pinnedMatch = kept.find(
        (e) => e.id === note.id || textKey(e.text) === key || isNearDuplicate(e.text, text),
      );
      if (pinnedMatch !== undefined || (note.id !== null && pinned.has(note.id))) {
        if (pinnedMatch === undefined || textKey(pinnedMatch.text) !== key) stats.pinnedRewritesDropped += 1;
        continue;
      }
      const byId = note.id === null ? undefined : before.find((e) => e.id === note.id);
      const same =
        byId !== undefined && textKey(byId.text) === key ? byId : before.find((e) => textKey(e.text) === key);
      if (out.some((e) => isNearDuplicate(e.text, text))) {
        stats.duplicatesDropped += 1;
        continue;
      }
      if (same !== undefined) {
        out.push({ ...same }); // unchanged: same id, creation time and source conversation
        continue;
      }
      if (mentionsSuppressed(text)) {
        stats.suppressedDropped += 1;
        continue;
      }
      // The entry it rewords (same id, or a near-duplicate): its conversations stay sources of the new text.
      const origin = byId ?? before.find((e) => !pinned.has(e.id) && isNearDuplicate(e.text, text));
      out.push({ id: newId(prefix, text), text, ...drawnFrom(origin, ctx.sessionId), createdAt: ctx.now });
      fresh.push(text);
    }
    return out.slice(0, max);
  };

  const mergeCommitments = (
    proposed: readonly DistillCommitment[],
    before: readonly NotebookCommitment[],
  ): NotebookCommitment[] => {
    const out: NotebookCommitment[] = [];
    const merged = new Set<string>();
    for (const c of proposed) {
      const text = clean(c.text, L.commitmentMaxChars);
      if (text === '') continue;
      const rawDue = c.due?.trim() ?? null;
      const due = isIsoDate(rawDue) ? rawDue : null;
      const prev =
        (c.id === null ? undefined : before.find((p) => p.id === c.id)) ??
        before.find((p) => isNearDuplicate(p.text, text));
      if (prev === undefined && c.id !== null && pinned.has(c.id)) {
        stats.pinnedRewritesDropped += 1;
        continue;
      }
      if (prev !== undefined) {
        if (merged.has(prev.id)) {
          stats.duplicatesDropped += 1;
          continue;
        }
        merged.add(prev.id);
        if (pinned.has(prev.id)) {
          // A person's edit is final: whatever the model proposes for it is dropped.
          if (
            textKey(prev.text) !== textKey(text) ||
            c.status !== prev.status ||
            (due !== null && due !== prev.due)
          )
            stats.pinnedRewritesDropped += 1;
          out.push({ ...prev });
          stats.pinnedKept += 1;
          continue;
        }
        const reworded = textKey(prev.text) !== textKey(text) && !mentionsSuppressed(text);
        if (reworded) fresh.push(text);
        const next = { text: reworded ? text : prev.text, due: due ?? prev.due, status: c.status };
        // Reworded, re-dated or closed here: what it says now comes from this conversation too.
        const changed = next.text !== prev.text || next.due !== prev.due || next.status !== prev.status;
        out.push(
          changed
            ? { ...withoutSources(prev), ...next, ...drawnFrom(prev, ctx.sessionId) }
            : { ...prev, ...next },
        );
        continue;
      }
      if (mentionsSuppressed(text)) {
        stats.suppressedDropped += 1;
        continue;
      }
      if (out.some((o) => isNearDuplicate(o.text, text))) {
        stats.duplicatesDropped += 1;
        continue;
      }
      out.push({
        id: newId('cm', text),
        text,
        due,
        status: c.status,
        sourceSessionId: ctx.sessionId,
        createdAt: ctx.now,
      });
      fresh.push(text);
    }
    // Commitments the model left out stay as they were.
    for (const p of before) {
      if (merged.has(p.id)) continue;
      out.push({ ...p });
      if (pinned.has(p.id)) stats.pinnedKept += 1;
    }
    // The cap never costs the founder a commitment: open and person-edited ones always stay, new ones
    // fill what room is left (soonest due first) and are refused beyond it, and closed ones go first.
    const existing = new Set(before.map((p) => p.id));
    const keeps = (c: NotebookCommitment): boolean =>
      existing.has(c.id) && (c.status === 'open' || pinned.has(c.id));
    const ordered = [...out].sort(byCommitmentOrder);
    let room = L.notebookCommitmentsMax - ordered.filter(keeps).length;
    const kept = new Set<NotebookCommitment>(ordered.filter(keeps));
    for (const c of ordered.filter((c) => !keeps(c) && c.status === 'open')) {
      if (room > 0) {
        kept.add(c);
        room -= 1;
      } else {
        stats.commitmentsRefused += 1;
      }
    }
    for (const c of ordered.filter((c) => !keeps(c) && c.status !== 'open')) {
      if (room > 0) {
        kept.add(c);
        room -= 1;
      } else {
        stats.commitmentsDropped += 1;
      }
    }
    return ordered.filter((c) => kept.has(c));
  };

  let summary: string;
  if (pinned.has(NOTEBOOK_SUMMARY_PIN) && previous !== null) {
    summary = previous.summary;
  } else {
    const kept = sentencesOf(clean(draft.notebook.summary, L.notebookSummaryMaxChars * 2)).filter((s) => {
      if (!mentionsSuppressed(s)) return true;
      stats.suppressedDropped += 1;
      return false;
    });
    summary = truncate(kept.join(' '), L.notebookSummaryMaxChars);
    if (summary !== '' && summary !== previous?.summary) fresh.push(summary);
  }

  let nextOpener: string | null;
  let nextTopic: string | null;
  if (pinned.has(NOTEBOOK_OPENER_PIN) && previous !== null) {
    // A person chose the opener: the thread stays whatever it was with it (a person's edit clears it).
    nextOpener = previous.nextOpener;
    nextTopic = previous.nextOpener === null ? null : (previous.nextTopic ?? null);
  } else {
    const opener =
      draft.notebook.next_opener === null ? '' : clean(draft.notebook.next_opener, L.nextOpenerMaxChars);
    if (opener !== '' && mentionsSuppressed(opener)) stats.suppressedDropped += 1;
    nextOpener = opener === '' || mentionsSuppressed(opener) ? null : opener;
    // The thread goes with the opener: a phrase on one line, never a question, never what a person removed.
    const raw = draft.notebook.next_topic ?? null;
    const topic =
      nextOpener === null || raw === null
        ? ''
        : clean(raw, L.nextTopicMaxChars)
            .replace(/[.!]+$/, '')
            .trim();
    if (topic !== '' && mentionsSuppressed(topic)) stats.suppressedDropped += 1;
    nextTopic = topic === '' || topic.endsWith('?') || mentionsSuppressed(topic) ? null : topic;
    // Never a thread the founder did not take up when it was raised, nor one kept from an earlier conversation that
    // this one never took up (lab run 39780304879: the opener re-opened the advisor session the founder ignored, and
    // a chat's distillation copied the previous opener word for word). The opener then picks up what the founder
    // brought instead (orchestrator/continuity.ts `chooseOpener`).
    if (nextOpener !== null && ctx.conversation !== undefined) {
      const untaken = untakenThreads(ctx.conversation, previous, ctx.previousOpenerSource, ctx.sessionId);
      const names = ctx.conversation.names ?? [];
      const said = ctx.conversation.founderTurns;
      const stale = (text: string | null): boolean =>
        text !== null &&
        untaken.some((thread) => isAboutThread(text, thread, names)) &&
        !mentions(threadWords(text, names), said);
      if (stale(nextTopic) || stale(nextOpener)) {
        nextOpener = null;
        nextTopic = null;
        stats.untakenOpenerDropped = 1;
      }
    }
    if (nextOpener !== null && nextOpener !== previous?.nextOpener) fresh.push(nextOpener);
    if (nextTopic !== null && nextTopic !== previous?.nextTopic) fresh.push(nextTopic);
  }

  const notebookDelta: NotebookDelta = {
    summary,
    founderProfile: mergeEntries(
      'fp',
      draft.notebook.founder_profile,
      previous?.founderProfile ?? [],
      L.founderProfileMax,
    ),
    commitments: mergeCommitments(draft.notebook.commitments, previous?.commitments ?? []),
    openQuestions: mergeEntries(
      'oq',
      draft.notebook.open_questions,
      previous?.openQuestions ?? [],
      L.notebookOpenQuestionsMax,
    ),
    lastAdvice: mergeEntries('la', draft.notebook.last_advice, previous?.lastAdvice ?? [], L.lastAdviceMax),
    nextOpener,
    nextTopic,
  };

  // Memory candidates ------------------------------------------------------------------------------------
  const evidenceKeys = new Set([...(ctx.evidenceKeys ?? [])].map((k) => k.trim().toUpperCase()));
  const memoryCandidates: MemoryCandidate[] = [];
  for (const m of draft.memory_candidates) {
    const title = clean(m.title, L.memoryTitleMaxChars);
    const content = clean(m.content, L.memoryContentMaxChars);
    const repeats =
      title === '' ||
      content === '' ||
      memoryCandidates.length >= L.memoryCandidatesMax ||
      (ctx.existingMemory ?? []).some(
        (e) => isNearDuplicate(e.title, title) || isNearDuplicate(e.content, content),
      ) ||
      memoryCandidates.some((x) => isNearDuplicate(x.title, title) || isNearDuplicate(x.content, content));
    if (repeats || mentionsSuppressed(title) || mentionsSuppressed(content)) {
      stats.memoryCandidatesDropped += 1;
      continue;
    }
    const ids: string[] = [];
    for (const raw of m.evidence_ids) {
      const key = raw
        .trim()
        .replace(/^\[|\]$/g, '')
        .toUpperCase();
      if (evidenceKeys.has(key) && !ids.includes(key)) ids.push(key);
    }
    memoryCandidates.push({
      type: m.type,
      title,
      content,
      evidence_ids: ids,
      confidence: Number.isFinite(m.confidence) ? Math.min(1, Math.max(0, m.confidence)) : 0.5,
      ...(m.source === undefined || m.source === null ? {} : { source: m.source }),
    });
    fresh.push(title, content);
  }

  // Lesson candidates ------------------------------------------------------------------------------------
  const lessonContext: LessonDeidentifyContext = {
    ventureNames: [...ctx.lessons.ventureNames, ...ctx.otherVentureNames],
    personNames: [...ctx.lessons.personNames, ...(ctx.otherVentureMemberNames ?? []), ...ctx.eirNames],
    canaries: [...ctx.lessons.canaries, ...ctx.otherVentureCanaries],
    ...(ctx.lessons.denylist ? { denylist: ctx.lessons.denylist } : {}),
    ...(ctx.lessons.allowedTerms ? { allowedTerms: ctx.lessons.allowedTerms } : {}),
  };
  const lessonCandidates: LessonCandidate[] = [];
  const reasons = new Set<DeidentifyReason>();
  for (const l of draft.lesson_candidates) {
    const lesson: LessonCandidate = {
      title: titleText(clean(l.title, L.lessonTitleMaxChars * 2), L.lessonTitleMaxChars),
      context: clean(l.context, L.lessonFieldMaxChars),
      signal: clean(l.signal, L.lessonFieldMaxChars),
      intervention: clean(l.intervention, L.lessonFieldMaxChars),
      outcome: clean(l.outcome, L.lessonFieldMaxChars),
      limits: clean(l.limits, L.lessonFieldMaxChars),
    };
    const fields = [
      lesson.title,
      lesson.context,
      lesson.signal,
      lesson.intervention,
      lesson.outcome,
      lesson.limits,
    ];
    if (lessonCandidates.length >= L.lessonCandidatesMax || fields.some((f) => f.length < 3)) {
      stats.lessonCandidatesDropped += 1;
      continue;
    }
    const check = checkDeidentified(fields, lessonContext, { titleIndex: 0 });
    if (!check.ok) {
      stats.lessonCandidatesDropped += 1;
      for (const reason of check.reasons) reasons.add(reason);
      continue;
    }
    if (lessonCandidates.some((x) => isNearDuplicate(x.title, lesson.title))) {
      stats.lessonCandidatesDropped += 1;
      continue;
    }
    lessonCandidates.push(lesson);
    fresh.push(...fields);
  }
  stats.lessonDropReasons = [...reasons].sort();

  // Cross-venture guard over everything newly written --------------------------------------------------
  if (
    textsContainOtherVenture(
      fresh,
      ctx.otherVentureNames,
      ctx.otherVentureCanaries,
      ctx.otherVentureMemberNames ?? [],
    )
  )
    return null;

  return {
    title: title === '' ? null : title,
    digest,
    notebookDelta,
    memoryCandidates,
    lessonCandidates,
    stats,
  };
}
