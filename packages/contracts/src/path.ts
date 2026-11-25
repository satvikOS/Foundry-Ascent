import { z } from 'zod';

import { EscalationCategory, Id, RequestedRole, Timestamp, VentureStage } from './domain.js';

/**
 * The founder path (owner, 2026-11-24, after the client's live test: "very open ended, no proper and rigid steps"):
 * a venture's stage, the evidence each stage asks for, and the steps that produce it. The path is decided by code from
 * the playbook and the venture's record, never by the model: the model explains the step the path chose, and every
 * coaching reply ends with that step, so the same founder in the same place always gets the same next step.
 */

/** Where a method comes from, as a citation names it. The playbook paraphrases; it never copies a source's text. */
export const PlaySourceKind = z.enum(['programme', 'book', 'open_textbook', 'government', 'article']);
export type PlaySourceKind = z.infer<typeof PlaySourceKind>;

export const PlaySource = z.object({
  /** Key in the playbook's source list, e.g. `mom-test`. */
  id: z.string().min(1).max(60),
  kind: PlaySourceKind,
  title: z.string().min(1).max(160),
  authors: z.string().max(160),
  year: z.number().int().nullable(),
  /** A public page about the source (publisher, author, agency); never a copy of a book. */
  url: z.url().nullable(),
});
export type PlaySource = z.infer<typeof PlaySource>;

export const PlayCitation = z.object({
  sourceId: z.string().min(1).max(60),
  /** Chapter, module and unit, or section, checked against the source's published contents; null = whole source. */
  locator: z.string().max(120).nullable(),
});
export type PlayCitation = z.infer<typeof PlayCitation>;

export const PlayStep = z.object({
  /** An instruction in the imperative ("List 20 people who did this job in the last month"). */
  do: z.string().min(8).max(160),
  /** How, concretely, for someone who has never done it. */
  how: z.string().max(320),
  minutes: z.number().int().min(5).max(600).nullable(),
});
export type PlayStep = z.infer<typeof PlayStep>;

/** One playbook method: the answer to an ask and the steps that follow it, both the same for every founder. */
export const Play = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,50}$/),
  title: z.string().min(4).max(80),
  stage: VentureStage,
  /** Asks it answers (`PathIntent` keys of the playbook's intent table). */
  intents: z.array(z.string().min(2).max(40)).max(6),
  /** Criteria its steps produce evidence for; empty for a play that only answers an ask. */
  criteria: z.array(z.string().min(2).max(50)).max(4),
  /** The direct answer or decision rule, said before the steps. */
  answer: z.string().min(40).max(700),
  why: z.string().min(20).max(320),
  steps: z.array(PlayStep).min(2).max(5),
  /** Checkable: what exists, or happened, when it is finished. */
  doneWhen: z.string().min(10).max(220),
  /** Days a student with classes needs. */
  days: z.number().int().min(1).max(30),
  template: z.object({ title: z.string().max(80), body: z.string().max(1800) }).nullable(),
  traps: z.array(z.string().max(200)).max(3),
  /** Set when a qualified person must decide: what Thomas says and who to see. */
  referral: z
    .object({
      category: EscalationCategory,
      role: RequestedRole,
      who: z.string().max(160),
      bring: z.string().max(240),
    })
    .nullable(),
  citations: z.array(PlayCitation).min(1).max(4),
  next: z.array(z.string()).max(3),
});
export type Play = z.infer<typeof Play>;

/** What a stage asks a venture to show before the next one starts. */
export const PathCriterion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,50}$/),
  stage: VentureStage,
  title: z.string().min(4).max(100),
  /** What counts as shown, e.g. "5 people described the last time it happened". */
  evidence: z.string().min(10).max(220),
  /** The play that produces it. */
  playId: z.string(),
});
export type PathCriterion = z.infer<typeof PathCriterion>;

export const CriterionStatus = z.enum(['open', 'claimed', 'met']);
export type CriterionStatus = z.infer<typeof CriterionStatus>;

export const PathStepStatus = z.enum(['now', 'next', 'later', 'done', 'skipped', 'blocked']);
export type PathStepStatus = z.infer<typeof PathStepStatus>;

export const PathStepView = z.object({
  id: Id,
  playId: z.string().nullable(),
  criterionId: z.string().nullable(),
  title: z.string(),
  /** The sub-steps, in order, with which are ticked. */
  items: z.array(
    z.object({ do: z.string(), how: z.string(), minutes: z.number().int().nullable(), done: z.boolean() }),
  ),
  doneWhen: z.string(),
  dueOn: z.string().nullable(),
  status: PathStepStatus,
  origin: z.enum(['path', 'founder', 'coach']),
  /** What the founder reported, in their words. */
  evidence: z.string().nullable(),
  template: z.object({ title: z.string(), body: z.string() }).nullable(),
  citations: z.array(
    PlayCitation.extend({ title: z.string(), authors: z.string(), url: z.url().nullable() }),
  ),
  completedAt: Timestamp.nullable(),
  version: z.number().int().positive(),
});
export type PathStepView = z.infer<typeof PathStepView>;

export const PathStageView = z.object({
  stage: VentureStage,
  title: z.string(),
  goal: z.string(),
  status: z.enum(['done', 'current', 'ahead']),
  criteria: z.array(
    PathCriterion.pick({ id: true, title: true, evidence: true }).extend({ status: CriterionStatus }),
  ),
});
export type PathStageView = z.infer<typeof PathStageView>;

/** What Thomas knows about the person and the venture's story; each line says where it comes from. */
export const ArcEntryKind = z.enum([
  'origin',
  'idea',
  'pivot',
  'decision',
  'experiment',
  'result',
  'milestone',
  'setback',
  'commitment',
  'step_done',
  'conversation',
]);
export type ArcEntryKind = z.infer<typeof ArcEntryKind>;
export const ArcEntry = z.object({
  id: z.string(),
  kind: ArcEntryKind,
  on: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  source: z.object({ kind: z.enum(['memory', 'step', 'session', 'profile']), id: z.string() }),
});
export type ArcEntry = z.infer<typeof ArcEntry>;

export const FounderExperience = z.enum(['first_time', 'some', 'experienced']);
/** What the founder tells Thomas once (the intake): every field optional; nothing blocks a first plan. */
export const PathIntake = z.object({
  idea: z.string().trim().max(400).default(''),
  customer: z.string().trim().max(240).default(''),
  studies: z.string().trim().max(120).default(''),
  experience: FounderExperience.nullable().default(null),
  hoursPerWeek: z.number().int().min(0).max(60).nullable().default(null),
  deadline: z
    .object({ what: z.string().trim().max(120), on: z.iso.date() })
    .nullable()
    .default(null),
  doneSoFar: z.string().trim().max(600).default(''),
  block: z.string().trim().max(300).default(''),
});
export type PathIntake = z.infer<typeof PathIntake>;

export const VenturePath = z.object({
  ventureId: Id,
  stage: VentureStage,
  stages: z.array(PathStageView),
  now: PathStepView.nullable(),
  next: z.array(PathStepView).max(3),
  done: z.array(PathStepView),
  intake: PathIntake.nullable(),
  arc: z.array(ArcEntry),
  playbookVersion: z.string(),
  version: z.number().int().positive(),
});
export type VenturePath = z.infer<typeof VenturePath>;

/**
 * What the path decided for one turn, kept with the turn and shown under the reply. It is complete without the model:
 * when the model's reply leaves the step out, the server still shows (and on a call says) it.
 */
export const TurnGuidance = z.object({
  intent: z.string().nullable(),
  playId: z.string().nullable(),
  stage: VentureStage,
  stageTitle: z.string(),
  /** 1-based, of the stages. */
  stageNumber: z.number().int(),
  stageCount: z.number().int(),
  step: PathStepView.nullable(),
  /**
   * The path's own step, when `step` answers what they asked instead: still open, shown small under it. Additive.
   */
  pathStep: PathStepView.nullable().optional(),
  /** `step` is offered, not on their path yet: the founder may add it (PATCH `add`). Additive. */
  offered: z.boolean().optional(),
  then: z.array(z.string()).max(2),
  referral: Play.shape.referral,
  citations: PathStepView.shape.citations,
});
export type TurnGuidance = z.infer<typeof TurnGuidance>;

/** `GET /ventures/:id/path/arc`: the venture's story so far, oldest first. */
export const PathArcResponse = z.object({ items: z.array(ArcEntry) });

/** The step a new conversation asks about first (the last one given, with its due state). */
export const PathCheckIn = z.object({
  stepId: Id,
  title: z.string(),
  dueOn: z.string().nullable(),
  overdue: z.boolean(),
  version: z.number().int().positive(),
});
export type PathCheckIn = z.infer<typeof PathCheckIn>;

export const SavePathIntake = z.object({
  expectedVersion: z.number().int().nonnegative(),
  intake: PathIntake,
});
export const PathStepAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('tick'), item: z.number().int().min(0).max(9), done: z.boolean() }),
  z.object({ action: z.literal('complete'), evidence: z.string().trim().min(3).max(1000) }),
  z.object({ action: z.literal('skip'), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal('block'), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal('reopen') }),
  /** Puts an offered step on the path (the step now when the path has none of its own in progress). */
  z.object({ action: z.literal('add') }),
  z.object({ action: z.literal('reschedule'), dueOn: z.iso.date() }),
]);
export type PathStepAction = z.infer<typeof PathStepAction>;
export const UpdatePathStep = z.object({
  expectedVersion: z.number().int().positive(),
  update: PathStepAction,
});

/**
 * What the model reports a message says about the path (the annotation call). Kept only when `quote` is in the
 * founder's own message, word for word: the model can point at what they said, never decide it.
 */
export const PathReport = z.object({
  step: z.enum(['done', 'started', 'blocked', 'dropped']).nullable(),
  criteria: z.array(z.object({ id: z.string(), quote: z.string() })),
  quote: z.string().nullable(),
});
export type PathReport = z.infer<typeof PathReport>;
