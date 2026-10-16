import type { CoachMode, MemoryType } from '@foundry/contracts';

/**
 * Phrase banks for the offline mock model (local development, CI and e2e). They make the mock read like
 * a mentor in conversation so local demos look real, while staying deterministic: every choice is made
 * from a hash of the prompt. Nothing here is shown in production, where a real model answers.
 */

export type MockTopic =
  'pricing' | 'fundraising' | 'regulatory' | 'pilot' | 'interviews' | 'team' | 'competition' | 'general';

interface TopicBank {
  /** Matches the founder's message (lower-cased). */
  match: RegExp;
  /** Short noun phrase for digests and titles ("pricing for the pilot"). */
  phrase: string;
  title: string;
  /** Opening observations; `{cite}` is replaced by an evidence citation or removed. */
  insights: readonly string[];
  /** The one sharp question that ends the reply. */
  questions: readonly string[];
  challenge: string;
  uncertainty: string;
  inference: string;
  hypothesis: string;
  action: string;
  /** Two options for coach mode, the first one recommended. */
  options: readonly [string, string];
  memory: { type: MemoryType; title: string; note: string };
  followUps: readonly [string, string];
  advice: string;
  rehearsalLine: string;
  lesson: {
    title: string;
    context: string;
    signal: string;
    intervention: string;
    outcome: string;
    limits: string;
  };
}

export const TOPICS: Readonly<Record<MockTopic, TopicBank>> = {
  pricing: {
    match:
      /\b(?:pric\w*|pay|paying|paid|charge\w*|willingness|revenue|subscription|per[- ]seat|fees?|budget)\b/,
    phrase: 'pricing',
    title: 'Pricing and willingness to pay',
    insights: [
      "Pricing questions are usually evidence questions in disguise. What people say they'd pay matters far less than what they've already paid for something similar{cite}.",
      'Before you pick a number, find out who actually holds the budget and what they compare you to today{cite}. That comparison sets your ceiling more than your costs do.',
      "The fastest way to learn your price is to ask for money early, even a small deposit. Polite enthusiasm won't tell you much{cite}.",
    ],
    questions: [
      'Who would sign off on this purchase, and have you asked them directly?',
      'What are they paying today for the workaround you would replace?',
      'Has anyone put money or a signed commitment behind this yet?',
    ],
    challenge: 'Would the person who benefits be the one who pays, and at what price?',
    uncertainty: 'Who holds the budget, and what they compare the price against.',
    inference: 'Stated willingness to pay usually overstates what buyers actually pay.',
    hypothesis: 'The buyer will pay for time saved rather than for features.',
    action: 'Ask three prospective buyers for a small paid commitment at a specific price.',
    options: [
      'run a small paid pilot at one clear price and see who says yes',
      'keep interviewing about pricing before charging anyone',
    ],
    memory: {
      type: 'hypothesis',
      title: 'Pricing still to be tested with real buyers',
      note: 'Willingness to pay has not been tested with a paid commitment yet.',
    },
    followUps: ['How do I ask for a deposit without scaring people off?', 'What price should I test first?'],
    advice: 'Test price with a small paid commitment instead of asking what people would pay.',
    rehearsalLine:
      'Before I bring this to my budget meeting, what exactly would I be paying for, and compared to what?',
    lesson: {
      title: 'Anchor pricing in observed payment, not stated intent',
      context:
        'A founder was choosing a price for a first paid pilot before any customer had paid for a comparable solution.',
      signal: 'Prospects praised the idea but became vague whenever payment came up.',
      intervention:
        'Ask for a small paid commitment early, such as a deposit or a letter of intent with a price, instead of asking whether people would pay.',
      outcome:
        'The conversation moved from opinions to commitments and showed where real willingness to pay sat.',
      limits:
        'Works best when the user and the buyer are the same person; in institutional sales the budget holder has to be part of the test.',
    },
  },
  fundraising: {
    match: /\b(?:rais\w*|investors?|funding|fundrais\w*|vc|angels?|grants?|seed|pitch\w*|valuation|deck)\b/,
    phrase: 'fundraising timing',
    title: 'When to raise',
    insights: [
      'Investors fund evidence of pull, not plans{cite}. The question is less "can we raise" and more "what would make this an easy yes".',
      "Raising before your riskiest assumption is tested usually means a smaller round on worse terms{cite}. It's worth knowing which proof point would change the conversation.",
      "Most early rounds come down to one or two numbers that show momentum{cite}. It helps to decide now which numbers you'd want to show.",
    ],
    questions: [
      'What is the one result that would make an investor take this seriously?',
      'If you had the money tomorrow, what exactly would you spend the first three months on?',
      'What would you need to prove first so you raise from strength?',
    ],
    challenge: 'What evidence would an investor need to see that you do not have yet?',
    uncertainty: 'Which proof point investors in this space weigh most.',
    inference: 'Raising before the riskiest assumption is tested tends to lead to weaker terms.',
    hypothesis: 'A short paid pilot would be the strongest signal for a first round.',
    action: 'Write down the single metric that would make the next raise easy, and how to reach it.',
    options: [
      'spend the next weeks producing the one proof point that matters most, then raise',
      'start investor conversations now to learn what they look for',
    ],
    memory: {
      type: 'decision',
      title: 'Fundraising timing under discussion',
      note: 'The founder is weighing when to raise relative to the next proof point.',
    },
    followUps: ['Which metric matters most at our stage?', 'How long does a first round usually take?'],
    advice: 'Raise after the riskiest assumption is tested, with the one proof point that matters.',
    rehearsalLine:
      "You have a nice story, but what have customers actually done that tells me this isn't a nice-to-have?",
    lesson: {
      title: 'Raise from a proof point, not a plan',
      context:
        'An early founder wanted to start fundraising before the riskiest assumption in the venture had been tested.',
      signal: 'Investor conversations kept circling back to whether customers would really adopt and pay.',
      intervention:
        'Name the one result that would answer that question, run the cheapest test that could produce it, and start raising once it exists.',
      outcome: 'The founder entered investor conversations with evidence instead of promises.',
      limits:
        'Some deep-technology ventures need capital before any proof is possible; then the proof point is a technical milestone instead.',
    },
  },
  regulatory: {
    match: /\b(?:fda|regulat\w*|clinical|compliance|hipaa|certif\w*|clearance|approval pathway|510)\b/,
    phrase: 'the regulatory pathway',
    title: 'Regulatory pathway questions',
    insights: [
      "The regulatory route shapes your timeline and your first customer more than most product decisions do{cite}. It's worth getting a qualified opinion early.",
      'What you claim the product does decides which rules apply{cite}. Careful wording of the intended use can change the whole pathway.',
    ],
    questions: [
      'What exactly do you plan to claim the product does for patients or users?',
      'Have you spoken to anyone who has taken a similar product through review?',
    ],
    challenge: 'Does your intended-use statement put you in a heavier regulatory class than you planned for?',
    uncertainty: 'Which regulatory class applies to the intended use.',
    inference: 'The intended-use claim largely determines the regulatory pathway.',
    hypothesis: 'A narrower first claim would allow a lighter pathway.',
    action: 'Draft a one-paragraph intended-use statement and review it with a regulatory specialist.',
    options: [
      'get a specialist to review your intended-use statement before building further',
      'build first and work out the pathway later',
    ],
    memory: {
      type: 'risk',
      title: 'Regulatory pathway not yet confirmed',
      note: 'The regulatory class and pathway still need a qualified review.',
    },
    followUps: ['Who should review our intended use?', 'How do other founders scope a first claim?'],
    advice: 'Get a qualified review of the intended-use statement before building further.',
    rehearsalLine: 'Walk me through how you know this is safe, and who has reviewed that.',
    lesson: {
      title: 'Scope the first claim before building',
      context:
        'A medical technology founder was building a product before deciding what it would claim to do.',
      signal: 'Each conversation about customers ended in uncertainty about which rules applied.',
      intervention:
        'Write a narrow intended-use statement first and have a qualified specialist review the likely pathway.',
      outcome:
        'The founder could plan the build, the timeline and the first customer around a known pathway.',
      limits: 'This is general education; the actual pathway always needs a qualified regulatory review.',
    },
  },
  pilot: {
    match:
      /\b(?:pilots?|trials?|experiments?|prototypes?|mvp|launch\w*|door counter|beta|test(?:ing)? (?:it|this|the))\b/,
    phrase: 'the pilot design',
    title: 'Designing the pilot',
    insights: [
      "A good pilot answers one question you can't answer any other way{cite}. If it tries to prove everything, it usually proves nothing.",
      'Decide before you start what result would make you stop, and what would make you double down{cite}. Otherwise every outcome looks like progress.',
      'The cheapest pilot that could prove you wrong is usually smaller than founders expect{cite}. Two sites done well beat five done loosely.',
    ],
    questions: [
      'What result would make you stop, and have you written it down?',
      'What is the one question this pilot has to answer?',
      'How will you know the pilot worked, in numbers?',
    ],
    challenge: 'What result from the pilot would convince you that you were wrong?',
    uncertainty: 'Whether the pilot sites are representative of the wider market.',
    inference: 'A pilot without a pre-agreed success threshold rarely changes decisions.',
    hypothesis: 'A two-week pilot is enough to see whether usage repeats.',
    action: 'Write down the pilot success threshold and the stop condition before it starts.',
    options: [
      'run a short, small pilot with a clear success threshold',
      'wait until the product is more complete before piloting',
    ],
    memory: {
      type: 'experiment',
      title: 'Pilot success criteria being defined',
      note: 'The pilot needs a written success threshold and stop condition.',
    },
    followUps: ['What should the success threshold be?', 'How many sites do we need?'],
    advice: 'Set a success threshold and a stop condition before the pilot starts.',
    rehearsalLine:
      "If we agree to this pilot, what do you need from my team, and what happens if it doesn't work?",
    lesson: {
      title: 'Agree on the stop condition before the pilot starts',
      context:
        'A founder was planning a first pilot with a partner site and wanted it to prove several things at once.',
      signal: 'Every possible outcome of the plan could be read as success.',
      intervention:
        'Pick the one question the pilot must answer and write down the result that would mean stopping.',
      outcome: 'The pilot became smaller, cheaper and decisive.',
      limits:
        'Partners sometimes want broader pilots; then agree on which result matters before adding scope.',
    },
  },
  interviews: {
    match:
      /\b(?:interview\w*|customers?|users?|talk(?:ed|ing)? to|surveys?|feedback|discovery|librar\w*|staff|students?|clinics?|managers?)\b/,
    phrase: 'customer evidence',
    title: 'Customer interview plan',
    insights: [
      'The most useful interviews ask about what people did last time, not what they would do{cite}. Past behaviour is hard to fake.',
      "Your notes so far point somewhere{cite}, but a handful of conversations can mislead. It's worth checking whether the pattern holds with people who didn't already like the idea.",
      'Talking to the people who feel the pain every week is what matters{cite}. Their workarounds tell you how much the problem is worth.',
    ],
    questions: [
      'When was the last time one of them hit this problem, and what did they do about it?',
      'How many of the people you spoke to have tried to solve this themselves?',
      'Who did you talk to that disagreed with you?',
    ],
    challenge: 'Are you hearing about real past behaviour, or about what people think they would do?',
    uncertainty: 'How representative the people interviewed so far are.',
    inference: 'Interviews about past behaviour predict adoption better than hypothetical questions.',
    hypothesis: 'The problem is frequent enough that people already use workarounds.',
    action: 'Run five interviews focused on the last time the problem happened.',
    options: [
      'run five more interviews about the last time the problem happened',
      'send a survey to reach more people quickly',
    ],
    memory: {
      type: 'insight',
      title: 'Customer evidence still being gathered',
      note: 'More interviews about real past behaviour are planned.',
    },
    followUps: ['What should I ask in the next interviews?', 'How many interviews are enough?'],
    advice: 'Ask about the last time the problem happened, not about what people would do.',
    rehearsalLine: 'Sure, I can give you twenty minutes. What do you actually want to know from me?',
    lesson: {
      title: 'Ask about the last time, not the next time',
      context: 'A founder was running early customer interviews and hearing strong enthusiasm for the idea.',
      signal:
        'Interviewees agreed they would use the product but could not describe a recent time they had the problem.',
      intervention:
        'Rewrite the interview guide around the most recent occurrence of the problem and what the person did about it.',
      outcome: 'The founder separated people with a real, frequent problem from polite supporters.',
      limits:
        'Rare but costly problems may not have a recent occurrence; then ask about the last one, however long ago.',
    },
  },
  team: {
    match: /\b(?:co-?founders?|team\w*|hir\w*|roles?|equity|teammates?|responsibilit\w*)\b/,
    phrase: 'team roles',
    title: 'Team roles and ownership',
    insights: [
      "Early teams rarely break over ideas. They break over unclear ownership{cite}. It's worth naming who decides what before it becomes tense.",
      'The right next hire is whoever removes your current bottleneck{cite}, which is not always the role that feels most urgent.',
    ],
    questions: [
      'Who owns the most important decision this month, and does everyone agree?',
      'What is the bottleneck that a new person would remove?',
    ],
    challenge: 'Does everyone on the team agree on who owns which decisions?',
    uncertainty: 'Whether the team shares the same view of roles and ownership.',
    inference: 'Unclear ownership causes more early-team friction than disagreement about ideas.',
    hypothesis: 'Writing down decision owners will reduce rework.',
    action: 'Write a one-page list of who owns which decisions and review it as a team.',
    options: ['agree on decision owners now, in writing', 'keep things informal until the next milestone'],
    memory: {
      type: 'decision',
      title: 'Team ownership being clarified',
      note: 'The team is clarifying who owns which decisions.',
    },
    followUps: ['How do we split responsibilities fairly?', 'When should we hire?'],
    advice: 'Name an owner for each important decision and write it down.',
    rehearsalLine: "I like the idea, but I'm not sure what I'd own if I joined. Can you spell that out?",
    lesson: {
      title: 'Name decision owners before tension builds',
      context: 'A small founding team was moving fast without having discussed who decides what.',
      signal: 'The same decisions kept being reopened and work was being redone.',
      intervention:
        'Write a short list of the important decisions and one owner for each, and review it together.',
      outcome: 'Decisions stuck and the team spent less time relitigating them.',
      limits: 'Ownership questions that involve equity or employment terms need qualified advice.',
    },
  },
  competition: {
    match: /\b(?:compet\w*|alternatives?|incumbents?|differentiat\w*|rivals?|market leader)\b/,
    phrase: 'positioning against alternatives',
    title: 'Positioning against alternatives',
    insights: [
      "Your real competitor is usually the workaround people use today, not another startup{cite}. That's what you have to be clearly better than.",
      "Differentiation only counts if the customer notices it in the first week{cite}. It's worth testing which difference they actually care about.",
    ],
    questions: [
      'What do people use today instead, and why would they switch?',
      'Which difference would a customer notice in their first week?',
    ],
    challenge: 'Is your product clearly better than the free workaround people already use?',
    uncertainty: 'How strongly customers are attached to their current workaround.',
    inference: 'The status quo is usually the strongest competitor for an early venture.',
    hypothesis: 'Customers will switch for a large time saving, not for extra features.',
    action: 'List the top three workarounds customers use today and what switching would cost them.',
    options: [
      'test which single difference customers care about most',
      'build a broader feature set to cover more competitors',
    ],
    memory: {
      type: 'insight',
      title: 'Positioning against current workarounds',
      note: 'The main alternative to beat is the current workaround.',
    },
    followUps: ['How do I find out what they use today?', 'Which difference should we lead with?'],
    advice: 'Position against the workaround people use today, not against other startups.',
    rehearsalLine:
      'We already have something that mostly works. Why would I go through the pain of switching?',
    lesson: {
      title: 'Compete with the workaround, not the startups',
      context:
        'A founder was mapping competing startups while early customers were using homemade workarounds.',
      signal: 'Customers rarely mentioned other startups but often described their own makeshift solutions.',
      intervention: 'Map the workarounds people use today and what switching would cost them.',
      outcome: 'Positioning focused on the change customers would actually feel.',
      limits: 'In crowded markets with strong incumbents, direct competitor analysis still matters.',
    },
  },
  general: {
    match: /$^/,
    phrase: 'your next step',
    title: 'Next steps for the venture',
    insights: [
      "Let's anchor this in what you've actually seen so far{cite}. That's the quickest way to find the next useful step.",
      'There is a lot here, so let me focus on the part with the most uncertainty{cite}. That is usually where the next week should go.',
      'The most useful next step is usually the cheapest one that could prove you wrong{cite}.',
    ],
    questions: [
      'What have you observed directly, and from how many people?',
      'What would have to be true for this to work?',
      'What is the one thing you are least sure about right now?',
    ],
    challenge: 'What would have to be true for this plan to work?',
    uncertainty: 'How representative the available evidence is.',
    inference: 'The current evidence base is thin, so conclusions are provisional.',
    hypothesis: 'The problem is painful enough that people already look for solutions.',
    action: 'Pick the riskiest assumption and design the cheapest test that could disprove it.',
    options: [
      'test the riskiest assumption with the cheapest possible experiment',
      'keep building and look for feedback later',
    ],
    memory: {
      type: 'hypothesis',
      title: 'Current focus for the venture',
      note: 'The riskiest assumption still needs a cheap test.',
    },
    followUps: ['Can you help me find my riskiest assumption?', 'What should I do this week?'],
    advice: 'Test the riskiest assumption with the cheapest experiment that could disprove it.',
    rehearsalLine: 'Walk me through the evidence that customers will pay for this.',
    lesson: {
      title: 'Test the riskiest assumption first',
      context: 'An early founder had many open questions and was spreading effort across all of them.',
      signal: 'Weeks of work were not changing the founder’s confidence in the plan.',
      intervention:
        'Name the single assumption that would sink the venture if wrong, and run the cheapest test that could disprove it.',
      outcome: 'Effort went to the question that mattered most, and the next decision became clear.',
      limits: 'Some assumptions cannot be tested cheaply; then look for the earliest leading signal instead.',
    },
  },
};

/** Order in which topics are matched (the first match wins). */
export const TOPIC_ORDER: readonly MockTopic[] = [
  'regulatory',
  'fundraising',
  'pricing',
  'pilot',
  'team',
  'competition',
  'interviews',
  'general',
];

export function topicOf(text: string): MockTopic {
  const lower = text.toLowerCase();
  return TOPIC_ORDER.find((t) => TOPICS[t].match.test(lower)) ?? 'general';
}

/** Cues the mock uses to choose a mode in auto mode, in order of precedence. */
const AUTO_MODE_CUES: readonly (readonly [CoachMode, RegExp])[] = [
  ['rehearse', /\b(?:practi[cs]e|rehearse|role-?play|pretend to be)\b/],
  ['route', /\b(?:resources?|office hours|workshops?|grants?|who (?:can|should) i talk to)\b/],
  ['teach', /\b(?:what is|what's|what are|how does|explain|teach me|what does)\b/],
  ['challenge', /\b(?:poke holes|stress[- ]test|devil'?s advocate|push back|challenge (?:me|this|my))\b/],
  [
    'coach',
    /\b(?:should (?:we|i)|decide|which option|what (?:do|should) (?:we|i) do|next step|help me (?:choose|plan))\b/,
  ],
];

/** The mode the mock picks for a message in auto mode: the first allowed cue, else diagnose. */
export function autoModeFor(text: string, allowed: readonly CoachMode[]): CoachMode {
  const lower = text.toLowerCase();
  const options = allowed.length > 0 ? allowed : (['diagnose'] as const);
  const cued = AUTO_MODE_CUES.find(([mode, cue]) => options.includes(mode) && cue.test(lower));
  if (cued) return cued[0];
  return options.includes('diagnose') ? 'diagnose' : (options[0] ?? 'diagnose');
}

/** Greetings by warmth; `{name}` is the founder's first name. */
export const GREETINGS = {
  warm: [
    'Good to see you, {name}.',
    'Hi {name}, glad you brought this.',
    'Thanks for bringing this, {name}.',
  ],
  reserved: ['Hello {name}.', 'Thanks, {name}.', 'Good question, {name}.'],
} as const;

/** Bridges in direct and gentler styles. */
export const LEADS = {
  direct: ["Here's my honest read.", "I'll be direct.", 'Short version first.'],
  balanced: ["Here's how I'd think about it.", 'Let me share how I see it.', "Here's where I'd start."],
  gentle: [
    "You're asking the right question.",
    "There's a good instinct behind this.",
    "You've already done useful work here.",
  ],
} as const;

/** Teaching steps, used in teach mode. */
export const TEACH_STEPS = [
  'Name the assumption in one sentence.',
  'Pick the cheapest test that could prove it wrong.',
  'Decide in advance what result would change your plan.',
] as const;

/** Area labels for the escalation sentence. */
export const ESCALATION_AREAS: Readonly<Record<string, string>> = {
  ip_licensing: 'intellectual property',
  legal: 'legal questions',
  securities_investment: 'equity and investment terms',
  medical_regulatory: 'medical and regulatory questions',
  safety_wellbeing: 'your wellbeing',
  conflict_harassment: 'a difficult interpersonal situation',
  security_identity: 'account security',
};
