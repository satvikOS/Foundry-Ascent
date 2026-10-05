import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

import { AppShell } from '@/components/shell/app-shell';
import { requireMe } from '@/lib/auth/guards';
import { useRequiredMe } from '@/lib/auth/use-me';

/** Authenticated tenant workspace: guards the session and the tenant, then renders the AppShell. */
export const Route = createFileRoute('/$tenant/app')({
  beforeLoad: async ({ context, location, params }) => {
    const me = await requireMe(context, location);
    if (params.tenant !== me.tenant.slug) {
      // Principals belong to exactly one tenant; never render another tenant's URL space.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
      throw redirect({ to: '/$tenant/app', params: { tenant: me.tenant.slug }, replace: true });
    }
    return { me };
  },
  component: AppLayout,
});

function AppLayout() {
  const me = useRequiredMe();
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}
