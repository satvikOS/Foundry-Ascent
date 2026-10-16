import { createFileRoute, redirect } from '@tanstack/react-router';

import { requireMe } from '@/lib/auth/guards';

/** `/admin` from before the admin workspace moved into the tenant app. */
export const Route = createFileRoute('/admin/')({
  beforeLoad: async ({ context, location }) => {
    const me = await requireMe(context, location);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/admin', params: { tenant: me.tenant.slug }, replace: true });
  },
});
