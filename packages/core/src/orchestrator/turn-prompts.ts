import { COACH_ANNOTATIONS_SCHEMA_NAME, type ChatMessage, type CoachAnnotations } from '@foundry/ai';
import { type CoachMode, type TurnChannel } from '@foundry/contracts';

/**
 * Prompts of a streamed turn. The answer is written in two steps from the same context:
 *
 * - **Phase A** streams the reply itself as plain conversational text. Its system prompt is the turn's system
 *   prompt with the final output section (the CoachResponse JSON instructions) replaced by instructions for
 *   writing the reply alone.
 * - **Phase B** asks for the structured fields (claims, evidence, uncertainty, challenge, next actions,
 *   escalation, memory candidates, follow-ups, the chosen mode) of exactly that reply, with the unchanged
 *   system prompt and the reply replayed as the vEIR's message.
 *
 * Every rule above the output section (identity, non-negotiables, claims, escalation, mode, doctrine, notes)
 * governs both phases.
 */

/**
 * Where the turn system prompt's final output section starts: its last line beginning with `Output:`
 * (`buildSystemPrompt`). The streamed reply keeps everything before it.
 */
export const OUTPUT_SECTION_MARKER = '\nOutput:';

export interface AnswerPromptOptions {
  readonly channel: TurnChannel;
  /** The fixed mode, or null in auto mode. */
  readonly mode: CoachMode | null;
  /** Modes the model may choose from in auto mode. */
  readonly allowedModes: readonly CoachMode[];
}

/** Phase A system prompt: the turn's rules, then how to write the reply as plain text. */
export function answerSystemPrompt(system: string, options: AnswerPromptOptions): string {
  const cut = system.lastIndexOf(OUTPUT_SECTION_MARKER);
  const rules = cut < 0 ? system : system.slice(0, cut);
  const lines = [
    '',
    'Output: write your reply to the founder now, as the text itself. No JSON, no field names, no preamble.',
    options.mode === null
      ? `- First decide which mode fits best (one of ${options.allowedModes.map((m) => `"${m}"`).join(', ')}) and answer in that mode; you will name it in the next step.`
      : `- Answer in the "${options.mode}" mode.`,
    '- Claims, uncertainty, next actions, memory suggestions and follow-up questions are collected in a separate',
    '  step: do not list them in the reply. When a person needs to weigh in, say so in one plain sentence.',
  ];
  if (options.channel === 'voice') {
    lines.push(
      '- This is a voice call: write only what you will say aloud, at most 70 words in one to four short plain',
      '  sentences. No Markdown, lists, headings, citation ids like [E1] or URLs. End with at most one question.',
    );
  } else {
    lines.push(
      '- Follow "How you talk": conversational Markdown with inline [E#] citations after the statements that',
      '  rely on the evidence (ids from the <evidence> block only), and at most one question.',
    );
  }
  return `${rules}\n${lines.join('\n')}`;
}

/** Phase B conversation: the turn's messages, the streamed reply, then the request for its fields. */
export function annotationMessages(messages: readonly ChatMessage[], answer: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: answer },
    {
      role: 'user',
      content: [
        '<annotation_request>',
        'Your reply above is final and the founder has read it. Return the structured fields for exactly that',
        `reply as one ${COACH_ANNOTATIONS_SCHEMA_NAME} object: the mode you answered in, the claims it makes (facts`,
        'cite ids from the <evidence> block), uncertainty, challenge, next actions, escalation, memory candidates,',
        'follow-up questions and rehearsal, following your instructions. Do not change or repeat the reply.',
        '</annotation_request>',
      ].join('\n'),
    },
  ];
}

/** Annotations when phase B failed: the reply stands alone (the validator still forces escalations). */
export function emptyAnnotations(mode: CoachMode): CoachAnnotations {
  return {
    mode,
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
  };
}

/** Server-written frame that lets the stored opener be replayed as the vEIR's first message. */
export const OPENER_FRAME =
  '[The conversation started with your message below; the founder replies after it.]';

/** The opener as the first exchange of the model's history. */
export function openerMessages(opener: string): ChatMessage[] {
  return [
    { role: 'user', content: OPENER_FRAME },
    { role: 'assistant', content: opener },
  ];
}
