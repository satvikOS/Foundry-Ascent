import { CommitmentStatus, MemoryCandidate } from '@foundry/contracts';
import { z } from 'zod';

/** Name of the structured output schema sent to the model for distillation. */
export const DISTILL_SCHEMA_NAME = 'DistillDraft';

/**
 * Output bound of a distillation call. The draft rewrites the whole notebook every time (up to 8 profile notes,
 * 10 commitments, 6 questions, 5 advice notes, each up to 400 characters) besides the digest and the memory and
 * lesson candidates, which together can pass the gateway's default of 4,096 tokens on a rich conversation: the
 * call was cut off and retried (LAB-R7). Only the tokens written are billed.
 */
export const DISTILL_MAX_OUTPUT_TOKENS = 8_192;

/** A notebook line as the model returns it: the id of the entry it keeps, or null for a new one. */
export const DistillNote = z.object({
  id: z.string().nullable(),
  text: z.string(),
});
export type DistillNote = z.infer<typeof DistillNote>;

export const DistillCommitment = z.object({
  id: z.string().nullable(),
  text: z.string(),
  /** ISO date (YYYY-MM-DD) or null. */
  due: z.string().nullable(),
  status: CommitmentStatus,
});
export type DistillCommitment = z.infer<typeof DistillCommitment>;

/** A generalised lesson for the persona's common pool (fields of `CreateLessonRequest`). */
export const LessonCandidate = z.object({
  title: z.string(),
  context: z.string(),
  signal: z.string(),
  intervention: z.string(),
  outcome: z.string(),
  limits: z.string(),
});
export type LessonCandidate = z.infer<typeof LessonCandidate>;

/**
 * The model's output for one distillation (one structured call per conversation version): the
 * conversation title and digest, the full proposed notebook, memory candidates and lesson candidates.
 * Every field is required and optional values are null, so the schema is valid for strict structured
 * outputs. Limits are enforced by `sanitizeDistill`, not the schema.
 */
export const DistillDraft = z.object({
  /*
   * A title the model left out, wrote as null or in a shape no repair reads reads as no title ('' →
   * `sanitizeDistill` keeps none): the lab's distillations failed whole on `title: invalid_type` (wave 6) and
   * were asked for again, for a title the conversation's first message already gives.
   */
  title: z.string().catch(''),
  digest: z.object({
    summary: z.string(),
    topics: z.array(z.string()),
    commitments: z.array(z.object({ text: z.string(), due: z.string().nullable() })),
    open_questions: z.array(z.string()),
  }),
  notebook: z.object({
    summary: z.string(),
    founder_profile: z.array(DistillNote),
    commitments: z.array(DistillCommitment),
    open_questions: z.array(DistillNote),
    last_advice: z.array(DistillNote),
    next_opener: z.string().nullable(),
    /*
     * The thread to come back to next time as a short phrase, which the greeting is phrased around afresh each
     * time. Optional so drafts written without it still parse; the strict model schema lists it as a required,
     * nullable property (`toStrictJsonSchema`).
     */
    next_topic: z.string().nullable().optional(),
  }),
  memory_candidates: z.array(MemoryCandidate),
  lesson_candidates: z.array(LessonCandidate),
});
export type DistillDraft = z.infer<typeof DistillDraft>;

/** Bounds applied by `sanitizeDistill` (they match the notebook, digest and lesson contracts). */
export const DISTILL_LIMITS = {
  titleMaxChars: 80,
  digestSummaryMaxChars: 1_200,
  topicsMax: 8,
  topicMaxChars: 80,
  digestCommitmentsMax: 8,
  commitmentMaxChars: 300,
  digestOpenQuestionsMax: 6,
  openQuestionMaxChars: 300,
  notebookSummaryMaxChars: 1_200,
  entryMaxChars: 400,
  founderProfileMax: 8,
  notebookCommitmentsMax: 10,
  notebookOpenQuestionsMax: 6,
  lastAdviceMax: 5,
  nextOpenerMaxChars: 300,
  nextTopicMaxChars: 120,
  memoryCandidatesMax: 3,
  memoryTitleMaxChars: 200,
  memoryContentMaxChars: 2_000,
  lessonCandidatesMax: 2,
  lessonTitleMaxChars: 200,
  lessonFieldMaxChars: 2_000,
} as const;
