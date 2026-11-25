import { CoachAnnotations } from '../gateway/coach-annotations.js';
import { describe, expect, it } from 'vitest';

import { SERVICE_OR_PRODUCT, TODAY } from '../testing/path-fixtures.js';
import { PathAnnotations, annotationsOfPath } from './annotations.js';
import { buildSystemPromptParts } from './system.js';

const FIELDS = {
  mode: 'coach',
  claims: [
    { kind: 'recommendation', text: 'Sell it as a service first', evidence_ids: null, confidence: 'medium' },
  ],
  escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
  memory_candidates: [],
  path_report: null,
};

describe('the fields of a reply on the path', () => {
  it('a claim or a memory without its list of ids is whole, never a repair call', () => {
    // First live run on Nova 2 Lite: 8% of the annotation calls were repaired for this alone.
    for (const ids of [null, undefined, []]) {
      const parsed = PathAnnotations.safeParse({
        ...FIELDS,
        claims: [{ ...FIELDS.claims[0], evidence_ids: ids }],
        memory_candidates: [
          {
            type: 'fact',
            title: 'Labs pay',
            content: 'Two labs pay.',
            evidence_ids: ids,
            confidence: 0.8,
            source: 'founder_stated',
          },
        ],
      });
      expect(parsed.error?.issues ?? []).toEqual([]);
      if (!parsed.success) continue;
      const fields = annotationsOfPath(parsed.data);
      expect(fields.claims[0]?.evidence_ids).toEqual([]);
      expect(fields.memory_candidates[0]?.evidence_ids).toEqual([]);
      // What every turn stores: whole.
      expect(CoachAnnotations.safeParse(fields).success).toBe(true);
    }
  });

  it('asks only for what the model alone can give, on a prompt without the reply’s rules', () => {
    const parts = buildSystemPromptParts({
      release: {
        version: 1,
        personaName: 'Thomas',
        mentor: true,
        disclosureText: '',
        doctrine: {
          summary: 'Talk first.',
          frameworks: [],
          evidenceStandard: 'Behaviour.',
          typicalQuestions: [],
          redLines: [],
          escalationTopics: ['Safety of a person'],
          referralDestinations: [],
          teachingPrinciples: [],
        },
        style: {
          directness: 'direct',
          warmth: 'warm',
          pace: 'brisk',
          vocabulary: [],
          feedbackStructure: '',
          avoid: [],
        },
      },
      mode: 'auto',
      policy: { riskCategories: [], groundingThreshold: 0.6 },
      ventureContext: { name: 'BenchTally', stage: 'discovery', domain: 'software', currentGoal: null },
      today: TODAY,
      guidance: SERVICE_OR_PRODUCT,
    });
    const fields = parts.annotation ?? '';
    for (const kept of [
      '- claims:',
      '- escalation:',
      '- path_report:',
      '- memory_candidates:',
      'founder_stated',
    ])
      expect(fields).toContain(kept);
    for (const gone of [
      '- next_actions:',
      '- follow_up_questions:',
      '- rehearsal:',
      '- uncertainty:',
      '- challenge:',
      '<path>',
    ])
      expect(fields).not.toContain(gone);
    // The whole of it, rules and all, is shorter than the fields' part of the old one alone.
    expect(fields.length).toBeLessThan(parts.turn.length);
    expect(fields.length).toBeLessThan((parts.stable.length + parts.turn.length) * 0.4);
    for (const rule of [
      'untrusted DATA',
      'nothing of any other venture',
      'Always: Safety of a person',
      '<name>BenchTally</name>',
    ])
      expect(fields).toContain(rule);
    for (const talk of ['# How you talk', '# Conversation craft', '# Persona doctrine', 'Talk first.'])
      expect(fields).not.toContain(talk);
    expect(fields).toContain('[control]');
  });
});
