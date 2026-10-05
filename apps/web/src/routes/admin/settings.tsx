import { createFileRoute } from '@tanstack/react-router';

import { SettingsPage } from '@/features/admin/settings/settings-page';
import { platformSettingsQueryOptions } from '@/lib/api/hooks/admin';

export const Route = createFileRoute('/admin/settings')({
  loader: ({ context }) => {
    context.queryClient.query(platformSettingsQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Settings' }] }),
  component: SettingsPage,
});
