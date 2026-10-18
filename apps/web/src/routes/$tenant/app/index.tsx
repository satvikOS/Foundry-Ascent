import { createFileRoute, redirect } from '@tanstack/react-router';
import { Compass } from 'lucide-react';

import { defaultLanding, staffWorkspace } from '@/components/shell/nav';
import { EmptyState } from '@/components/ui/empty-state';
import { PageContainer } from '@/components/ui/page-header';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';

/**
 * `/<tenant>/app` opens the right place: venture members land in their last venture's new chat, staff
 * in their main workspace. Only someone with neither sees this page.
 */
export const Route = createFileRoute('/$tenant/app/')({
  beforeLoad: ({ context, params }) => {
    const landing = defaultLanding(context.me, safeStorage.get(STORAGE_KEYS.lastVenture));
    if (!landing) return;
    if (landing.kind === 'venture') {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
      throw redirect({
        to: '/$tenant/app/v/$ventureId',
        params: { tenant: params.tenant, ventureId: landing.ventureId },
        replace: true,
      });
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: staffWorkspace(landing.kind).to, params, replace: true });
  },
  head: () => ({ meta: [{ title: 'Welcome' }] }),
  component: NoWorkspace,
});

function NoWorkspace() {
  return (
    <PageContainer size="narrow" className="flex min-h-[70dvh] flex-col justify-center">
      <EmptyState
        headingLevel={1}
        icon={Compass}
        title="Nothing to open yet"
        description="A program lead will add you to a venture."
      />
    </PageContainer>
  );
}
