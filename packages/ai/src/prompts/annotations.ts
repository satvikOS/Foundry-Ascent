import { Claim, CoachMode, EscalationProposal, MemoryCandidate, PathReport } from '@foundry/contracts';
import { z } from 'zod';

import type { CoachAnnotations } from '../gateway/coach-annotations.js';

/**
 * The fields of a reply on the path (phase B of a streamed turn). The path already decides the next action, and its card
 * shows it: what is asked of the model is what only it can give, the claims, what to remember, what their message reports
 * on their path and an escalation (first live run on Nova 2 Lite: the second call carried the whole context again and wrote
 * 450 tokens of fields, a third of them never shown; 8% of them failed on a claim without its list of ids).
 */
export const PathAnnotations = z.object({
  mode: CoachMode,
  claims: z.array(Claim.extend({ evidence_ids: z.array(z.string()).nullable().optional() })),
  escalation: EscalationProposal,
  memory_candidates: z.array(
    MemoryCandidate.extend({ evidence_ids: z.array(z.string()).nullable().optional() }),
  ),
  path_report: PathReport.nullable().optional(),
});
export type PathAnnotations = z.infer<typeof PathAnnotations>;

/** The fields of a reply as every turn stores them: what a reply on the path leaves out is empty. */
export function annotationsOfPath(a: PathAnnotations): CoachAnnotations {
  return {
    mode: a.mode,
    claims: a.claims.map((c) => ({ ...c, evidence_ids: c.evidence_ids ?? [] })),
    uncertainty: [],
    challenge: null,
    next_actions: [],
    escalation: a.escalation,
    memory_candidates: a.memory_candidates.map((m) => ({ ...m, evidence_ids: m.evidence_ids ?? [] })),
    follow_up_questions: [],
    rehearsal: null,
    path_report: a.path_report ?? null,
  };
}
