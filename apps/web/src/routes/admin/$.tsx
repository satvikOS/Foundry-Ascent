import { createFileRoute, redirect } from '@tanstack/react-router';

import { requireMe } from '@/lib/auth/guards';
import { legacyAdminSection } from '@/lib/legacy-routes';

const ADMIN_SECTION_PATHS = {
  principals: '/$tenant/app/admin/principals',
  settings: '/$tenant/app/admin/settings',
  usage: '/$tenant/app/admin/usage',
  audit: '/$tenant/app/admin/audit',
} as const;

/**
 * `/admin/<section>` from before the admin workspace moved into the tenant app (one shell for every
 * role): sign in if needed, then open the same section, keeping its query.
 */
export const Route = createFileRoute('/admin/$')({
  beforeLoad: async ({ context, location, params }) => {
    const me = await requireMe(context, location);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({
      to: ADMIN_SECTION_PATHS[legacyAdminSection(params._splat ?? '')],
      params: { tenant: me.tenant.slug },
      search: location.search,
      replace: true,
    });
  },
});
