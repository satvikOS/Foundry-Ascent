import type { DocumentView, Me } from '@foundry/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { json, stubFetch, testQueryClient, urlOf } from '@/features/knowledge/test-utils';
import { IDS, makeDocument } from '@/features/knowledge/testing';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { QueryClientProvider } from '@tanstack/react-query';

import { DocumentsPage, reuploadChoice } from './documents-page';
import { FakeXhr } from './upload-testing';
import { VentureUploadsProvider } from './venture-uploads';

const ME: Me = {
  principal: { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: IDS.venture, ventureName: 'QuietQuad', role: 'founder' }],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
};

/** A document whose upload never finished: its file did not arrive. */
const UNFINISHED = makeDocument({
  filename: 'exam-week-interviews.md',
  sizeBytes: 769,
  status: 'failed',
  failureReason: 'upload_incomplete',
  chunkCount: 0,
});

const sameFile = () =>
  new File(['x'.repeat(UNFINISHED.sizeBytes)], UNFINISHED.filename, { type: 'text/markdown' });

let calls: string[] = [];
let lastRouter: { state: { location: { search: unknown } } } | null = null;

function stubApi(documents: DocumentView[]) {
  calls = [];
  stubFetch().mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'GET' && url.endsWith(`/ventures/${IDS.venture}/documents`)) {
      return Promise.resolve(json({ items: documents }));
    }
    if (method === 'POST' && url.endsWith(`/documents/${IDS.document}/upload`)) {
      return Promise.resolve(
        json({
          document: { ...UNFINISHED, status: 'pending_upload', failureReason: null },
          upload: {
            url: 'https://uploads.test/renewed',
            method: 'PUT',
            headers: { 'content-type': 'text/markdown' },
            expiresAt: '2026-10-01T12:05:00.000Z',
          },
        }),
      );
    }
    if (method === 'POST' && url.endsWith(`/documents/${IDS.document}/complete`)) {
      return Promise.resolve(json({ ...UNFINISHED, status: 'processing', failureReason: null }, 202));
    }
    return Promise.resolve(json({ items: [] }));
  });
}

async function renderDocuments() {
  const client = testQueryClient();
  client.setQueryData(meQueryOptions().queryKey, ME);
  const root = createRootRoute({ component: Outlet });
  const venture = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId',
    component: function VentureLayout() {
      const { ventureId } = useParams({ strict: false });
      if (!ventureId) throw new Error('no venture');
      return (
        <VentureUploadsProvider ventureId={ventureId}>
          <Outlet />
        </VentureUploadsProvider>
      );
    },
  });
  const documents = createRoute({
    getParentRoute: () => venture,
    path: 'documents',
    component: DocumentsPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([venture.addChildren([documents])]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${IDS.venture}/documents`] }),
  });
  lastRouter = router;
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
  const list = await screen.findByRole('list', { name: 'Venture documents' });
  return within(list).getByRole('listitem', { name: UNFINISHED.filename });
}

/** The picker Retry opens: the file input for one file (Upload files takes several). */
function reuploadInput(): HTMLInputElement {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
    (i) => !i.multiple,
  );
  if (!input) throw new Error('no reupload input');
  return input;
}

beforeEach(() => {
  FakeXhr.sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Opening a document', () => {
  it('opens it in the viewer from its name, over the Documents page', async () => {
    stubApi([{ ...UNFINISHED, status: 'ready', failureReason: null }]);
    const row = await renderDocuments();
    const link = within(row).getByRole('link', { name: UNFINISHED.filename });
    // A real link: it can open in a new tab too.
    expect(link).toHaveAttribute('href', `/ain/app/v/${IDS.venture}/documents?doc=${IDS.document}`);
    await userEvent.setup().click(link);
    expect(lastRouter?.state.location.search).toEqual({ doc: IDS.document });
  });
});

describe('Retry on a document whose upload never finished', () => {
  it('asks for the file again and uploads it into the same document', async () => {
    stubApi([UNFINISHED]);
    const row = await renderDocuments();
    expect(row).toHaveTextContent('The upload didn’t finish. Upload the file again.');
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click');

    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Retry' }));
    // The file picker opened; processing was not restarted for a file that never arrived.
    expect(picker.mock.contexts).toContain(reuploadInput());
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);

    await user.upload(reuploadInput(), sameFile());
    await waitFor(() => {
      expect(FakeXhr.sent).toHaveLength(1);
    });
    expect(FakeXhr.sent[0]?.url).toBe('https://uploads.test/renewed');
    act(() => {
      FakeXhr.sent[0]?.succeed();
    });
    await waitFor(() => {
      expect(calls).toContain(`POST /api/v1/documents/${IDS.document}/complete`);
    });
    // A fresh URL for the same document; no second document was registered.
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      `POST /api/v1/documents/${IDS.document}/upload`,
      `POST /api/v1/documents/${IDS.document}/complete`,
    ]);
  });

  it('explains when the chosen file is not the one that didn’t finish, and uploads nothing', async () => {
    stubApi([UNFINISHED]);
    const row = await renderDocuments();
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Retry' }));
    await user.upload(reuploadInput(), new File(['# Other'], 'budget.md', { type: 'text/markdown' }));

    const title = await screen.findByText('One file wasn’t uploaded');
    expect(title.closest('[data-slot="alert"]')).toHaveTextContent(
      'budget.md: This isn’t exam-week-interviews.md (769 B). Choose that file, or use Upload files.',
    );
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it('still restarts processing for a document whose file arrived', async () => {
    const failedProcessing = { ...UNFINISHED, failureReason: 'empty_text' };
    stubApi([failedProcessing]);
    const row = await renderDocuments();
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(calls).toContain(`POST /api/v1/documents/${IDS.document}/complete`);
    });
  });
});

describe('reuploadChoice', () => {
  it('takes only the document’s own file', () => {
    expect(reuploadChoice([sameFile()], UNFINISHED)).toMatchObject({
      accepted: { resume: { documentId: IDS.document, uploaded: false } },
    });
    const bigger = new File(['x'.repeat(UNFINISHED.sizeBytes + 1)], UNFINISHED.filename, {
      type: 'text/markdown',
    });
    expect(reuploadChoice([bigger], UNFINISHED)).toMatchObject({ rejected: { code: 'different_file' } });
    expect(reuploadChoice([], UNFINISHED)).toBeNull();
  });
});
