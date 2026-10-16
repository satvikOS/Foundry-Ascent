import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { DoctrineTab } from './doctrine-tab';
import { IDS, persona, RELEASE } from './test-fixtures';

describe('DoctrineTab', () => {
  it('shows the approved doctrine and style; editing saves a draft and opens Releases', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ ...RELEASE, id: IDS.lesson, version: 2, status: 'draft' }, 201),
    );
    const onOpenReleases = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DoctrineTab persona={persona()} onOpenReleases={onOpenReleases} />);
    expect(screen.getByText('Customer discovery first.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Style' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit doctrine & style' });
    expect(screen.getByText(/Saves draft v2, based on v1/)).toBeVisible();
    const summary = screen.getByRole('textbox', { name: /Summary/ });
    await user.clear(summary);
    await user.type(summary, 'Evidence before eloquence.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(onOpenReleases).toHaveBeenCalledOnce();
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/personas/${IDS.corin}/releases`);
    expect((sentJson(init) as { doctrine: { summary: string } }).doctrine.summary).toBe(
      'Evidence before eloquence.',
    );
    expect(form).not.toBeInTheDocument();
  });

  it('offers no edit to people who don’t curate the vEIR', () => {
    renderWithProviders(<DoctrineTab persona={persona({ canCurate: false })} onOpenReleases={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('points to a draft that is waiting for approval', async () => {
    const user = userEvent.setup();
    const onOpenReleases = vi.fn();
    renderWithProviders(
      <DoctrineTab
        persona={persona({
          releases: [
            ...persona().releases,
            { id: IDS.lesson, version: 2, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
          ],
        })}
        onOpenReleases={onOpenReleases}
      />,
    );
    expect(screen.getByText('Draft v2 is waiting for approval')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(onOpenReleases).toHaveBeenCalledOnce();
  });
});
