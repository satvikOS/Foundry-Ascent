import { describe, expect, it } from 'vitest';

import {
  attributeRows,
  daysUntil,
  decisionAttributes,
  experimentAttributes,
  milestoneAttributes,
  todayIso,
} from './attributes';
import { buildTypedAttributes } from './typed-memory-dialog';

describe('typed attribute parsing', () => {
  it('reads seed-shaped attributes and tolerates malformed fields', () => {
    expect(
      decisionAttributes({
        attributes: {
          rationale: ' Repeat use clustered ',
          alternatives: ['A', ' ', 'B'],
          decided_on: 'nope',
          owner: 3,
        },
      }),
    ).toEqual({ rationale: 'Repeat use clustered', alternatives: ['A', 'B'] });
    expect(
      experimentAttributes({ attributes: { status: 'running', sample_size: 200, prediction: 'x' } }),
    ).toMatchObject({ status: 'running', sample_size: 200, prediction: 'x' });
    expect(experimentAttributes({ attributes: { status: 'exploded' } }).status).toBeUndefined();
    expect(milestoneAttributes({ attributes: { target_date: '2026-11-01T00:00:00Z' } }).target_date).toBe(
      '2026-11-01',
    );
  });

  it('formats attribute rows for display', () => {
    const rows = attributeRows({
      riskiness: 'high',
      n: 14,
      reversal_condition: 'If repeat use < 15%',
      empty: '  ',
      list: [],
      // Which evidence a suggestion cited is bookkeeping, not something to show people.
      evidence_keys: ['E1', 'E2'],
    });
    expect(rows).toEqual([
      { key: 'riskiness', label: 'Riskiness', value: 'High' },
      { key: 'n', label: 'Sample (n)', value: '14' },
      { key: 'reversal_condition', label: 'Reversal condition', value: 'If repeat use < 15%' },
    ]);
  });

  it('computes whole days between local dates', () => {
    const now = new Date(2026, 9, 5, 23, 30);
    expect(todayIso(now)).toBe('2026-10-05');
    expect(daysUntil('2026-10-05', now)).toBe(0);
    expect(daysUntil('2026-10-08', now)).toBe(3);
    expect(daysUntil('2026-10-01', now)).toBe(-4);
  });
});

describe('buildTypedAttributes', () => {
  const base = {
    title: 't',
    content: 'c',
    visibility: 'venture' as const,
    owner: '',
    date: '',
    rationale: '',
    reversalCondition: '',
    alternatives: '',
    prediction: '',
    method: '',
    successCriteria: '',
    sampleSize: '',
    status: '',
    result: '',
    interpretation: '',
    decision: '',
    dependency: '',
  };

  it('maps decision fields, drops empties and keeps unknown keys', () => {
    expect(
      buildTypedAttributes(
        {
          ...base,
          kind: 'decision',
          owner: 'Maya',
          date: '2026-10-01',
          alternatives: 'A\n\n B ',
          rationale: '',
        },
        { legacy: true, rationale: 'old' },
      ),
    ).toEqual({ legacy: true, owner: 'Maya', decided_on: '2026-10-01', alternatives: ['A', 'B'] });
  });

  it('maps experiment and milestone fields', () => {
    expect(
      buildTypedAttributes({
        ...base,
        kind: 'experiment',
        prediction: 'p',
        method: 'm',
        sampleSize: '40',
        status: 'running',
      }),
    ).toEqual({ prediction: 'p', method: 'm', sample_size: 40, status: 'running' });
    // The resulting decision is editable, and clearing it removes it.
    expect(
      buildTypedAttributes(
        {
          ...base,
          kind: 'experiment',
          prediction: 'p',
          method: 'm',
          status: 'completed',
          decision: 'Pilot it',
        },
        { decision: 'Old call' },
      ),
    ).toEqual({ prediction: 'p', method: 'm', status: 'completed', decision: 'Pilot it' });
    expect(
      buildTypedAttributes(
        { ...base, kind: 'experiment', prediction: 'p', method: 'm', status: 'completed' },
        { decision: 'Old call' },
      ),
    ).toEqual({ prediction: 'p', method: 'm', status: 'completed' });
    expect(
      buildTypedAttributes({
        ...base,
        kind: 'milestone',
        date: '2026-12-01',
        status: 'at_risk',
        dependency: 'Pilot',
      }),
    ).toEqual({ target_date: '2026-12-01', status: 'at_risk', dependency: 'Pilot' });
  });
});
