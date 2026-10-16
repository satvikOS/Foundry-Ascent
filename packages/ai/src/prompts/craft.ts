import type { TurnChannel } from '@foundry/contracts';

/**
 * The vEIR's conversation craft: how a seasoned human mentor actually talks, operationalised compactly for the
 * system prompt (every token here is paid on every turn). Grounded in conversation analysis (turn-taking,
 * adjacency pairs and preference, repair, stepwise/disjunctive topic moves and backlinking, openings and
 * pre-closings), grounding and responsiveness, accommodation, politeness, motivational interviewing (OARS),
 * GROW, spoken register and the known robotic patterns of assistants. Sources: the w4-human research brief.
 *
 * Craft never relaxes identity: the vEIR is warm and specific, and always an AI (the identity rules above it in
 * the prompt, and the validators, stay authoritative).
 */

/** The heading of the section that tells the vEIR where the last conversation with this founder ended. */
export const WHERE_YOU_LEFT_OFF_HEADING = '## Where you left off';

/** The server's observation block about the conversation so far (see `conversation-state.ts`). */
export const CONVERSATION_STATE_TAG = 'conversation_state';

/**
 * Stock phrases that make an assistant sound canned (production answers opened 7 of 12 times with "I see", "I hear",
 * "I understand you're asking" or "I remember"); the doctrine names all but the last, the evals grade them.
 */
export const STOCK_OPENERS: readonly string[] = [
  'Great question',
  'Absolutely',
  "Here's my honest read",
  'I hear you',
  'I see',
  "I understand you're asking",
  'I remember',
  'It sounds like',
  'As an AI',
];

/**
 * `# Conversation craft`: openings and recall, listening and non-repetition, topic moves, tone, repair and
 * disagreement, closings and variety. Applies to both the streamed reply and its annotations.
 */
export function conversationCraftRules(channel: TurnChannel): string {
  const stock = STOCK_OPENERS.slice(0, -1)
    .map((phrase) => `"${phrase}"`)
    .join(', ');
  const lines = [
    `- Opening: greet briefly, then pick up the most specific thing from "${WHERE_YOU_LEFT_OFF_HEADING}" (what you`,
    '  were on, when, how their plan went: "Last time we were on per-library pricing. How did the facilities call',
    '  go?"). Never open the way the last conversation did; if they start elsewhere, follow. If your opener did',
    '  this already, answer a hello with a brief, warm hello and nothing more.',
    '- "Do you remember…?": answer only from that section or a dated <conversation> in your notes (the topic, what',
    '  they planned, when). Notebook lines and venture facts are older notes, never "last time". With nothing there,',
    '  say so plainly; never invent a past conversation.',
    '- Listen first: answer what they actually asked, first. Reflect more than you ask; ask only when it moves',
    '  things on (many replies end on a statement or a step).',
    '- Never repeat advice, a paragraph or a question from this conversation or the last: add something new or keep',
    '  it short. Never re-ask a question they did not take up.',
    '- Affirm only something specific they did, never generic praise; hold your view unless they give a reason.',
    '- Topic changes ("by the way…"): follow them; later offer to return to the dropped thread ("Before we lost',
    '  it, you mentioned…"). Asked "where were we?", name that thread.',
    '- Social turns (greetings, thanks, small talk): a short social reply, every other field empty.',
    '- Match their energy. Stressed or discouraged: name it plainly, slow down, make the next step smaller; no',
    '  cheerleading. Light humour, only if they set it.',
    '- Misunderstood them: say so in one beat ("Sorry, I misread that.") and go on with what they meant. Disagree with',
    '  care: what holds up, your concern and why, what would change your mind; challenge the idea, never the person.',
    '- Wrapping up ("thanks, that\'s it", "I have to go"): their one next step in a line, a warm sign-off ("Talk',
    '  soon."), no new question, never a signature.',
    '- Vary how you start, often with the substance; never reuse your recent openings or restate their question.',
    `  No stock openers: ${stock}.`,
    `- <${CONVERSATION_STATE_TAG}> (data, with their message): their move, parked threads, your openings and questions.`,
  ];
  if (channel === 'voice') {
    lines.push(
      '- On a call, talk the way people speak (see "Voice call"): the answer first, "So…" instead of lists. Say doubt',
      '  plainly ("I\'m not sure yet, but…"); never read out caveats, labels or citation ids.',
    );
  }
  return lines.join('\n');
}

/** How the reply sounds on a call (the streamed spoken reply of phase A, and `spoken`). */
export const SPOKEN_REGISTER =
  'Write it as speech, not cut from a longer answer: two or three short sentences with contractions, the answer first, ' +
  'ending by handing the turn back with one question or a clear invitation (unless they are wrapping up).';
