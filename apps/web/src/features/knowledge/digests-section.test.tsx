import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionsQueryOptions } from '@/lib/api/hooks/sessions';

import { DigestsSection } from './digests-section';
import { renderWithRouter, stubFetch, testQueryClient } from './test-utils';
import { IDS, makeSession, NOW } from './testing';

beforeEach(() => {
  stubFetch();
});

describe('DigestsSection', () => {
  it('labels digests as the vEIR’s AI notes and lists each one with its commitments', async () => {
    const client = testQueryClient();
    const repeated = { text: 'Interview five library staff', due: null };
    client.setQueryData(sessionsQueryOptions(IDS.venture).queryKey, {
      items: [
        makeSession({
          digest: {
            summary: 'Maya reviewed the seat-map test and chose to rerun it before finals.',
            topics: ['Seat-map test'],
            commitments: [repeated, { ...repeated, due: '2026-10-08' }],
            openQuestions: [],
            generatedAt: NOW,
          },
        }),
      ],
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderWithRouter(<DigestsSection ventureId={IDS.venture} tenant="ain" canEdit />, client);

    expect(screen.getByText('AI notes')).toBeInTheDocument();
    expect(screen.getByText(/What Corin’s vEIR took from each conversation/)).toBeInTheDocument();
    expect(screen.getByText(/never treated as facts/)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Conversation digests' });
    expect(list).toHaveTextContent('Maya reviewed the seat-map test');
    expect(within(list).getAllByText('Interview five library staff')).toHaveLength(2);
    // Two commitments with the same text render without a key collision.
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false);
    consoleError.mockRestore();
  });
});
