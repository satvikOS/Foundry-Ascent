import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ForbiddenError } from '@/lib/auth/guards';
import { canUseAdminConsole } from '@/lib/auth/roles';

/** Platform admin workspace (platform_admin): people & access codes, settings, usage, audit. */
export const Route = createFileRoute('/$tenant/app/admin')({
  beforeLoad: ({ context }) => {
    if (!canUseAdminConsole(context.me)) throw new ForbiddenError('the Admin workspace');
  },
  head: () => ({ meta: [{ title: 'Admin' }] }),
  component: Outlet,
});
