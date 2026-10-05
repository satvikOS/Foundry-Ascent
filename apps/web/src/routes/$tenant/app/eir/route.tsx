import { createFileRoute, Outlet } from '@tanstack/react-router';
import { BookOpenCheck } from 'lucide-react';

import { ConsoleLayout } from '@/components/shell/console-layout';
import { EIR_SECTIONS } from '@/components/shell/nav';
import { SubNavLink } from '@/components/shell/sub-nav';
import { ForbiddenError } from '@/lib/auth/guards';
import { canUseEirStudio } from '@/lib/auth/roles';

/** EIR studio layout (eir / program_lead): personas, calibration reviews, escalation inbox. */
export const Route = createFileRoute('/$tenant/app/eir')({
  beforeLoad: ({ context }) => {
    if (!canUseEirStudio(context.me)) throw new ForbiddenError('the EIR studio');
  },
  head: () => ({ meta: [{ title: 'EIR studio' }] }),
  component: EirLayout,
});

function EirLayout() {
  const { tenant } = Route.useParams();
  return (
    <ConsoleLayout
      title="EIR studio"
      description="Personas, calibration and your escalation inbox"
      icon={BookOpenCheck}
      nav={EIR_SECTIONS.map((section) => (
        <SubNavLink key={section.id} to={section.to} params={{ tenant }} icon={section.icon}>
          {section.label}
        </SubNavLink>
      ))}
    >
      <Outlet />
    </ConsoleLayout>
  );
}
