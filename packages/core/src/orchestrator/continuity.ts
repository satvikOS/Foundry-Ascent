import type { StudentProfile } from '@foundry/contracts';
import {
  MAX_PROMPT_DIGESTS,
  bringsOwnSubject,
  firstNameOf,
  isAboutThread,
  isNearDuplicate,
  isPersonalOpener,
  lastQuestionOf,
  mentions,
  namesAThread,
  notebookThreads,
  raisedIn,
  rewriteIdentity,
  sanitizePlainText,
  textsContainOtherVenture,
  threadWords,
  truncate,
  untakenThread,
  type PromptContinuity,
} from '@foundry/ai';
import {
  studentRepo,
  notebooksRepo,
  personasRepo,
  principalsRepo,
  sessionsRepo,
  type AppExecutor,
  type ReadPart,
} from '@foundry/db';

import { mentionsEir } from '../internal/eir-names.js';
import { addressFounder, properNounsIn, type OpenerPeople } from './address-founder.js';
import {
  LEFT_OFF_CONVERSATIONS,
  LEFT_OFF_EXCHANGES,
  plainOpeners,
  type LeftOffConversationData,
  type LeftOffData,
  type LeftOffDigest,
  type LeftOffThreads,
} from './continuity-prompt.js';

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

/** Who and what {@link continuityParts} reads for. */
export interface ContinuityKeys {
  readonly ventureId: string;
  readonly personaId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly privacy: 'standard' | 'ephemeral';
}

/**
 * The reads of what the vEIR remembers when a turn starts, made in one statement with the turn's other reads
 * (`turn-context.ts`; {@link continuityFrom} assembles them): the founder, and unless the chat is temporary the
 * notebook and the earlier conversations' digests.
 */
export function continuityParts(args: ContinuityKeys): {
  readonly principal: ReadPart<principalsRepo.PrincipalRecord | null>;
  readonly student?: ReturnType<typeof studentRepo.studentProfilePart>;
  readonly notebook?: ReadPart<notebooksRepo.NotebookRecord | null>;
  readonly digests?: ReadPart<sessionsRepo.RecentDigest[]>;
} {
  const principal = principalsRepo.principalPart(args.principalId);
  if (args.privacy === 'ephemeral') return { principal };
  return {
    principal,
    student: studentRepo.studentProfilePart(args.ventureId),
    notebook: notebooksRepo.notebookPart({ ventureId: args.ventureId, personaId: args.personaId }),
    // The venture's conversations with any of its vEIRs: a vEIR assigned later still knows what was said before
    // (one with an earlier coach is marked as that coach's). A turn leaves out the ones "Where you left off"
    // already shows ({@link withoutLeftOff}), so a few more are read than are shown.
    digests: sessionsRepo.recentDigestsPart({
      ventureId: args.ventureId,
      excludeSessionId: args.sessionId,
      limit: MAX_PROMPT_DIGESTS + LEFT_OFF_CONVERSATIONS,
    }),
  };
}

/** What the vEIR remembers, from the reads of {@link continuityParts}. */
export function continuityFrom(
  args: ContinuityKeys,
  reads: {
    readonly principal: principalsRepo.PrincipalRecord | null;
    readonly student?: StudentProfile | null;
    readonly notebook?: notebooksRepo.NotebookRecord | null;
    readonly digests?: readonly sessionsRepo.RecentDigest[];
  },
): LoadedContinuity {
  const { principal } = reads;
  const founderFirstName = principal ? firstNameOf(principal.displayName) : null;
  if (args.privacy === 'ephemeral') return { continuity: { founderFirstName }, notebook: false, digests: 0 };
  const notebook = reads.notebook ?? null;
  const digests = reads.digests ?? [];
  return {
    continuity: {
      founderFirstName,
      studentProfile: reads.student ?? null,
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
      opener: c.opener,
      replies: [
        ...exchanges
          .filter((x) => x.sessionId === c.id)
          .sort((a, b) => a.fromEnd - b.fromEnd)
          .map((x) => x.answer),
        c.opener,
      ].filter((t): t is string => t !== null && t.trim() !== ''),
    })),
  };
}

/**
 * The vEIR's replies at the end of the person's own latest conversations with it, newest first (coaching v3): what
 * the phrasing ledger and the name budget read beyond this conversation (prompts/phrasing.ts, validators/openers.ts).
 * A teammate's conversation, or one with another coach, is not the person's own exchange with this vEIR.
 */
export function pastRepliesOf(leftOff: LeftOffData | null): string[] {
  return (leftOff?.conversations ?? [])
    .filter((c) => c.withCaller && c.withThisVeir)
    .flatMap((c) => c.replies ?? []);
}

/**
 * Open threads of the notebook the turn already loaded (open commitments and open questions), for "Where you left off",
 * held to the rules the notes keep (prompts/messages.ts `buildMessages`): once the conversation is under way, a message
 * with a subject of the founder's own gets none of them (`bringsOwnSubject`), and one the vEIR already raised in this
 * conversation is marked so (`raisedIn`). Production, 2026-11-07: the notes left their agenda out of every turn of a
 * call while this section still listed it, and the third reply asked the first one's question again. `turn`: the
 * founder's message, what the vEIR said in this conversation (its replies and the opener) and whether it is under way;
 * absent, every open thread is listed.
 */
export function leftOffThreads(
  continuity: PromptContinuity,
  turn?: {
    readonly founderText: string;
    readonly said: readonly (string | null | undefined)[];
    readonly started: boolean;
  },
): LeftOffThreads | null {
  const nb = continuity.notebook ?? null;
  if (nb === null) return null;
  if (turn !== undefined && turn.started && bringsOwnSubject(turn.founderText, continuity)) return null;
  const commitments = nb.commitments
    .filter((c) => c.status === 'open')
    .map((c) => ({ text: c.text, due: c.due }));
  const questions = nb.openQuestions.map((q) => q.text);
  const said = turn?.said ?? [];
  return {
    commitments,
    questions,
    raised: [...commitments.map((c) => c.text), ...questions].filter((text) => raisedIn(text, said)),
  };
}

/**
 * What a notebook lacks for an opener: a line the model wrote for this conversation, while it holds open threads (its
 * line is missing, cannot be said, or was written before the person's latest conversation). The caller has the model
 * write one (services/distill.ts `writeOpener`) and chooses again.
 */
export interface MissingOpener {
  /** The person's latest conversation: the line is drawn from it (deleting it erases the line). */
  readonly sourceSessionId: string;
  /** What that conversation opened with: never said again. */
  readonly lastOpener: string | null;
  /**
   * Threads the founder left aside, never opened on again: what that conversation opened with when they did not take it
   * up, and the notebook's line and thread when that conversation never touched them (lab run 39780304879).
   */
  readonly leftAside: readonly string[];
}

/** The opening line of a new conversation, and where it came from (`coaching_sessions.opener` and its source). */
export interface ChosenOpener {
  readonly text: string;
  /** The conversation it was drawn from (deleting it erases this copy); null when a person wrote it. */
  readonly sourceSessionId: string | null;
  readonly byPerson: boolean;
}

/** Exchanges read to tell whether a stored opener only repeats a question the vEIR already asked. */
const OPENER_ECHO_EXCHANGES = 3;
/** Founder messages read to tell whether they took up what their latest conversation opened with. */
const TAKE_UP_EXCHANGES = 20;

/**
 * The vEIR's opening line for a new standard conversation of `principalId` (its first bubble, and what a call says),
 * in this order:
 * 1. the notebook's next opener when a person wrote or rewrote it (they chose what to open with);
 * 2. the model-written line (coaching v3, owner round 3: what an opener is about is the model's choice, written at
 *    distillation from that conversation and the notebook's open threads, so it costs no model call here), when it is
 *    current (drawn from the person's latest conversation, call or chat; for a line of unknown origin, the notebook
 *    was written after that conversation's last turn with this vEIR), unless it only repeats a question the vEIR asked
 *    at the end of that conversation (production: call 3 opened with call 2's closing question, verbatim), it already
 *    opened a conversation since in which nothing was said (it was said once; it is not said again word for word), it
 *    opens the way that conversation opened ({@link repeatsOpener}), or it comes back to a thread that conversation
 *    opened on and the founder never took up there (none of their messages holds two of its words, nor did they answer
 *    it with a short yes: `@foundry/ai` `untakenThread`; lab run 39780304879, production 2026-10-16…20), or it is one
 *    a mentor never opens on (personal, small talk, the scripted frame: `isPersonalOpener`; or a line that names no
 *    thread the notebook or that conversation left open: `namesAThread`);
 * 3. else, for someone who has talked here before, a short, warm greeting that names no subject (`plainOpeners`),
 *    phrased for this conversation and never the way the last ones opened. Nothing the founder said is ever read by
 *    rule for what to open on (production 2026-11-06: the previous call held only "great" and "hows your perosnal life
 *    going on..", and the next call opened "Hi, want to carry on with your perosnal life?").
 * Every distilled line is said to the person (`addressFounder`: "maya will get" becomes "you will get"; a line still
 * in the third person is not said), with the team's names in their real case (`team`; LAB-U2). A notebook opener
 * drawn from a teammate's conversation is never said to the person as theirs ("Last time you planned…" was a
 * teammate's plan, MX-0005). A preview (no conversation yet) says what the next one opens with, and a call starting
 * in that conversation (`sessionId`, left out of the count) says it too. Every line must pass the opener checks
 * (identity, cross-venture): one that fails is skipped. `opener` is null when there is none (a first conversation
 * without a notebook line); `latest` is the person's latest conversation. `missing` says when the greeting that names
 * nothing was chosen although the notebook holds open threads and has no current line of the model's
 * ({@link MissingOpener}; production, 2026-11-07: a notebook distilled from a small-talk call before the next-opener
 * rule held opened the next call with "Nice to see you. What feels most pressing right now?").
 */
export async function chooseOpener(
  tx: AppExecutor,
  args: {
    readonly ventureId: string;
    readonly persona: { readonly id: string; readonly name: string };
    readonly principalId: string;
    readonly guards: Omit<OpenerGuards, 'personaName' | 'personaEirName'>;
    /** The conversation the opener is for, when it exists already (a call starting in it). */
    readonly sessionId?: string | null;
    /** Display names of the venture's people, so a name in a distilled line keeps its real case. */
    readonly team?: readonly string[];
  },
): Promise<{
  readonly opener: ChosenOpener | null;
  readonly latest: LeftOffConversationData | null;
  /** The vEIR's replies at the end of the person's latest conversations with it, newest first ({@link pastRepliesOf}). */
  readonly pastReplies: readonly string[];
  readonly missing: MissingOpener | null;
}> {
  const notebook = await notebooksRepo.getNotebook(tx, {
    ventureId: args.ventureId,
    personaId: args.persona.id,
  });
  const guards: OpenerGuards = {
    ...args.guards,
    personaName: args.persona.name,
    personaEirName: await personasRepo.getPersonaTwinEirName(tx, args.persona.id),
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
  // Names in their real case: the team's, and the proper nouns the vEIR wrote in that conversation (item 2).
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
  const pastReplies = pastRepliesOf(last);
  const found = (opener: ChosenOpener | null, missing: MissingOpener | null = null) => ({
    opener,
    latest,
    pastReplies,
    missing,
  });
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
  // What the latest conversation opened on, when the founder never took it up there: not opened on again.
  const names = [
    principal?.displayName ?? null,
    args.persona.name,
    guards.personaEirName,
    ...guards.eirNames,
  ].filter((n): n is string => n !== null && n !== '');
  const heard = latest === null ? null : await founderLinesOf(tx, latest.sessionId);
  const untaken = latest === null || heard === null ? null : untakenOpening(latest, heard, names);
  const reopens = (text: string | null | undefined): boolean =>
    untaken !== null && text !== null && text !== undefined && isAboutThread(text, untaken, names);
  const topic = notebook?.content.nextTopic ?? null;
  // Conversations the person opened since the latest one without saying anything: each opens differently, and
  // the stored line, once said in one of them, is not said again word for word.
  const since =
    latest === null
      ? { opened: 0, withOpener: 0 }
      : await sessionsRepo.countConversationsOpenedSince(tx, {
          ventureId: args.ventureId,
          principalId: args.principalId,
          since: latest.lastActivityAt,
          // PostgreSQL timestamps retain microseconds; decoded JS dates retain milliseconds. Never
          // count the source itself as a newly opened conversation because of that precision loss.
          afterSessionId: latest.sessionId,
          excludeSessionId: args.sessionId ?? null,
          opener: stored,
        });
  // Current: drawn from the person's latest conversation, call or chat; or written after that conversation's last
  // turn once the latest conversation itself was distilled (its distillation saw the opener and kept it), or when the
  // opener's origin is unknown. An opener drawn from an older conversation is never current while the latest one is
  // not distilled, however late the older one's distillation finished (LAB-R6c: a call right after a chat opened with
  // the earlier call's topic, because the call's distillation wrote the notebook after the chat's last turn).
  const latestDistilled = latest !== null && latest.digest !== null && latest.exchanges.length === 0;
  // Kept by the latest conversation's distillation only when the founder spoke of that thread there: one an older
  // conversation left that the latest never touched is stale, however recently it was written back (lab run
  // 39780304879: a chat's distillation copied the previous opener, and the next chat opened on it again).
  const kept = threadWords(topic ?? next ?? '', names);
  const keptByLatest = kept.size === 0 || mentions(kept, heard?.lines ?? []);
  const current =
    latest === null ||
    source === latest.sessionId ||
    ((source === undefined || (latestDistilled && keptByLatest)) &&
      latest.withThisVeir &&
      notebook?.updatedAt != null &&
      Date.parse(notebook.updatedAt) > Date.parse(latest.lastActivityAt));
  // The notebook's line or thread comes back to what the founder left aside: neither is said.
  const leftAside = reopens(next) || reopens(topic);
  // A line stored before the distillation's check (or that slipped past it): never personal, small talk or the
  // scripted frame, and always about a thread the venture still has.
  const sound =
    stored !== null &&
    !isPersonalOpener(stored) &&
    namesAThread(
      stored,
      openThreads(notebook?.content ?? null, latest?.digest ?? null, heard?.lines ?? []),
      names,
    );
  // The model's own line (coaching v3, owner round 3: openers are model-written, never a template), said unless it was
  // already said in a conversation opened since, only repeats the question that conversation ended on, or opens the
  // way that conversation opened (never the same opener twice in a row). No model call here: the line was written
  // ahead, so the greeting costs nothing at page load or call start.
  if (
    stored !== null &&
    sound &&
    current &&
    !fromSomeoneElse &&
    !leftAside &&
    since.withOpener === 0 &&
    !repeatsOpener(stored, latest?.opener ?? null) &&
    !askedAtTheEnd(heard, stored)
  ) {
    return found({ text: stored, sourceSessionId: source ?? null, byPerson: false });
  }
  if (latest === null) return found(null);
  // A line the model may write now: the latest conversation was distilled (the notebook knows it), and no line is stored,
  // it is no line to open on (personal, small talk, no thread) or it was written before that conversation, while the
  // notebook leaves threads open. A conversation not distilled yet writes its own line when it is (a call a minute after
  // a chat opens with the greeting, and its first reply reads that chat in "Where you left off"). A sound, current line
  // that was not said (it repeats or comes back to a thread left aside) is the model's choice already made.
  const missing =
    latestDistilled &&
    latest.withThisVeir &&
    (!sound || !current) &&
    notebook !== null &&
    notebookThreads(notebook.content).length > 0
      ? {
          sourceSessionId: latest.sessionId,
          lastOpener: latest.opener ?? null,
          leftAside: [
            ...(untaken !== null && latest.opener != null ? [latest.opener] : []),
            ...(leftAside || !keptByLatest ? [next, topic] : []),
          ].filter((text): text is string => text !== null && text.trim() !== ''),
        }
      : null;
  // No line the model wrote for this conversation: a greeting that names nothing, never a greeting or an invitation
  // one of the person's last conversations opened with (when every line reuses one, only the latest's is avoided).
  // Each conversation they open since without a word takes the next line of the same order, so two in a row never
  // greet alike.
  const plain = plainOpeners(`${latest.sessionId}:${args.principalId}`, latest.withThisVeir)
    .map((line) => validatedOpener(line, guards))
    .filter((line): line is string => line !== null);
  const recent = (last?.conversations ?? []).map((c) => c.opener ?? null);
  const unsaid = plain.filter((line) => recent.every((previous) => !reusesWording(line, previous)));
  const pool =
    unsaid.length > 0 ? unsaid : plain.filter((line) => !reusesWording(line, latest.opener ?? null));
  const fresh = pool.length > 0 ? pool[since.opened % pool.length] : plain[0];
  return found(
    fresh === undefined ? null : { text: fresh, sourceSessionId: latest.sessionId, byPerson: false },
    missing,
  );
}

/**
 * What an opener may pick up, for `namesAThread` (the sanitizer reads the same): the founder's last messages, the latest
 * conversation's digest, and the notebook's summary, open commitments, open questions and advice.
 */
function openThreads(
  notebook: notebooksRepo.NotebookContent | null,
  digest: LeftOffDigest | null,
  founderLines: readonly string[],
): string[] {
  return [
    ...founderLines,
    digest?.summary ?? '',
    ...(digest?.topics ?? []),
    notebook?.summary ?? '',
    ...(notebook?.commitments ?? []).filter((c) => c.status === 'open').map((c) => c.text),
    ...(notebook?.openQuestions ?? []).map((q) => q.text),
    ...(notebook?.lastAdvice ?? []).map((a) => a.text),
    ...(digest?.commitments ?? []).map((c) => c.text),
    ...(digest?.openQuestions ?? []),
  ];
}

/**
 * Whether `line` (a greeting and an invitation) says again what `previous` (the latest conversation's opener) said:
 * {@link repeatsOpener}, or the same greeting, or the same invitation, anywhere in it.
 */
function reusesWording(line: string, previous: string | null): boolean {
  if (previous === null || previous.trim() === '') return false;
  if (repeatsOpener(line, previous)) return true;
  const flat = (text: string): string =>
    text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  const said = flat(previous);
  return line
    .split(/(?<=[.!?])\s+/)
    .map((part) => flat(part).replace(/[.!?]+$/, ''))
    .some((part) => part !== '' && said.includes(part));
}

/** The founder's messages in a conversation, oldest first, and whether that is all of them. */
interface FounderLines {
  readonly lines: readonly string[];
  readonly complete: boolean;
  /** The vEIR's last {@link OPENER_ECHO_EXCHANGES} answers there (read by {@link askedAtTheEnd}). */
  readonly endAnswers: readonly string[];
}

/**
 * The founder's last {@link TAKE_UP_EXCHANGES} messages in `sessionId`, and the vEIR's last answers there (one indexed
 * statement: the opener reads both from it, never a second one for the answers).
 */
async function founderLinesOf(tx: AppExecutor, sessionId: string): Promise<FounderLines> {
  const exchanges = await sessionsRepo.listLastExchanges(tx, {
    sessionIds: [sessionId],
    perSession: TAKE_UP_EXCHANGES,
  });
  return {
    lines: exchanges.map((x) => x.founderText),
    complete: exchanges.length < TAKE_UP_EXCHANGES,
    endAnswers: exchanges
      .filter((x) => x.fromEnd <= OPENER_ECHO_EXCHANGES)
      .map((x) => x.answer)
      .filter((a): a is string => a !== null),
  };
}

/**
 * The thread `latest` opened on (its stored opener: the first bubble, or what a call's greeting said) when the founder
 * took it up in none of their messages there (`untakenThread`), as its words; null when it opened with nothing, with
 * a plain invitation, or they took it up. A short yes counts only as the reply right after the opener, so it is not
 * counted when the first messages were not read.
 */
function untakenOpening(
  latest: LeftOffConversationData,
  heard: FounderLines,
  names: readonly string[],
): Set<string> | null {
  const opener = latest.opener ?? null;
  if (opener === null) return null;
  return untakenThread(opener, heard.complete ? heard.lines : ['', ...heard.lines], names);
}

/**
 * Whether `candidate` says again the opener `previous` (the line the latest conversation opened with): a near-duplicate,
 * or the same first words. A new conversation never opens the way the last one did.
 */
export function repeatsOpener(candidate: string, previous: string | null): boolean {
  if (previous === null || previous.trim() === '') return false;
  const start = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w !== '')
      .slice(0, OPENER_START_WORDS)
      .join(' ');
  const a = start(candidate);
  return isNearDuplicate(candidate, previous, 0.6) || (a !== '' && a === start(previous));
}

/** First words of two openers that may not be the same (a greeting and its frame: "Good to talk again. Shall we pick up"). */
const OPENER_START_WORDS = 8;

/**
 * Whether `opener` repeats a question the vEIR asked in one of the last answers of the conversation (`heard`, read
 * with the founder's lines: no round trip of its own, so the stored line costs the opener nothing more).
 */
function askedAtTheEnd(heard: FounderLines | null, opener: string): boolean {
  return (heard?.endAnswers ?? []).some((answer) => {
    const question = lastQuestionOf(answer);
    return question !== null && (isNearDuplicate(opener, question, 0.6) || opener.includes(question));
  });
}
