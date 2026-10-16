import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsOn, useCallsAvailable } from './calls-available';
import { json, stubFetch, urlOf } from './testing';

const VENTURE = '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01';

const config = (overrides: { aiEnabled?: boolean; callsEnabled?: boolean } = {}) => ({
  veir: {
    personaId: '00000000-0000-4000-8000-000000000001',
    name: "Corin's vEIR",
    shortName: 'Corin',
    kind: 'eir_persona',
    eirDisplayName: 'Corin Halvorsen',
    tagline: null,
    disclosure: 'An AI.',
    embodiment: {
      provider: 'builtin',
      voiceId: null,
      portraitUrl: null,
      voiceConsented: false,
      likenessConsented: false,
    },
  },
  provider: 'builtin',
  maxMinutes: 20,
  remainingMinutesToday: 40,
  aiEnabled: overrides.aiEnabled ?? true,
  callsEnabled: overrides.callsEnabled ?? true,
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callsOn', () => {
  it('needs AI on and the calls switch on', () => {
    expect(callsOn(config())).toBe(true);
    expect(callsOn(config({ callsEnabled: false }))).toBe(false);
    expect(callsOn(config({ aiEnabled: false }))).toBe(false);
    expect(callsOn(undefined)).toBe(false);
  });
});

describe('useCallsAvailable', () => {
  it('shows Call entries once the call settings say calls are on', async () => {
    const fetchMock = stubFetch().mockResolvedValue(json(config()));
    const { result } = renderHook(() => useCallsAvailable(VENTURE, true), { wrapper });
    expect(result.current).toBe(false);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(urlOf(fetchMock.mock.calls[0]?.[0] ?? '')).toContain(`/ventures/${VENTURE}/call-config`);
  });

  it('hides them while calls are paused', async () => {
    const fetchMock = stubFetch().mockResolvedValue(json(config({ callsEnabled: false })));
    const { result } = renderHook(() => useCallsAvailable(VENTURE, true), { wrapper });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBe(false);
  });

  it('never asks for read-only roles', () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useCallsAvailable(VENTURE, false), { wrapper });
    expect(result.current).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
