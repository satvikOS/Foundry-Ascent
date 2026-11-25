import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, sentJson, stubFetch } from '@/features/admin/shared/test-utils';
import { EMPTY_INTAKE } from '@/features/path/intake-form';
import { makePath, makeStep, PATH_IDS } from '@/features/path/testing';

import { queryKeys } from '../query-keys';
import { currentStep, useSavePathIntake, useUpdatePathStep, useVenturePath, withStep } from './path';

const V = PATH_IDS.venture;

function setup(seed?: ReturnType<typeof makePath> | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  if (seed !== undefined) client.setQueryData(queryKeys.venture.path(V), seed);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useVenturePath', () => {
  it('reads GET /ventures/:id/path, and a venture without one is null, not an error', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'not_found', status: 404, title: 'Not found' }, 404),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useVenturePath(V), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/ventures/${V}/path`);
  });
});

describe('useUpdatePathStep', () => {
  it('ticks at once, then takes the server’s whole path', async () => {
    const fetchMock = stubFetch();
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { client, wrapper } = setup(makePath());
    const { result } = renderHook(() => useUpdatePathStep(V), { wrapper });
    act(() => {
      result.current.mutate({ step: makeStep(), update: { action: 'tick', item: 1, done: true } });
    });
    await waitFor(() => {
      expect(
        client.getQueryData<ReturnType<typeof makePath>>(queryKeys.venture.path(V))?.now?.items[1]?.done,
      ).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/ventures/${V}/path/steps/${PATH_IDS.now}`);
    expect(init?.method).toBe('PATCH');
    expect(sentJson(init)).toEqual({
      expectedVersion: 3,
      update: { action: 'tick', item: 1, done: true },
    });
    const saved = makePath({ version: 8, now: makeStep({ version: 4 }) });
    await act(async () => {
      answer(jsonResponse(saved));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.venture.path(V))).toEqual(saved);
    });
  });

  it('a second change is made against the version the first left, never the one the card was drawn with', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) => {
      const sent = sentJson(init) as { expectedVersion: number };
      return Promise.resolve(jsonResponse(makeStep({ version: sent.expectedVersion + 1 })));
    });
    const { wrapper } = setup(makePath());
    const { result } = renderHook(() => useUpdatePathStep(V), { wrapper });
    act(() => {
      result.current.mutate({ step: makeStep(), update: { action: 'tick', item: 1, done: true } });
      result.current.mutate({ step: makeStep(), update: { action: 'tick', item: 2, done: true } });
    });
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
      expect(
        patches.map(([, init]) => (sentJson(init) as { expectedVersion: number }).expectedVersion),
      ).toEqual([3, 4]);
    });
  });

  it('puts a refused tick back and reads the path again', async () => {
    const fetchMock = stubFetch();
    const changed = makePath({ version: 9 });
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === 'PATCH'
          ? jsonResponse({ code: 'conflict', status: 409, title: 'Conflict' }, 409)
          : jsonResponse(changed),
      ),
    );
    const { client, wrapper } = setup(makePath());
    const { result } = renderHook(() => ({ path: useVenturePath(V), update: useUpdatePathStep(V) }), {
      wrapper,
    });
    act(() => {
      result.current.update.mutate({ step: makeStep(), update: { action: 'tick', item: 1, done: true } });
    });
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.venture.path(V))).toEqual(changed);
    });
    expect(result.current.update.isError).toBe(true);
  });
});

describe('useSavePathIntake', () => {
  it('PUTs the intake against the path’s version and keeps what the server saved', async () => {
    const fetchMock = stubFetch();
    const saved = makePath({ version: 8 });
    fetchMock.mockResolvedValueOnce(jsonResponse(saved));
    const { client, wrapper } = setup(makePath({ intake: null }));
    const { result } = renderHook(() => useSavePathIntake(V), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ...EMPTY_INTAKE, idea: '  Reagents  ' });
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/ventures/${V}/path/intake`);
    expect(init?.method).toBe('PUT');
    expect(sentJson(init)).toMatchObject({ expectedVersion: 7, intake: { idea: 'Reagents', customer: '' } });
    expect(client.getQueryData(queryKeys.venture.path(V))).toEqual(saved);
  });
});

describe('currentStep', () => {
  it('prefers the path’s own copy when it is as new, and keeps a newer one from the reply', () => {
    const ticked = makeStep({ version: 4, evidence: 'x' });
    expect(currentStep(makeStep(), withStep(makePath(), ticked))).toBe(ticked);
    const fresh = makeStep({ version: 9 });
    expect(currentStep(fresh, makePath())).toBe(fresh);
    expect(currentStep(fresh, null)).toBe(fresh);
  });
});
