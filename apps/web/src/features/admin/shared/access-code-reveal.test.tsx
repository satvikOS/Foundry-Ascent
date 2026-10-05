import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { IssuedAccessCode } from '@/lib/api/hooks/team';

import { IssueAccessCodeDialog } from '../principals/issue-access-code-dialog';
import { AccessCodeRevealDialog } from './access-code-reveal';
import { jsonResponse, renderWithProviders, sentJson, stubFetch } from './test-utils';

const PRINCIPAL = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  displayName: 'Avery Example',
  title: 'EIR',
  synthetic: true,
};

const ISSUED: IssuedAccessCode = {
  accessCodeId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  principal: PRINCIPAL,
  accessCode: 'FA-ABCDE-FGHJK-MNPQR-STVWX',
  expiresAt: '2026-11-04T12:00:00.000Z',
};

function Harness({ onDone }: { onDone: () => void }) {
  const [issued, setIssued] = useState<IssuedAccessCode | null>(ISSUED);
  return (
    <AccessCodeRevealDialog
      issued={issued}
      onDone={() => {
        setIssued(null);
        onDone();
      }}
    />
  );
}

describe('AccessCodeRevealDialog (one-time reveal)', () => {
  it('shows the code once with a store-it-now warning and copies it', async () => {
    // user-event installs a clipboard stub on navigator during setup().
    const user = userEvent.setup();
    renderWithProviders(<Harness onDone={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: /Access code for Avery Example/ });
    expect(within(dialog).getByTestId('access-code-value')).toHaveTextContent('FA-ABCDE-FGHJK-MNPQR-STVWX');
    expect(within(dialog).getByText('Store it now — it won’t be shown again')).toBeVisible();
    expect(within(dialog).getByText(/keeps only a one-way hash/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Copy code' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('FA-ABCDE-FGHJK-MNPQR-STVWX');
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('cannot be dismissed until the person confirms they stored it, then forgets the code', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderWithProviders(<Harness onDone={onDone} />);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /stored this code somewhere safe/ }));
    expect(done).toBeEnabled();
    await user.click(done);

    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(document.body).not.toHaveTextContent('FGHJK');
  });
});

describe('IssueAccessCodeDialog (issue → reveal → discard)', () => {
  it('issues a code, reveals it once, and keeps it out of the query cache afterwards', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUED, 201));
    // The principals list is refetched after issuing.
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { client } = renderWithProviders(
      <IssueAccessCodeDialog
        recipient={{ id: PRINCIPAL.id, displayName: PRINCIPAL.displayName }}
        onClose={onClose}
      />,
    );

    const form = screen.getByRole('dialog', { name: 'Issue access code' });
    const label = within(form).getByLabelText(/Label/);
    await user.clear(label);
    await user.type(label, 'demo day');
    await user.click(within(form).getByRole('button', { name: 'Issue code' }));

    const reveal = await screen.findByRole('alertdialog');
    expect(within(reveal).getByTestId('access-code-value')).toHaveTextContent(ISSUED.accessCode);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/admin/principals/${PRINCIPAL.id}/access-codes`);
    expect(init?.method).toBe('POST');
    expect(sentJson(init)).toEqual({ label: 'demo day', expiresInDays: 30 });

    await user.click(within(reveal).getByRole('checkbox'));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(document.body).not.toHaveTextContent(ISSUED.accessCode);
    // Nothing in the query or mutation caches still holds the plaintext code.
    const cached = JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(ISSUED.accessCode);
  });

  it('validates the label before calling the API', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    renderWithProviders(
      <IssueAccessCodeDialog
        recipient={{ id: PRINCIPAL.id, displayName: PRINCIPAL.displayName }}
        onClose={vi.fn()}
      />,
    );
    const label = screen.getByLabelText(/Label/);
    await user.clear(label);
    await user.click(screen.getByRole('button', { name: 'Issue code' }));
    expect(await screen.findByText('Add a label so you can recognise this code later.')).toBeVisible();
    expect(label).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
