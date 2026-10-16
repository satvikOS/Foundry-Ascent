import type { CallConfigResponse } from '@foundry/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';

import { callNoticeCacheKey, useCallNotice } from './call-notice';

const ME = '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06';
const AT = '2026-10-16T09:00:00.000Z';
const KEY = ['venture', 'v1', 'call-config'] as const;

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** The hook as the call screen uses it: fed by the cached call settings. */
function useNoticeFromCache() {
  const config = useQuery<CallConfigResponse>({ queryKey: KEY, queryFn: () => new Promise(() => undefined) });
  return useCallNotice(ME, config.data);
}

function settings(callNoticeAcknowledgedAt: string | null): CallConfigResponse {
  return {
    veir: {} as never,
    provider: 'builtin',
    maxMinutes: 30,
    remainingMinutesToday: 60,
    aiEnabled: true,
    callsEnabled: true,
    callNoticeAcknowledgedAt,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCallNotice', () => {
  it('shows the notice until the server says the person acknowledged it', () => {
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ config }: { config: CallConfigResponse | undefined }) => useCallNotice(ME, config),
      { wrapper: wrapper(client), initialProps: { config: settings(null) } },
    );
    expect(result.current[0]).toBe(false);
    rerender({ config: settings(AT) });
    expect(result.current[0]).toBe(true);
    // The answer is cached for this person, for the moment before the settings load next time.
    expect(window.localStorage.getItem(callNoticeCacheKey(ME))).toBe(AT);
  });

  it('uses the browser cache only until the server answers, and the server wins', () => {
    window.localStorage.setItem(callNoticeCacheKey(ME), AT);
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ config }: { config: CallConfigResponse | undefined }) => useCallNotice(ME, config),
      { wrapper: wrapper(client), initialProps: { config: undefined as CallConfigResponse | undefined } },
    );
    expect(result.current[0]).toBe(true);
    // Another browser's copy, a cleared account, a different person: the server says not yet.
    rerender({ config: settings(null) });
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(callNoticeCacheKey(ME))).toBeNull();
    // Nothing cached and nothing loaded: the notice shows.
    rerender({ config: undefined });
    expect(result.current[0]).toBe(false);
  });

  it('shows the notice to a second person on the same browser, whatever the first one acknowledged', () => {
    const OTHER = '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c99';
    window.localStorage.setItem(callNoticeCacheKey(ME), AT);
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ config }: { config: CallConfigResponse | undefined }) => useCallNotice(OTHER, config),
      { wrapper: wrapper(client), initialProps: { config: undefined as CallConfigResponse | undefined } },
    );
    // Before the call settings load (nothing cached for this person), and after (the server says not yet).
    expect(result.current[0]).toBe(false);
    rerender({ config: settings(null) });
    expect(result.current[0]).toBe(false);
    // The first person's cached answer is untouched.
    expect(window.localStorage.getItem(callNoticeCacheKey(ME))).toBe(AT);
  });

  it('stores the acknowledgement on the server and updates the loaded call settings', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ acknowledgedAt: AT }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(KEY, settings(null));
    const { result } = renderHook(() => useNoticeFromCache(), { wrapper: wrapper(client) });
    expect(result.current[0]).toBe(false);

    act(() => {
      result.current[1]();
    });
    await waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/calls/notice/acknowledge');
    expect(init?.method).toBe('POST');
    expect(client.getQueryData<CallConfigResponse>(KEY)?.callNoticeAcknowledgedAt).toBe(AT);
    expect(window.localStorage.getItem(callNoticeCacheKey(ME))).toBe(AT);
  });

  it('keeps showing the notice when the acknowledgement could not be stored', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ title: 'Unavailable', status: 503 }, 503));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(KEY, settings(null));
    const { result } = renderHook(() => useNoticeFromCache(), { wrapper: wrapper(client) });
    act(() => {
      result.current[1]();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(callNoticeCacheKey(ME))).toBeNull();
  });
});
