import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { json, renderWithRouter, stubFetch, urlOf } from '@/features/knowledge/test-utils';
import { IDS, makeMemory } from '@/features/knowledge/testing';

import { MemoryDetail } from './memory-detail';

const MAYA = { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true };

beforeEach(() => {
  stubFetch().mockImplementation(() => Promise.resolve(json({ items: [] })));
});

describe('MemoryDetail', () => {
  it('says the vEIR learned it, links the conversation, and never credits the founder', async () => {
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({
          origin: 'ai',
          status: 'confirmed',
          createdBy: MAYA,
          sourceRefs: [{ kind: 'session', id: IDS.session, label: 'AI proposal' }],
        })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit={false}
      />,
    );
    const learned = screen.getByRole('link', { name: /^Learned from the conversation on / });
    expect(learned).toHaveAttribute('href', `/ain/app/v/${IDS.venture}/c/${IDS.session}`);
    expect(screen.queryByText(/Maya Okafor-Lindqvist/)).toBeNull();
    // The server's bookkeeping label is not shown as a source name.
    expect(screen.queryByText('AI proposal')).toBeNull();
    // Nothing waits for approval: no status badge for memory in use, no approve or reject.
    expect(screen.queryByText(/Proposed|Confirmed|approval/)).toBeNull();
  });

  it('shows an older suggestion as known, with Edit, Pin where it applies, and Forget', async () => {
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({ origin: 'ai', status: 'proposed', createdBy: MAYA })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit
      />,
    );
    expect(screen.queryByText('Proposed')).toBeNull();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(['Edit', 'Forget']));
    expect(buttons).not.toEqual(expect.arrayContaining(['Approve']));
    expect(screen.queryByRole('button', { name: /Approve|Reject|Keep|Dispute/ })).toBeNull();
  });

  it('names the person who added a memory themselves', async () => {
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({ origin: 'founder', status: 'confirmed', createdBy: MAYA, sourceRefs: [] })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit={false}
      />,
    );
    expect(screen.getByText(/^Added by Maya Okafor-Lindqvist on /)).toBeInTheDocument();
  });

  it('asks before forgetting, then forgets with the existing delete', async () => {
    const fetchMock = stubFetch().mockImplementation((_input, init) =>
      Promise.resolve(init?.method === 'PATCH' ? new Response(null, { status: 204 }) : json({ items: [] })),
    );
    await renderWithRouter(
      <MemoryDetail
        memory={makeMemory({ id: IDS.memory, status: 'confirmed' })}
        tenant="ain"
        ventureId={IDS.venture}
        canEdit
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Forget' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Forget this?' });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(urlOf(patch?.[0])).toContain(`/api/v1/memory/${IDS.memory}`);
  });
});
