import type { EscalationAssignee, Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { IDS } from '@/features/coach/testing';

import { toAssigneeOptions, useAssigneeOptions } from './assignees';

const RUTH = '0e6c1a6e-7c0f-4f2b-9a51-2f5d7c1b0a11';
const LEAD = '1f7d2b7f-8d1a-4a3c-8b62-3a6e8d2c1b22';

const assignees: EscalationAssignee[] = [
  {
    principal: { id: RUTH, displayName: 'Ruth Okonkwo', title: null, synthetic: true },
    roles: ['eir'],
    expertiseTags: ['ip', 'licensing', 'medtech', 'regulatory'],
  },
  {
    principal: { id: LEAD, displayName: 'Alex Program', title: null, synthetic: true },
    roles: ['program_lead'],
    expertiseTags: [],
  },
];

function me(roles: Me['roles'], principalId = LEAD): Me {
  return {
    principal: { id: principalId, displayName: 'Alex Program', title: null, synthetic: true },
    tenant: { id: IDS.ref, slug: 'ain', name: 'Ain', kind: 'home' },
    roles,
    memberships: [],
    assignedVentureIds: [],
    disclosure: 'AI coach',
    notices: [],
    aiEnabled: true,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assignee options', () => {
  it('lists people by name with their roles and top expertise, marking the signed-in person', () => {
    expect(toAssigneeOptions(assignees, LEAD)).toEqual([
      { id: LEAD, name: 'Alex Program (you)', detail: 'Program lead' },
      { id: RUTH, name: 'Ruth Okonkwo', detail: 'EIR — ip, licensing, medtech' },
    ]);
  });

  it('loads the tenant directory from GET /program/assignees for program staff', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ items: assignees }));
    const { result } = renderHook(() => useAssigneeOptions(me(['program_lead'])), { wrapper });
    await waitFor(() => {
      expect(result.current.options).toHaveLength(2);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/program/assignees');
  });

  it('never asks for the directory without a program role', () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useAssigneeOptions(me(['eir'], RUTH)), { wrapper });
    expect(result.current).toMatchObject({ options: [], isLoading: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
