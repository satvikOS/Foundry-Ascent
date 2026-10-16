import type { AdminInsights } from '@foundry/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { jsonResponse, renderWithProviders, stubFetch } from '../shared/test-utils';
import { formatSeconds, InsightsSection } from './insights-section';

const INSIGHTS: z.infer<typeof AdminInsights> = {
  days: 30,
  conversations: [
    { channel: 'text', conversations: 4, turns: 22, averageTurns: 5.5 },
    { channel: 'voice', conversations: 2, turns: 14, averageTurns: 7 },
  ],
  privateConversations: 1,
  calls: { calls: 3, minutes: 21.5 },
  distillation: { upToDate: 3, pending: 2, running: 1, dropped: 1, failed: 0 },
  memory: [
    {
      ventureId: '22222222-2222-4222-8222-222222222222',
      ventureName: 'QuietQuad',
      digests: 5,
      proposed: 4,
      confirmed: 2,
      other: 1,
    },
  ],
  latency: [
    { channel: 'text', turns: 22, p50Ms: 4200, p95Ms: 9100, firstWordsP50Ms: 1500, firstWordsP95Ms: 2600 },
    { channel: 'voice', turns: 14, p50Ms: 3100, p95Ms: 6400, firstWordsP50Ms: 1200, firstWordsP95Ms: null },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InsightsSection (Admin → Usage)', () => {
  it('shows conversations, memory and answer times as counts, from GET /admin/insights', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(INSIGHTS));
    renderWithProviders(<InsightsSection />);

    const section = await screen.findByRole('region', { name: 'Conversations and memory' });
    expect(await within(section).findByText('Chat conversations')).toBeVisible();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/insights');
    expect(within(section).getByText('Conversations with a call').nextSibling).toHaveTextContent('2');
    expect(within(section).getByText('Waiting to be remembered').nextSibling).toHaveTextContent('3');
    expect(within(section).getByText('Private conversations').nextSibling).toHaveTextContent(
      '1· never remembered',
    );
    const memory = within(section).getByRole('table', { name: 'What each venture’s vEIR remembers' });
    expect(within(memory).getByRole('row', { name: /QuietQuad/ })).toHaveTextContent('QuietQuad5421');
    const times = within(section).getByRole('table', { name: 'How long answers take, last 30 days' });
    expect(within(times).getByRole('row', { name: /Calls/ })).toHaveTextContent('Calls141.2 s3.1 s6.4 s');
  });

  it('stays out of the way when the request fails', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ code: 'forbidden', title: 'Forbidden', status: 403 }, 403));
    const { container } = renderWithProviders(<InsightsSection />);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('formats milliseconds as seconds', () => {
    expect(formatSeconds(1840)).toBe('1.8 s');
    expect(formatSeconds(null)).toBe('—');
  });
});
