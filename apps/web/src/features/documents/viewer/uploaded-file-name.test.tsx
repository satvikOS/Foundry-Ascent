import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AttachmentTray } from '@/features/chat/attachments';
import { testQueryClient } from '@/features/knowledge/test-utils';
import { IDS } from '@/features/knowledge/testing';

import type { UploadItem } from '../upload-queue';

function item(overrides: Partial<UploadItem>): UploadItem {
  return {
    id: 'u1',
    file: new File(['# Notes'], 'pilot-terms.md', { type: 'text/markdown' }),
    origin: 'new-chat',
    status: 'done',
    progress: 100,
    error: null,
    resume: { documentId: IDS.document, uploaded: true },
    ...overrides,
  };
}

async function renderTray(items: UploadItem[]) {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId',
    component: () => (
      <AttachmentTray
        items={items}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${IDS.venture}`] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return router;
}

describe('attached-file chips', () => {
  it('open the uploaded document in the viewer once the upload is done', async () => {
    const router = await renderTray([item({})]);
    await userEvent.setup().click(screen.getByRole('link', { name: 'pilot-terms.md' }));
    expect(router.state.location.search).toEqual({ doc: IDS.document });
  });

  it('are plain names while the file is still uploading', async () => {
    await renderTray([item({ status: 'uploading', progress: 40 })]);
    expect(screen.getByText('pilot-terms.md')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'pilot-terms.md' })).toBeNull();
  });
});
