import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ForbiddenError } from '@/lib/auth/guards';
import { canUseEirStudio } from '@/lib/auth/roles';

/** EIR studio (eir / program_lead): personas and knowledge, calibration reviews, escalation inbox. */
export const Route = createFileRoute('/$tenant/app/eir')({
  beforeLoad: ({ context }) => {
    if (!canUseEirStudio(context.me)) throw new ForbiddenError('the EIR studio');
  },
  head: () => ({ meta: [{ title: 'EIR studio' }] }),
  component: Outlet,
});
