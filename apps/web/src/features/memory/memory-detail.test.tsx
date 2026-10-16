import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { json, renderWithRouter, stubFetch } from '@/features/knowledge/test-utils';
import { IDS, makeMemory, NOW } from '@/features/knowledge/testing';

import { MemoryDetail } from './memory-detail';

const MAYA = { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true };
const SAM = {
  id: '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e16',
  displayName: 'Sam Teammate',
  title: null,
  synthetic: true,
};

/** The Provenance row labelled `label`: its value. */
function provenance(label: string): HTMLElement {
  const term = screen.getAllByRole('term').find((dt) => dt.textContent === label);
  const value = term?.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no ${label} row`);
  return value;
}

beforeEach(() => {
  stubFetch().mockImplementation(() => Promise.resolve(json({ items: [] })));
});

describe('MemoryDetail provenance', () => {
  it('credits a suggestion to the AI, not the person whose conversation it came from', async () => {
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({ origin: 'ai', status: 'proposed', createdBy: MAYA })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit={false}
      />,
    );
    expect(provenance('Created')).toHaveTextContent(/^Suggested by AI · /);
    expect(provenance('Created')).not.toHaveTextContent('Maya');
    // Not kept yet: no one is named.
    expect(screen.queryByText('Kept')).toBeNull();
    expect(screen.queryByText(/Maya Okafor-Lindqvist/)).toBeNull();
  });

  it('names who kept the suggestion, when known', async () => {
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({
          origin: 'ai',
          status: 'confirmed',
          createdBy: MAYA,
          approvedBy: SAM,
          approvedAt: NOW,
        })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit={false}
      />,
    );
    expect(provenance('Created')).toHaveTextContent(/^Suggested by AI · /);
    expect(provenance('Kept')).toHaveTextContent(/^Sam Teammate · /);
    expect(screen.queryByText(/Maya Okafor-Lindqvist/)).toBeNull();
  });

  it('still names the person who added a memory themselves', async () => {
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({
          origin: 'founder',
          status: 'confirmed',
          createdBy: MAYA,
          approvedBy: MAYA,
          approvedAt: NOW,
        })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit={false}
      />,
    );
    expect(provenance('Created')).toHaveTextContent(/^Maya Okafor-Lindqvist · /);
    expect(provenance('Approved')).toHaveTextContent(/^Maya Okafor-Lindqvist · /);
  });
});
