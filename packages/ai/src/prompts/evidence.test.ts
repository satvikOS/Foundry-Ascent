import { type EvidenceItem } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { buildEvidenceBlock, REFERENCE_RULES } from './evidence.js';

const reference: EvidenceItem = {
  key: 'E2',
  kind: 'chunk',
  refId: '7b0c2a52-5d1f-5b8e-9a65-2f7d0f0e0a01',
  title:
    'NONA Technologies: Choosing a viable initial market — Documented account · MIT / J-WAFS, evidence as of 2024-10-02',
  excerpt:
    'Reported outcome: Crawford reported that the first 24 interviews ruled out those markets and helped identify a ' +
    'beachhead.\n\nEvidence limits: The article does not name that beachhead or disclose interview-to-sale conversion.',
  score: 0.3,
  freshnessAt: '2026-11-02T00:00:00.000Z',
  status: 'active',
  source: { id: '7b0c2a52-5d1f-5b8e-9a65-2f7d0f0e0a02', scope: 'public' },
};

const program: EvidenceItem = {
  ...reference,
  key: 'E1',
  refId: '7b0c2a52-5d1f-5b8e-9a65-2f7d0f0e0a03',
  title: 'Foundry venture-building method (synthetic program handbook) — Stage gates',
  excerpt: 'Ventures move through idea, discovery, validation…',
  source: { id: '7b0c2a52-5d1f-5b8e-9a65-2f7d0f0e0a04', scope: 'program' },
};

describe('evidence block: the shared reference library', () => {
  it('marks a reference passage and says how to use it: its publisher named, its limits kept, no estimates', () => {
    const block = buildEvidenceBlock([program, reference]);
    expect(block).toContain('<item id="E2" kind="chunk" source="reference" ');
    expect(block).toContain('<item id="E1" kind="chunk" status=');
    // The citation the coach can give: the real source's title and publisher, in the item's title.
    expect(block).toContain(
      '<title>NONA Technologies: Choosing a viable initial market — Documented account · MIT / J-WAFS',
    );
    expect(block).toContain('does not name that beachhead or disclose interview-to-sale conversion');
    for (const line of REFERENCE_RULES) expect(block).toContain(line);
    const rules = REFERENCE_RULES.join(' ');
    expect(rules).toMatch(/prefer the program's guidance/);
    expect(rules).toMatch(/editorial are suggestions, never facts/);
    expect(rules).toMatch(/say it is not\s+reported; never estimate it/);
  });

  it('says nothing about the library when no reference passage was retrieved', () => {
    const block = buildEvidenceBlock([program]);
    expect(block).not.toContain('source="reference"');
    expect(block).not.toContain(REFERENCE_RULES[0]);
    expect(buildEvidenceBlock([])).not.toContain(REFERENCE_RULES[0]);
  });
});
