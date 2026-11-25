import { createFileRoute } from '@tanstack/react-router';

import { SettingsPage } from '@/features/admin/settings/settings-page';

export const Route = createFileRoute('/$tenant/app/admin/settings')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/admin')
      .then(({ platformSettingsQueryOptions }) => context.queryClient.query(platformSettingsQueryOptions()))
      .catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Settings' }] }),
  component: SettingsPage,
});
