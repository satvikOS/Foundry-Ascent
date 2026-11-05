import type { RiskCategory } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { classifyRisk } from './classifier.js';

/**
 * Escalation coverage from the live pilot 42099643194 (paraphrased patterns, never transcript text). Every escalation
 * in that run coincided with a classifier hit, so a topic the rules missed was never escalated, and a rule that matched
 * ordinary words escalated routine work on every turn.
 */
const categories = (text: string): readonly RiskCategory[] => classifyRisk(text).categories;

describe('missed escalations are now flagged', () => {
  it.each([
    // 18-02: a fair split asked for after a cofounder cut back to a few hours a week.
    ['My cofounder is down to a few hours a week. What is a fair split now?', 'securities_investment'],
    ['We started as equal partners but I do all the work now.', 'securities_investment'],
    ['How do we split the company if one of us goes part-time?', 'securities_investment'],
    // 05-06: other organisations' grant applications as a product asset (data rights).
    ["We want to build a library of other nonprofits' grant applications and sell access.", 'legal'],
    ["Can we train our model on other organizations' grant applications we collected?", 'legal'],
    // 09-15: a health outcome measured on people before any review.
    [
      'We will test the patch on 10 friends and measure their blood pressure each morning.',
      'medical_regulatory',
    ],
    ['Quick pilot with students to see if the app lowers their anxiety scores.', 'medical_regulatory'],
  ] as const)('%s → %s', (text, category) => {
    expect(categories(text)).toContain(category);
  });
});

describe('ordinary words no longer escalate', () => {
  it.each([
    // 03-18, 12-10, 15-11, 20-04, 25-15: routine pilot paperwork.
    'The school wants a pilot agreement with success criteria before we start.',
    'The pilot contract with the cafe runs six weeks, with three success metrics.',
    'Should the contract for the pilot run four weeks or six?',
    'We have an LOI and a pilot agreement draft covering the start date.',
    // 17-16: a maths-tutoring venture's "dosage" of sessions.
    'What tutoring dosage works best, two sessions a week or three?',
    'Research says the dosage of practice matters more than length.',
    // A fair split of work or costs is not an equity question.
    'What is a fair split of the work between me and my cofounder this sprint?',
    'We need an even split of the costs for the booth.',
  ])('%s', (text) => {
    const found = categories(text);
    expect(found).not.toContain('legal');
    expect(found).not.toContain('medical_regulatory');
    expect(found).not.toContain('securities_investment');
  });

  it.each([
    // Reviewer probes: a pilot, evaluation or beta agreement with a consequential term, or about to be signed.
    ['Should I sign the pilot agreement they sent? It gives them exclusivity for two years.', 'legal'],
    ['The beta agreement says the hospital owns any improvements we make.', 'legal'],
    ['Can you look over our evaluation agreement before Friday?', 'legal'],
    ['The pilot agreement has a six week term and a liability cap.', 'legal'],
    ['We are about to sign the pilot contract; it runs eight weeks.', 'legal'],
    // A dose next to a drug, a patient, an allergy or a study is clinical, whatever word precedes it.
    ['What exposure dosing is safe for the peanut allergy kids in our pilot?', 'medical_regulatory'],
    ['Our intervention dosing for the depression study needs to be set.', 'medical_regulatory'],
    ['What training dosing of the drug should we use?', 'medical_regulatory'],
    ['What practice dosage of the supplement is safe for patients?', 'medical_regulatory'],
    ['Exercise dosing for patients after surgery', 'medical_regulatory'],
  ] as const)('keeps the consequential sense: %s → %s', (text, category) => {
    expect(categories(text)).toContain(category);
  });

  it('still flags the clause inside a pilot agreement and a clinical dose (no weakening)', () => {
    expect(categories('Is the indemnity clause in our pilot agreement enforceable?')).toContain('legal');
    expect(categories('We have a pilot agreement with the clinic.')).toContain('legal');
    expect(categories('What dosage should the patch deliver?')).toContain('medical_regulatory');
    expect(categories('How should we split equity with the new cofounder?')).toContain(
      'securities_investment',
    );
  });
});
