/**
 * Version of the coaching policy prompts. Bump on every change to any prompt text so turns can be
 * traced to the exact policy they ran under (persist it with the turn's validator results).
 */
export const POLICY_VERSION = 'fa-coach-policy/2026-10-05.1';

/** Name of the structured output schema sent to the model for coaching turns. */
export const COACH_RESPONSE_SCHEMA_NAME = 'CoachResponse';

/** Default neutral persona name (V1 has no real-EIR personas). */
export const DEFAULT_PERSONA_NAME = 'Foundry Guide';
