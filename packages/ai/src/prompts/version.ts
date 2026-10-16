/**
 * Version of the coaching policy prompts. Bump on every change to any prompt text so turns can be
 * traced to the exact policy they ran under (persist it with the turn's validator results). Covers the
 * coaching system prompt, the vEIR notes block and the distillation prompt.
 */
export const POLICY_VERSION = 'fa-coach-policy/2026-10-16.4';

/** Name of the structured output schema sent to the model for coaching turns. */
export const COACH_RESPONSE_SCHEMA_NAME = 'CoachResponse';

/** The program-wide neutral persona; vEIR personas are named "<EIR first name>'s vEIR". */
export const DEFAULT_PERSONA_NAME = 'Foundry Guide';
