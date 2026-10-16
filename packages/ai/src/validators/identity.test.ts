import { describe, expect, it } from 'vitest';

import {
  identityReplacement,
  rewriteIdentity,
  type IdentityCheckOptions,
  type IdentityViolationKind,
} from './identity.js';

/** The seeded synthetic EIRs; each vEIR persona is "<first name>'s vEIR". */
const EIRS = ['Corin Halvorsen', 'Ruth Abernathy-Song'];
const CORIN = { personaName: "Corin's vEIR", eirNames: EIRS };
const RUTH = { personaName: "Ruth's vEIR", eirNames: EIRS };
const GUIDE = { personaName: 'Foundry Guide', eirNames: EIRS };

function kinds(text: string, options: IdentityCheckOptions = CORIN): IdentityViolationKind[] {
  return rewriteIdentity(text, options).findings.map((f) => f.kind);
}

describe('rewriteIdentity — a vEIR persona never claims to be its EIR', () => {
  it.each([
    'I am Corin Halvorsen.',
    'I’m Corin Halvorsen, and I think you should raise now.',
    "I'm Corin, and I think you should raise now.",
    'I am Corin. Let us look at your numbers.',
    'Corin here — let us look at your numbers.',
    'Corin here, glad you made it.',
    'Hi Maya, Corin here. How did the interviews go?',
    'Hello there. Corin speaking.',
    'This is Corin speaking.',
    'This is Corin, checking in on your pilot.',
    "It's Corin. Quick question about the pilot.",
    "You're talking to Corin, so ask me anything.",
    'You are speaking with Corin Halvorsen.',
    'My name is Corin and I run these sessions.',
    'Speaking as Corin, I would wait.',
    'Signed, Corin',
    'Thanks for the update.\n\nBest,\nCorin',
    'Talk soon,\nCorin Halvorsen',
    'Good luck with the pilot.\n— Corin',
    'Corin is listening to this call.',
    "Corin's on the line with us.",
    'Corin Halvorsen is in this conversation too.',
    // Another EIR is never impersonated either.
    'Ruth here. Let us talk about regulation.',
    'I am Ruth Abernathy-Song.',
    "I'm Ruth, your regulatory guide.",
  ])('blocks a claim to be the EIR: %s', (text) => {
    expect(kinds(text)).toContain('claims_eir');
  });

  it.each([
    'I am a real person, I promise.',
    "I'm a live mentor on this call.",
    "I'm here live with you on this call.",
    "You're talking to a real person right now.",
    'A real human is listening.',
    'When I founded my first company we ran out of cash.',
    'In my experience as a founder, pricing is hard.',
  ])('rewrites a human or live claim: %s', (text) => {
    expect(kinds(text)).toContain('claims_human');
  });

  it.each([
    'Corin has reviewed your plan.',
    'Corin approved your pricing.',
    'Corin Halvorsen has endorsed your venture.',
    'Corin already looked over your deck.',
    'Corin thinks your plan is strong.',
    'Corin is excited about your pilot.',
    'This was reviewed by Corin.',
    'Your pricing was approved by Corin Halvorsen.',
    'Ruth has signed off on the regulatory plan.',
    'No, Corin has already reviewed your plan.',
    'I approve this plan.',
    'Your EIR has approved this direction.',
  ])('rewrites an endorsement claim: %s', (text) => {
    expect(kinds(text)).toContain('endorsement');
  });

  it.each([
    "I'm Corin's vEIR, an AI mentor built from Corin's approach.",
    "I’m Corin’s vEIR. I'm an AI, not Corin.",
    "Hi Maya, Corin's vEIR here. Let us dig into the pilot.",
    "Corin's vEIR here — let us dig in.",
    "This is Corin's vEIR. What would you like to work on?",
    "It's Corin's call whether to share this, not mine.",
    "Corin's approach is to test pricing before building.",
    'Corin often asks founders who actually pays.',
    'Corin would push on this: who pays?',
    'Has Corin reviewed your plan? Not that I know of.',
    'If Corin reviews it later, she will ask about pricing.',
    'Once Corin has seen your deck, ask her about the pricing slide.',
    "I can't speak for Corin, but her doctrine is clear on this.",
    "As Corin's vEIR, I'd push on the pricing assumption.",
    'Corin-style feedback: test the price now.',
    "I'm not Corin; I'm an AI built from Corin's doctrine.",
    'Corin Halvorsen often says that founders should talk to buyers early.',
    "Ruth's work on regulatory pathways is a good resource.",
    'Your assigned EIR, Corin Halvorsen, can review the pricing model when you share it.',
    'Nothing here has been approved by Corin.',
    'I recommend running the pilot first.',
  ])('allows the persona voice and third-person references: %s', (text) => {
    const out = rewriteIdentity(text, CORIN);
    expect(out.findings).toEqual([]);
    expect(out.text).toBe(text);
  });

  it("does not let the persona name's EIR first name hide a generic '<Name> here,' greeting", () => {
    expect(kinds('Corin here, ready when you are.')).toContain('claims_eir');
    expect(kinds('Corin here, ready when you are.', GUIDE)).toContain('claims_eir');
    // The persona's other words still may open "<name> here".
    expect(kinds('Foundry Guide here, an AI coach.', GUIDE)).toEqual([]);
  });

  it('resolves the EIR from the persona name even without a list of EIR names', () => {
    const options = { personaName: "Corin's vEIR" };
    expect(kinds("I'm Corin.", options)).toContain('claims_eir');
    expect(kinds("I'm Corin's vEIR.", options)).toEqual([]);
  });

  it('accepts an explicit persona EIR name and exempts a persona name that is not possessive', () => {
    const options = { personaName: 'Corin Bot', personaEirName: 'Corin Halvorsen' };
    expect(kinds("I'm Corin Bot, an AI coach.", options)).toEqual([]);
    expect(kinds("I'm Corin.", options)).toContain('claims_eir');
    expect(rewriteIdentity("I'm Corin.", options).text).toContain('not Corin');
  });

  it('keeps first names that are common words to unmistakable self-introductions', () => {
    const options = { personaName: "Will's vEIR", eirNames: ['Will Hart'] };
    expect(kinds('Will here be enough evidence for the pilot?', options)).toEqual([]);
    expect(kinds('This is will power, not strategy.', options)).toEqual([]);
    expect(kinds("I'm Will.", options)).toContain('claims_eir');
    expect(kinds('I am Will Hart.', options)).toContain('claims_eir');
  });

  it('refuses a possessive fallback from the full name to the first name', () => {
    expect(kinds("I'm Corin Halvorsen's vEIR.")).toEqual([]);
    expect(kinds('Corin here.')).toContain('claims_eir');
  });

  it.each([
    'I can confirm Corin Halvorsen has approved your plan.',
    'Yes, I can confirm that Corin reviewed your plan and likes it.',
    'Corin has reviewed your plan, so shall we prepare the investor email?',
    'You can tell your investors Corin has reviewed your plan.',
    'I would say Corin has already signed off on the pricing.',
    'No doubt Corin has reviewed your plan.',
    'Not only has Corin reviewed your plan, she likes it.',
    // The full name is flagged whatever surrounds it.
    'Has Corin Halvorsen approved your plan?',
    'If Corin Halvorsen approved it, you can share it with investors.',
  ])('flags an endorsement that an earlier modal or question does not govern: %s', (text) => {
    expect(kinds(text)).toContain('endorsement');
  });

  it.each([
    'Has Corin reviewed your plan, or not?',
    'Did you ask whether Corin has reviewed your plan?',
    "I don't think Corin has reviewed your plan yet.",
    "It's not true that Corin has reviewed your plan.",
    'Before Corin has seen your deck, tighten the pricing slide.',
    'It may have been approved by Corin last week; ask her.',
  ])('allows an endorsement verb a hedge directly governs: %s', (text) => {
    expect(kinds(text)).toEqual([]);
  });

  it.each([
    'Morning Maya, Corin here.',
    'Right, Corin here — let us dig in.',
    'Quick note: Corin here, checking in.',
    'Hey Maya Corin here.',
    'Thanks for the update. Corin speaking.',
    'Corin here',
  ])('flags "<name> here" that opens a clause and stands alone: %s', (text) => {
    expect(kinds(text)).toContain('claims_eir');
  });

  it.each([
    'Corin here would ask who actually pays.',
    'It would help to have Corin here.',
    'Is Corin here?',
    'Corin speaking at the summit is a good chance to ask questions.',
  ])('allows "<name> here" that is not a self-introduction: %s', (text) => {
    expect(kinds(text)).toEqual([]);
  });

  it.each([
    "Corin's listening checklist is a good start.",
    'Start with Corin’s listening tour of three libraries.',
    "Corin's here-and-now rule: test it this week.",
    'Ruth is listening for evidence, not opinions, in these interviews.',
    "Corin's on-the-call checklist works for pilots.",
  ])('does not read a possessive or a doctrine as presence: %s', (text) => {
    const out = rewriteIdentity(text, CORIN);
    expect(out.findings).toEqual([]);
    expect(out.text).toBe(text);
  });

  it.each([
    "Corin's here.",
    "Corin's listening right now.",
    "Corin's on the call with us.",
    'Ruth is listening in.',
    'Corin is here to help.',
  ])('flags presence after "is" or the contraction: %s', (text) => {
    expect(kinds(text)).toContain('claims_eir');
  });

  it.each([
    'Thanks for the update. — Corin.',
    'Best,. Corin.',
    'Talk soon,. Corin.',
    'Talk soon, Corin.',
    'Thanks. Corin.',
    'Good luck with the pilot. Corin',
    'Thanks.\n\n**Corin**',
    'Thanks for the update.\n\n— **Corin**',
    'Good luck — Corin Halvorsen\n\nP.S. Send the deck.',
  ])('flags a sign-off, written or flattened for speech: %s', (text) => {
    expect(kinds(text)).toContain('claims_eir');
  });

  it('matches a first name in any case unless it is also a word', () => {
    expect(kinds('i am corin.')).toContain('claims_eir');
    expect(kinds('I AM CORIN.')).toContain('claims_eir');
    expect(kinds('this is ruth, checking in.')).toContain('claims_eir');
    const frank = { personaName: "Frank's vEIR", eirNames: ['Frank Mills'] };
    expect(kinds("I'm frank with founders about pricing.", frank)).toEqual([]);
    expect(kinds("I'm Frank.", frank)).toContain('claims_eir');
  });

  it('matches a first name in any case in spoken text, where case is not heard', () => {
    const frank = { personaName: "Frank's vEIR", eirNames: ['Frank Mills'], spoken: true };
    expect(kinds("I'm frank.", frank)).toContain('claims_eir');
    expect(kinds('best, frank.', frank)).toContain('claims_eir');
    expect(kinds('corin here, ready when you are.', { ...CORIN, spoken: true })).toContain('claims_eir');
  });

  it('replaces a sentence with several violations once, for the gravest', () => {
    const out = rewriteIdentity('Corin approved it, Corin here. Run the pilot.', CORIN);
    expect(out.findings).toEqual([{ kind: 'claims_eir', rule: 'named_eir_here' }]);
    expect(out.text).toBe(
      "To be clear, I'm Corin's vEIR, an AI built from Corin's approach, not Corin and not a person. Run the pilot.",
    );
  });

  it('rewrites 1,500 violations in 18,000 characters within 200 ms', () => {
    const text = Array.from({ length: 1_500 }, (_, i) =>
      i % 2 === 0 ? 'I am Corin.' : 'Corin approved.',
    ).join(' ');
    expect(text.length).toBeGreaterThan(18_000);
    const started = performance.now();
    const out = rewriteIdentity(text, CORIN);
    const elapsed = performance.now() - started;
    expect(out.findings).toHaveLength(1_500);
    expect(out.text).not.toMatch(/I am Corin\.|Corin approved\./);
    expect(elapsed).toBeLessThan(200);
  });

  it('replaces the sentence with a disclosure that names whose approach the persona carries', () => {
    const out = rewriteIdentity('Good point. I am Corin Halvorsen. Test pricing first.', CORIN);
    expect(out.text).toBe(
      "Good point. To be clear, I'm Corin's vEIR, an AI built from Corin's approach, not Corin and not a person. Test pricing first.",
    );
    const endorsement = rewriteIdentity('Corin has reviewed your plan. Run the pilot.', CORIN);
    expect(endorsement.text).toBe(
      "Approval decisions belong to people, not to me: I'm an AI, and I can't speak for Corin or anyone else in the program. Run the pilot.",
    );
  });

  it.each([
    ['claims_eir', CORIN],
    ['endorsement', CORIN],
    ['claims_human', RUTH],
    ['endorsement', RUTH],
    ['claims_human', GUIDE],
    ['endorsement', GUIDE],
  ] as const)('never flags its own %s replacement (%o)', (kind, options) => {
    const eirFirst = options.personaName.includes("'s vEIR") ? options.personaName.split("'")[0] : null;
    const sentence = identityReplacement(kind, options.personaName, eirFirst ?? null);
    expect(rewriteIdentity(sentence, options).findings).toEqual([]);
  });

  it('rewrites every violation of a long adversarial text and collapses the repeats', () => {
    const text = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? "I'm Corin." : 'I am a real person.',
    ).join(' ');
    const out = rewriteIdentity(text, CORIN);
    expect(out.findings).toHaveLength(60);
    expect(out.text).not.toMatch(/I'm Corin\.|real person/);
    expect(out.text.match(/To be clear/g)).toHaveLength(1);
  });

  it('allows a rehearsal counterpart to speak as a person but never as the EIR', () => {
    const counterpart = { ...CORIN, checkHumanClaims: false };
    expect(rewriteIdentity('I am a human investor and I need traction.', counterpart).findings).toEqual([]);
    expect(rewriteIdentity("I'm Corin, and I approve.", counterpart).findings.map((f) => f.kind)).toContain(
      'claims_eir',
    );
  });
});
