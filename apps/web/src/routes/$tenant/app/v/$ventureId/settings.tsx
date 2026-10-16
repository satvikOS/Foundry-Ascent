import { createFileRoute } from '@tanstack/react-router';

import { VentureSettingsPage } from '@/features/venture/venture-settings-page';

/** Venture settings (name, one-liner, stage, current goal), opened from the venture switcher. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/settings')({
  head: () => ({ meta: [{ title: 'Venture settings' }] }),
  component: VentureSettingsPage,
});
