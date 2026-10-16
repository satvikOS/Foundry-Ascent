import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem, stubFetch, urlOf } from '@/features/knowledge/test-utils';
import { IDS, makeDocument } from '@/features/knowledge/testing';

import { FakeXhr } from './upload-testing';
import { DOCUMENTS_ORIGIN, type QueuedUpload } from './upload-queue';
import { useVentureUploads, VentureUploadsProvider } from './venture-uploads';

const DOC_ID = IDS.document;
const file = new File(['# Interview notes\n\nSeven students.'], 'interviews.md', { type: 'text/markdown' });
const ticket = (url: string) => ({
  document: makeDocument({ id: DOC_ID, filename: 'interviews.md', status: 'pending_upload', chunkCount: 0 }),
  upload: {
    url,
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    expiresAt: '2026-10-01T12:05:00.000Z',
  },
});

let fetchMock: ReturnType<typeof stubFetch>;

function calls() {
  return fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${urlOf(input)}`);
}

beforeEach(() => {
  FakeXhr.sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  fetchMock = stubFetch();
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith(`/ventures/${IDS.venture}/documents`)) {
      return Promise.resolve(json(ticket('https://uploads.test/first'), 201));
    }
    if (method === 'POST' && url.endsWith(`/documents/${DOC_ID}/upload`)) {
      return Promise.resolve(json(ticket('https://uploads.test/renewed')));
    }
    if (method === 'POST' && url.endsWith(`/documents/${DOC_ID}/abandon`)) {
      return Promise.resolve(
        json(makeDocument({ id: DOC_ID, status: 'failed', failureReason: 'upload_incomplete' })),
      );
    }
    if (method === 'POST' && url.endsWith(`/documents/${DOC_ID}/complete`)) {
      return Promise.resolve(json(makeDocument({ id: DOC_ID, status: 'processing' }), 202));
    }
    if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json({ items: [] }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderQueue() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <VentureUploadsProvider ventureId={IDS.venture}>{children}</VentureUploadsProvider>
    </QueryClientProvider>
  );
  // Uploads from the Documents page (the venture's queue, as that page adds to it).
  return renderHook(
    () => {
      const queue = useVentureUploads(IDS.venture);
      return {
        ...queue,
        add: (candidates: readonly QueuedUpload[]) => {
          queue.add(candidates, DOCUMENTS_ORIGIN);
        },
      };
    },
    { wrapper },
  );
}

async function sentPut(count: number): Promise<FakeXhr> {
  await waitFor(() => {
    expect(FakeXhr.sent).toHaveLength(count);
  });
  const xhr = FakeXhr.sent[count - 1];
  if (!xhr) throw new Error('no PUT');
  return xhr;
}

describe('upload lifecycle', () => {
  it('marks a failed upload unfinished, and Retry reuses the same document', async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.add([{ file, contentType: 'text/markdown' }]);
    });
    act(() => {
      void sentPut(1).then((xhr) => {
        xhr.fail();
      });
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });
    expect(calls()).toContain(`POST /api/v1/documents/${DOC_ID}/abandon`);

    act(() => {
      result.current.retry(result.current.items[0]?.id ?? '');
    });
    const again = await sentPut(2);
    expect(again.url).toBe('https://uploads.test/renewed');
    act(() => {
      again.succeed();
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('done');
    });
    const writes = calls().filter((c) => !c.startsWith('GET'));
    // One registration only: the retry asked for a fresh URL to the same document.
    expect(writes.filter((c) => c === `POST /api/v1/ventures/${IDS.venture}/documents`)).toHaveLength(1);
    expect(writes).toContain(`POST /api/v1/documents/${DOC_ID}/upload`);
    expect(writes.at(-1)).toBe(`POST /api/v1/documents/${DOC_ID}/complete`);
  });

  it('deletes the document when the person cancels the upload', async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.add([{ file, contentType: 'text/markdown' }]);
    });
    const xhr = await sentPut(1);
    act(() => {
      result.current.cancel(result.current.items[0]?.id ?? '');
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('cancelled');
    });
    expect(xhr.aborted).toBe(true);
    await waitFor(() => {
      expect(calls()).toContain(`DELETE /api/v1/documents/${DOC_ID}`);
    });
    expect(calls()).not.toContain(`POST /api/v1/documents/${DOC_ID}/abandon`);
  });

  it('marks the upload unfinished (not deleted) when the person leaves the venture mid-upload', async () => {
    const { result, unmount } = renderQueue();
    act(() => {
      result.current.add([{ file, contentType: 'text/markdown' }]);
    });
    await sentPut(1);
    unmount();
    await waitFor(() => {
      expect(calls()).toContain(`POST /api/v1/documents/${DOC_ID}/abandon`);
    });
    expect(calls()).not.toContain(`DELETE /api/v1/documents/${DOC_ID}`);
  });

  it('deletes a failed upload’s document when the person removes it from the list', async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.add([{ file, contentType: 'text/markdown' }]);
    });
    (await sentPut(1)).fail();
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });
    act(() => {
      result.current.dismiss(result.current.items[0]?.id ?? '');
    });
    expect(result.current.items).toHaveLength(0);
    await waitFor(() => {
      expect(calls()).toContain(`DELETE /api/v1/documents/${DOC_ID}`);
    });
  });

  it('uploads a file into the unfinished document it is given, without registering another', async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.add([
        { file, contentType: 'text/markdown', resume: { documentId: DOC_ID, uploaded: false } },
      ]);
    });
    (await sentPut(1)).succeed();
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('done');
    });
    const writes = calls().filter((c) => !c.startsWith('GET'));
    expect(writes).toEqual([
      `POST /api/v1/documents/${DOC_ID}/upload`,
      `POST /api/v1/documents/${DOC_ID}/complete`,
    ]);
  });

  it('registers a new document when the earlier one is gone by the time of the retry', async () => {
    const { result } = renderQueue();
    act(() => {
      result.current.add([{ file, contentType: 'text/markdown' }]);
    });
    (await sentPut(1)).fail();
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) =>
      init?.method === 'POST' && urlOf(input).endsWith(`/documents/${DOC_ID}/upload`)
        ? Promise.resolve(problem(404, 'not_found'))
        : (base?.(input, init) ?? Promise.resolve(json({}))),
    );
    act(() => {
      result.current.retry(result.current.items[0]?.id ?? '');
    });
    (await sentPut(2)).succeed();
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('done');
    });
    expect(calls().filter((c) => c === `POST /api/v1/ventures/${IDS.venture}/documents`)).toHaveLength(2);
  });
});
