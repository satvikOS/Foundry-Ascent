import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';

import { AppShell } from '@/components/shell/app-shell';
import { ConsoleLayout } from '@/components/shell/console-layout';
import { ADMIN_SECTIONS } from '@/components/shell/nav';
import { SubNavLink } from '@/components/shell/sub-nav';
import { ForbiddenError, requireMe } from '@/lib/auth/guards';
import { canUseAdminConsole } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';

/** Platform admin console (platform_admin): principals & access codes, settings, usage, audit. */
export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ context, location }) => {
    const me = await requireMe(context, location);
    if (!canUseAdminConsole(me)) throw new ForbiddenError('the Admin console');
    return { me };
  },
  head: () => ({ meta: [{ title: 'Admin' }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const me = useRequiredMe();
  return (
    <AppShell me={me}>
      <ConsoleLayout
        title="Admin"
        description="Access, safety controls, spend and audit"
        icon={ShieldCheck}
        nav={ADMIN_SECTIONS.map((section) => (
          <SubNavLink key={section.id} to={section.to} icon={section.icon}>
            {section.label}
          </SubNavLink>
        ))}
      >
        <Outlet />
      </ConsoleLayout>
    </AppShell>
  );
}
