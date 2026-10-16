import { CoachResponse } from '@foundry/contracts';
import { type z } from 'zod';

/**
 * Schema name of the structured annotations of a streamed answer (phase B of a streamed turn): every
 * `CoachResponse` field except the `answer` prose (already streamed) and its `spoken` form.
 */
export const COACH_ANNOTATIONS_SCHEMA_NAME = 'CoachAnnotations';

/**
 * Phase B output: the claims and evidence, uncertainty, challenge, next actions, escalation, memory
 * candidates, follow-up questions, rehearsal block and the chosen mode for an answer the model already
 * wrote. Merged with that answer, it is a `CoachResponse` for `validateCoachResponse`.
 */
export const CoachAnnotations = CoachResponse.omit({ answer: true, spoken: true });
export type CoachAnnotations = z.infer<typeof CoachAnnotations>;
