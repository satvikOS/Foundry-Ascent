import {
  MAX_PROMPT_DIGESTS,
  firstNameOf,
  rewriteIdentity,
  sanitizePlainText,
  textsContainOtherVenture,
  truncate,
  type PromptContinuity,
} from '@foundry/ai';
import { notebooksRepo, principalsRepo, sessionsRepo, type AppExecutor } from '@foundry/db';

import { mentionsEir } from '../internal/eir-names.js';

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
  const digests = await sessionsRepo.listRecentDigests(tx, {
    ventureId: args.ventureId,
    personaId: args.personaId,
    excludeSessionId: args.sessionId,
    limit: MAX_PROMPT_DIGESTS,
  });
  return {
    continuity: {
      founderFirstName,
      notebook: notebook ? { ...notebook.content, updatedAt: notebook.updatedAt } : null,
      recentDigests: digests.map((d) => ({
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
    digests: digests.length,
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
