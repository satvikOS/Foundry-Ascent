import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import { MemoryHistoryTimeline } from './memory-history';

const MEMORY = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e01';
const MAYA = {
  id: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
  displayName: 'Maya Okafor',
  title: null,
  synthetic: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MemoryHistoryTimeline', () => {
  it('shows an AI proposal as suggested by AI, and the founder’s approval as hers', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 1,
            memoryId: MEMORY,
            actor: MAYA,
            action: 'proposed',
            diff: { status: 'proposed', origin: 'ai', type: 'insight' },
            at: '2026-10-16T09:00:00.000Z',
          },
          {
            id: 2,
            memoryId: MEMORY,
            actor: MAYA,
            action: 'approved',
            diff: { status: 'confirmed' },
            at: '2026-10-16T09:05:00.000Z',
          },
        ],
      }),
    );
    renderWithProviders(<MemoryHistoryTimeline memoryId={MEMORY} />);
    expect(await screen.findByText('Suggested by AI')).toBeVisible();
    expect(screen.queryByText(/Proposed/)).toBeNull();
    expect(screen.getByText('by Maya Okafor')).toBeVisible();
    expect(screen.getAllByText(/by Maya Okafor/)).toHaveLength(1);
  });
});
