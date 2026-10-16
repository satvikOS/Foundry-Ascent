import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithRouter } from '@/features/knowledge/test-utils';
import { IDS, makeEvidence } from '@/features/knowledge/testing';

import { EvidenceItemCard, evidenceKindLabel } from './evidence-item';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const venture = { tenant: 'ain', ventureId: IDS.venture };

describe('evidenceKindLabel', () => {
  it('says where a passage comes from by its source, not by its kind alone', () => {
    const label = (item: Parameters<typeof evidenceKindLabel>[0]) =>
      evidenceKindLabel(item, "Corin's vEIR").label;
    expect(label({ kind: 'chunk', source: { id: SOURCE, scope: 'venture' } })).toBe('Venture document');
    // A program handbook passage is a chunk too: it is never called a venture document.
    expect(label({ kind: 'chunk', source: { id: SOURCE, scope: 'program' } })).toBe('Program guidance');
    expect(label({ kind: 'chunk', source: { id: SOURCE, scope: 'public' } })).toBe('Program guidance');
    expect(label({ kind: 'doctrine', source: { id: SOURCE, scope: 'persona' } })).toBe(
      "Corin's vEIR’s library",
    );
    expect(label({ kind: 'doctrine' })).toBe("Corin's vEIR’s library");
    expect(label({ kind: 'chunk', source: null })).toBe('Passage');
    expect(label({ kind: 'memory' })).toBe('Venture memory');
  });
});

describe('EvidenceItemCard', () => {
  it('links a venture document passage to that document', async () => {
    await renderWithRouter(
      <EvidenceItemCard
        item={makeEvidence({
          key: 'E2',
          kind: 'chunk',
          title: 'exam-week-interviews.md — Findings',
          source: { id: SOURCE, scope: 'venture' },
        })}
        venture={venture}
      />,
    );
    expect(screen.getByText('Venture document')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open document' });
    expect(link).toHaveAttribute('href', `/ain/app/v/${IDS.venture}/documents?source=${SOURCE}`);
  });

  it('links a library or program passage to its row in Evidence', async () => {
    await renderWithRouter(
      <EvidenceItemCard
        item={makeEvidence({
          key: 'E3',
          kind: 'doctrine',
          title: 'exam-week-interviews.md',
          source: { id: SOURCE, scope: 'persona' },
        })}
        veirName="Corin's vEIR"
        venture={venture}
      />,
    );
    expect(screen.getByText("Corin's vEIR’s library")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open document' })).toBeNull();
    expect(screen.getByRole('link', { name: 'See in Evidence' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/knowledge?view=evidence&source=${SOURCE}`,
    );
  });

  it('links nothing for memory or a passage of unknown source', async () => {
    await renderWithRouter(
      <>
        <EvidenceItemCard item={makeEvidence({ key: 'E1' })} venture={venture} />
        <EvidenceItemCard item={makeEvidence({ key: 'E4', kind: 'chunk', source: null })} venture={venture} />
      </>,
    );
    expect(screen.queryAllByRole('link')).toEqual([]);
  });
});
