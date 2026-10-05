import type { Me } from '@foundry/contracts';
import { useMemo } from 'react';

import { useEscalationAssignees, type EscalationAssigneeEntry } from '@/lib/api/hooks/program';
import { hasAnyRole, ROLE_LABELS } from '@/lib/auth/roles';

export interface AssigneeOption {
  id: string;
  name: string;
  detail: string;
}

/** One select option per assignee: name (marked "you"), roles and up to three expertise tags. */
export function toAssigneeOptions(
  items: readonly EscalationAssigneeEntry[],
  selfId: string,
): AssigneeOption[] {
  return items
    .map((item) => ({
      id: item.principal.id,
      name: item.principal.id === selfId ? `${item.principal.displayName} (you)` : item.principal.displayName,
      detail: [
        item.roles.map((role) => ROLE_LABELS[role]).join(' · '),
        item.expertiseTags.slice(0, 3).join(', '),
      ]
        .filter((part) => part !== '')
        .join(' — '),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * People an escalation can be routed to: the tenant's active EIRs and program leads, from
 * `GET /program/assignees` (the same rule the route endpoint enforces). Only program leads and platform
 * admins may list them; the request is never sent for anyone else.
 */
export function useAssigneeOptions(me: Me): {
  options: AssigneeOption[];
  isLoading: boolean;
  isError: boolean;
} {
  const allowed = hasAnyRole(me, ['program_lead', 'platform_admin']);
  const assignees = useEscalationAssignees({ enabled: allowed });
  const items = allowed ? assignees.data : undefined;
  const options = useMemo(() => toAssigneeOptions(items ?? [], me.principal.id), [items, me.principal.id]);
  return { options, isLoading: allowed && assignees.isPending, isError: assignees.isError };
}
