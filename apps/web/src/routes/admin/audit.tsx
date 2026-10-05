import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';

import { AuditPage, type AuditSearch } from '@/features/admin/audit/audit-page';
import { isAuditOutcome } from '@/features/admin/audit/outcome-badge';

export const Route = createFileRoute('/admin/audit')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    action:
      typeof search.action === 'string' && search.action.trim()
        ? search.action.trim().slice(0, 80)
        : undefined,
    outcome: isAuditOutcome(search.outcome) ? search.outcome : undefined,
  }),
  head: () => ({ meta: [{ title: 'Audit log' }] }),
  component: AuditRoute,
});

function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearchChange = useCallback(
    (next: AuditSearch) => {
      void navigate({ search: { action: next.action, outcome: next.outcome }, replace: true });
    },
    [navigate],
  );
  return <AuditPage search={search} onSearchChange={onSearchChange} />;
}
