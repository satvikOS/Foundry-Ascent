import {
  MAX_PROMPT_DIGESTS,
  firstNameOf,
  isNearDuplicate,
  lastQuestionOf,
  rewriteIdentity,
  sanitizePlainText,
  textsContainOtherVenture,
  truncate,
  type PromptContinuity,
} from '@foundry/ai';
import { notebooksRepo, personasRepo, principalsRepo, sessionsRepo, type AppExecutor } from '@foundry/db';

import { mentionsEir } from '../internal/eir-names.js';
import {
  LEFT_OFF_CONVERSATIONS,
  LEFT_OFF_EXCHANGES,
  continuityOpener,
  newsSubjectOf,
  relativeWhen,
  subjectOf,
  threadOpener,
  threadSubject,
  type LeftOffConversationData,
  type LeftOffData,
  type LeftOffThreads,
  type OpenerSubject,
} from './continuity-prompt.js';
import { addressFounder, properNounsIn, topicWords, type OpenerPeople } from './opener-topic.js';

/**
 * What the vEIR remembers when a turn starts (the specific pool): the founder's first name, the notebook of
 * this venture × persona, the digests of the latest earlier conversations and, through the notebook, the open
 * commitments. Temporary chats remember nothing beyond the name: like a private window, they neither write
 * nor read the vEIR's notes.
 */
export interface LoadedContinuity {
  readonly continuity: PromptContinuity;
  /** Counts for audit metadata (no content). */
  readonly notebook: boolean;
  readonly digests: number;
}

export async function loadContinuity(
  tx: AppExecutor,
  args: {
    readonly ventureId: string;
    readonly personaId: string;
    readonly sessionId: string;
    readonly principalId: string;
    readonly privacy: 'standard' | 'ephemeral';
  },
): Promise<LoadedContinuity> {
  const principal = await principalsRepo.getPrincipal(tx, args.principalId);
  const founderFirstName = principal ? firstNameOf(principal.displayName) : null;
  if (args.privacy === 'ephemeral') return { continuity: { founderFirstName }, notebook: false, digests: 0 };
  const notebook = await notebooksRepo.getNotebook(tx, {
    ventureId: args.ventureId,
    personaId: args.personaId,
  });
  // The venture's conversations with any of its vEIRs: a vEIR assigned later still knows what was said before
  // (one with an earlier coach is marked as that coach's). A turn leaves out the ones "Where you left off"
  // already shows ({@link withoutLeftOff}), so a few more are read than are shown.
  const digests = await sessionsRepo.listRecentDigests(tx, {
    ventureId: args.ventureId,
    excludeSessionId: args.sessionId,
    limit: MAX_PROMPT_DIGESTS + LEFT_OFF_CONVERSATIONS,
  });
  return {
    continuity: {
      founderFirstName,
      notebook: notebook ? { ...notebook.content, updatedAt: notebook.updatedAt } : null,
      recentDigests: digests.map((d) => ({
        sessionId: d.sessionId,
        otherCoach: d.personaId !== args.personaId,
        date: d.lastActivityAt,
        title: d.title,
        channel: d.hasCalls ? 'voice' : 'text',
        digest: {
          summary: d.digest.summary,
          topics: d.digest.topics,
          commitments: d.digest.commitments,
          openQuestions: d.digest.openQuestions,
        },
      })),
    },
    notebook: notebook !== null,
    digests: Math.min(MAX_PROMPT_DIGESTS, digests.length),
  };
}

/**
 * The vEIR's notes without the digests of the conversations "Where you left off" already shows (the same
 * conversation is never sent twice in one prompt), at most {@link MAX_PROMPT_DIGESTS} of them.
 */
export function withoutLeftOff(continuity: PromptContinuity, leftOff: LeftOffData | null): PromptContinuity {
  const digests = continuity.recentDigests;
  if (digests === undefined) return continuity;
  const shown = new Set((leftOff?.conversations ?? []).map((c) => c.sessionId));
  return {
    ...continuity,
    recentDigests: digests
      .filter((d) => d.sessionId === undefined || !shown.has(d.sessionId))
      .slice(0, MAX_PROMPT_DIGESTS),
  };
}

/** Names the opener is checked against (the turn validators' guards). */
export interface OpenerGuards {
  readonly personaName: string;
  readonly personaEirName: string | null;
  readonly eirNames: readonly string[];
  readonly otherVentureNames: readonly string[];
  readonly otherVentureCanaries: readonly string[];
  readonly otherVentureMemberNames: readonly string[];
}

/** Longest stored opener (`coaching_sessions.opener`). */
export const MAX_OPENER_CHARS = 300;

/** Why an opener cannot be said by the vEIR (null: it can). */
export type OpenerProblem = 'not_plain' | 'too_long' | 'identity' | 'other_venture';

/** The checks every opener passes, on its plain one-line form. */
function openerChecks(opener: string, guards: OpenerGuards): 'identity' | 'other_venture' | null {
  const identity = rewriteIdentity(opener, {
    personaName: guards.personaName,
    eirNames: guards.eirNames,
    personaEirName: guards.personaEirName,
  });
  if (identity.findings.length > 0) return 'identity';
  // The rewrite misses third-person endorsement, review and presence claims ("Corin asked me to check in"),
  // so an opener that names an EIR at all is left out, as the call intro does (it speaks this opener).
  if (mentionsEir(opener, guards.eirNames)) return 'identity';
  if (
    textsContainOtherVenture(
      [opener],
      guards.otherVentureNames,
      guards.otherVentureCanaries,
      guards.otherVentureMemberNames,
    )
  ) {
    return 'other_venture';
  }
  return null;
}

/** The text as one plain line (markup and control characters removed, whitespace collapsed). */
function plainLine(text: string): string {
  return sanitizePlainText(text).text.replace(/\s+/g, ' ').trim();
}

/**
 * The notebook's next opener as the vEIR may say it: plain text on one line, at most 300 characters. It is
 * dropped (null) when it would speak as the EIR, claim to be human or approve anything, names an EIR, or names
 * another venture, member or canary: a person can edit the notebook, and the opener is shown and spoken as the
 * vEIR (the first bubble of the conversation and the call intro).
 */
export function validatedOpener(text: string | null | undefined, guards: OpenerGuards): string | null {
  if (!text) return null;
  const plain = plainLine(text);
  if (plain === '') return null;
  const opener = truncate(plain, MAX_OPENER_CHARS);
  return openerChecks(opener, guards) === null ? opener : null;
}

/**
 * The same rules for an opener a person writes in the notebook (`edit_opener`), which are refused instead of
 * dropped later: the line must already be plain text on one line within 300 characters, and pass every check
 * {@link validatedOpener} applies at the start of a conversation and of a call.
 */
export function openerProblem(text: string, guards: OpenerGuards): OpenerProblem | null {
  const plain = plainLine(text);
  if (plain === '' || plain !== text.replace(/\s+/g, ' ').trim() || /[\r\n]/.test(text.trim())) {
    return 'not_plain';
  }
  if (plain.length > MAX_OPENER_CHARS) return 'too_long';
  return openerChecks(plain, guards);
}

/**
 * The data of "Where you left off" (orchestrator/continuity-prompt.ts) for a conversation of `principalId` in a
 * venture: keyed by the venture and the person, not by the vEIR (a venture's vEIR can change; each conversation
 * says whether it was with `personaId`). The person's own latest earlier conversation, and a teammate's when it
 * is more recent (or the newest teammate's when the person has none), each with its digest when distilled and
 * its last exchanges the digest does not cover yet. Two indexed statements (the conversations, then their
 * exchanges): the person's own conversation is read on its own, so any number of newer teammate conversations
 * never hides it. Null for a temporary chat (it neither reads nor writes the vEIR's memory) and when there is no
 * earlier conversation with a completed turn. Temporary and deleted conversations are never read; RLS keeps
 * other ventures out.
 */
export async function loadLeftOff(
  tx: AppExecutor,
  args: {
    readonly ventureId: string;
    readonly personaId: string;
    /** The current conversation (excluded); null when it does not exist yet (a new conversation's opener). */
    readonly sessionId: string | null;
    readonly principalId: string;
    readonly privacy: 'standard' | 'ephemeral';
    /** Only the person's own latest conversation (a new conversation's opener picks up the person's own). */
    readonly ownOnly?: boolean;
  },
): Promise<LeftOffData | null> {
  if (args.privacy === 'ephemeral') return null;
  const ownOnly = args.ownOnly === true;
  // Newest first: the person's own latest, and the newest teammate conversation (unless `ownOnly`).
  const recent = await sessionsRepo.listLeftOffConversations(tx, {
    ventureId: args.ventureId,
    principalId: args.principalId,
    excludeSessionId: args.sessionId,
    teammate: !ownOnly,
  });
  const ownIndex = recent.findIndex((c) => c.startedBy === args.principalId);
  // The person's own latest and a teammate's after it; without one of their own, the teammate's.
  const picked = (ownIndex < 0 ? recent.slice(0, 1) : recent.slice(0, ownIndex + 1)).slice(
    0,
    LEFT_OFF_CONVERSATIONS,
  );
  if (picked.length === 0) return null;
  // Every picked conversation's last exchanges: the ones its digest does not cover are shown as said, and the
  // founder's own lines of all of them are read for what they told (news, numbers, names, worries: LAB-R6b, RC-01).
  const exchanges = await sessionsRepo.listLastExchanges(tx, {
    sessionIds: picked.map((c) => c.id),
    perSession: LEFT_OFF_EXCHANGES,
  });
  return {
    conversations: picked.map((c) => ({
      sessionId: c.id,
      withCaller: c.startedBy === args.principalId,
      withThisVeir: c.personaId === args.personaId,
      teammateFirstName:
        c.startedBy === args.principalId || c.startedByName === null ? null : firstNameOf(c.startedByName),
      title: c.title,
      channel: c.hasCalls ? 'call' : 'chat',
      lastActivityAt: c.lastActivityAt,
      ended: c.status !== 'active',
      digest:
        c.digest === null
          ? null
          : {
              summary: c.digest.summary,
              topics: c.digest.topics,
              commitments: c.digest.commitments,
              openQuestions: c.digest.openQuestions,
            },
      // The completed turns the digest does not cover: the k-th from the end is turn completedTurns - k + 1.
      exchanges: exchanges
        .filter((x) => x.sessionId === c.id && c.completedTurns - x.fromEnd + 1 > c.distillVersion)
        .map((x) => ({ founder: x.founderText, answer: x.answer })),
      said: exchanges.filter((x) => x.sessionId === c.id).map((x) => x.founderText),
    })),
  };
}

/** Open threads of the notebook the turn already loaded (open commitments and open questions). */
export function leftOffThreads(continuity: PromptContinuity): LeftOffThreads | null {
  const nb = continuity.notebook ?? null;
  if (nb === null) return null;
  return {
    commitments: nb.commitments.filter((c) => c.status === 'open').map((c) => ({ text: c.text, due: c.due })),
    questions: nb.openQuestions.map((q) => q.text),
  };
}

/** The opening line of a new conversation, and where it came from (`coaching_sessions.opener` and its source). */
export interface ChosenOpener {
  readonly text: string;
  /** The conversation it was drawn from (deleting it erases this copy); null when a person wrote it. */
  readonly sourceSessionId: string | null;
  readonly byPerson: boolean;
  /**
   * What it is about, when it was phrased around a thread or the last conversation's subject (a call's greeting is
   * phrased around it in one sentence); null for a line that names nothing (the generic invitation); absent for a
   * stored sentence (a person's, or the notebook's), which a greeting reads itself (`readOpener`).
   */
  readonly subject?: OpenerSubject | null;
}

/** Exchanges read to tell whether a stored opener only repeats a question the vEIR already asked. */
const OPENER_ECHO_EXCHANGES = 3;

/**
 * The vEIR's opening line for a new standard conversation of `principalId` (its first bubble, and what a call says
 * after introducing itself), in this order:
 * 1. the notebook's next opener when a person wrote or rewrote it (they chose what to open with);
 * 2. when the notebook's opener is current (distillation drew it from the person's latest conversation, call or
 *    chat; for an opener of unknown origin, the notebook was written after that conversation's last turn with this
 *    vEIR): a line phrased afresh around the thread it noted to
 *    come back to (`nextTopic`: a topic, never a sentence to replay), else the stored sentence itself, unless it
 *    only repeats a question the vEIR asked at the end of that conversation (production: call 3 opened with call
 *    2's closing question, verbatim) or it already opened a conversation since in which nothing was said (it was
 *    said once; it is not said again word for word);
 * 3. a line that picks up the person's latest conversation itself, with any of the venture's vEIRs (when it was,
 *    what about), built without a model call from what was said, so it is right even before distillation ran
 *    (orchestrator/continuity-prompt.ts);
 * 4. an older notebook opener.
 * Every distilled line is said to the person (`addressFounder`: "maya will get" becomes "you will get"; a line still
 * in the third person is not said), with the team's names in their real case (`team`; LAB-U2). A notebook opener
 * drawn from a teammate's conversation is never said to the person as theirs ("Last time you planned…" was a
 * teammate's plan, MX-0005): it is skipped, and the person's own latest conversation, or nothing, opens.
 * Phrasing follows the latest conversation, the person and how many conversations they opened since it, so each
 * new conversation opens differently; a preview (no conversation yet) says what the next one opens with, and a
 * call starting in that conversation (`sessionId`, left out of the count) says it too. Every line must pass the
 * opener checks (identity, cross-venture): one that fails is skipped. `opener` is null when there is none (a
 * first conversation); `latest` is the conversation it picks up.
 */
export async function chooseOpener(
  tx: AppExecutor,
  args: {
    readonly ventureId: string;
    readonly persona: { readonly id: string; readonly name: string };
    readonly principalId: string;
    readonly guards: Omit<OpenerGuards, 'personaName' | 'personaEirName'>;
    readonly now: Date;
    /** The conversation the opener is for, when it exists already (a call starting in it). */
    readonly sessionId?: string | null;
    /** Display names of the venture's people, so a name in a distilled line keeps its real case. */
    readonly team?: readonly string[];
  },
): Promise<{ readonly opener: ChosenOpener | null; readonly latest: LeftOffConversationData | null }> {
  const notebook = await notebooksRepo.getNotebook(tx, {
    ventureId: args.ventureId,
    personaId: args.persona.id,
  });
  const guards: OpenerGuards = {
    ...args.guards,
    personaName: args.persona.name,
    personaEirName: await personasRepo.getPersonaEirName(tx, args.persona.id),
  };
  const principal = await principalsRepo.getPrincipal(tx, args.principalId);
  const last = await loadLeftOff(tx, {
    ventureId: args.ventureId,
    personaId: args.persona.id,
    sessionId: args.sessionId ?? null,
    principalId: args.principalId,
    privacy: 'standard',
    ownOnly: true,
  });
  const latest = last?.conversations[0] ?? null;
  // Names in their real case: the team's, and the proper nouns the vEIR wrote in that conversation (item 2: the
  // founder's lower case, "the harbour hall study room", is never said back as typed).
  const people: OpenerPeople = {
    founder: principal?.displayName ?? null,
    team: args.team ?? [],
    names:
      latest === null
        ? []
        : properNounsIn([
            ...latest.exchanges.map((x) => x.answer ?? ''),
            latest.digest?.summary ?? '',
            ...(latest.digest?.topics ?? []),
          ]),
  };
  const next = notebook?.content.nextOpener ?? null;
  // The distillation writes about the founder; the opener speaks to them.
  const stored = next === null ? null : validatedOpener(addressFounder(next, people), guards);
  // The conversation it was drawn from, so deleting that conversation erases this copy too. A null source means
  // a person wrote it (the copy stays); a missing one means its origin is unknown, and deleting any conversation
  // of the venture erases the copy.
  const source = notebook?.content.nextOpenerSource;
  const found = (opener: ChosenOpener | null) => ({ opener, latest });
  // Drawn from a conversation someone else had (a teammate's plan): never said to this person as theirs.
  const fromSomeoneElse =
    source != null && (await sessionsRepo.getSession(tx, source))?.startedBy !== args.principalId;
  // A person wrote it, or rewrote it since the vEIR last wrote the notebook: they chose these words.
  const chosen =
    stored !== null &&
    (source === null ||
      (
        await notebooksRepo.getNotebookMarks(tx, { ventureId: args.ventureId, personaId: args.persona.id })
      ).personEdits.includes(notebooksRepo.OPENER_EDIT));
  if (stored !== null && chosen && !fromSomeoneElse)
    return found({ text: stored, sourceSessionId: source ?? null, byPerson: source === null });
  // Conversations the person opened since the latest one without saying anything: each opens differently, and
  // the stored line, once said in one of them, is not said again word for word.
  const since =
    latest === null
      ? { opened: 0, withOpener: 0 }
      : await sessionsRepo.countConversationsOpenedSince(tx, {
          ventureId: args.ventureId,
          principalId: args.principalId,
          since: latest.lastActivityAt,
          excludeSessionId: args.sessionId ?? null,
          opener: stored,
        });
  const seed = `${latest?.sessionId ?? 'first'}:${args.principalId}:${String(since.opened)}`;
  // Current: drawn from the person's latest conversation, call or chat. Only an opener of unknown origin is judged by
  // when the notebook was written: one drawn from an older conversation is never current, however late its
  // distillation finished (LAB-R6c: a call right after a chat opened with the earlier call's topic, because the
  // call's distillation wrote the notebook after the chat's last turn).
  const current =
    latest === null ||
    source === latest.sessionId ||
    (source === undefined &&
      latest.withThisVeir &&
      notebook?.updatedAt != null &&
      Date.parse(notebook.updatedAt) > Date.parse(latest.lastActivityAt));
  // A stored sentence's subject is read from it (undefined); a line phrased around a thread carries its own.
  const drawn = (text: string, subject?: OpenerSubject | null): ChosenOpener => ({
    text,
    sourceSessionId: source ?? null,
    byPerson: false,
    ...(subject === undefined ? {} : { subject }),
  });
  // The founder's news in their latest conversation comes first: a stored line that does not name it (the coach's
  // framing, "anchoring the pilot price") gives way to a line around the news (LAB-R6b).
  const news = latest === null ? null : newsSubjectOf(latest, people);
  const namesNews =
    news === null ||
    topicWords(`${stored ?? ''} ${notebook?.content.nextTopic ?? ''}`).some((w) =>
      topicWords(news.text).includes(w),
    );
  if (stored !== null && current && !fromSomeoneElse && namesNews) {
    const topic = notebook?.content.nextTopic ?? null;
    const around =
      topic === null
        ? null
        : validatedOpener(
            threadOpener(topic, {
              seed,
              people,
              when:
                latest !== null && source === latest.sessionId
                  ? relativeWhen(latest.lastActivityAt, args.now)
                  : null,
            }),
            guards,
          );
    const thread = topic === null ? null : threadSubject(topic, people);
    if (around !== null)
      return found(drawn(around, thread === null ? null : { kind: 'thread', text: thread }));
    if (since.withOpener === 0 && !(latest !== null && (await askedAtTheEnd(tx, latest.sessionId, stored)))) {
      return found(drawn(stored));
    }
  }
  if (latest !== null) {
    const lines = continuityOpener(latest, { now: args.now, seed, people });
    const subject = latest.withThisVeir ? subjectOf(latest, people) : null;
    for (const [candidate, about] of [
      [lines.withTopic, subject],
      [lines.generic, null],
    ] as const) {
      const text = candidate === null ? null : validatedOpener(candidate, guards);
      if (text !== null)
        return found({ text, sourceSessionId: latest.sessionId, byPerson: false, subject: about });
    }
  }
  return found(stored === null || fromSomeoneElse ? null : drawn(stored));
}

/** Whether `opener` repeats a question the vEIR asked in one of the last answers of the conversation. */
async function askedAtTheEnd(tx: AppExecutor, sessionId: string, opener: string): Promise<boolean> {
  const exchanges = await sessionsRepo.listLastExchanges(tx, {
    sessionIds: [sessionId],
    perSession: OPENER_ECHO_EXCHANGES,
  });
  return exchanges.some((x) => {
    const question = x.answer === null ? null : lastQuestionOf(x.answer);
    return question !== null && (isNearDuplicate(opener, question, 0.6) || opener.includes(question));
  });
}
