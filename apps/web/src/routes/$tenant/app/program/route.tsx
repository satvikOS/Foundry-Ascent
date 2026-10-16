import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ForbiddenError } from '@/lib/auth/guards';
import { canUseProgramConsole } from '@/lib/auth/roles';

/** Program workspace (program_lead): portfolio aggregates, ventures, resources, escalation queue. */
export const Route = createFileRoute('/$tenant/app/program')({
  beforeLoad: ({ context }) => {
    if (!canUseProgramConsole(context.me)) throw new ForbiddenError('the Program workspace');
  },
  head: () => ({ meta: [{ title: 'Program' }] }),
  component: Outlet,
});
