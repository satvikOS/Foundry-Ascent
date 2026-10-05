import { createFileRoute, Outlet } from '@tanstack/react-router';
import { LayoutDashboard } from 'lucide-react';

import { ConsoleLayout } from '@/components/shell/console-layout';
import { PROGRAM_SECTIONS } from '@/components/shell/nav';
import { SubNavLink } from '@/components/shell/sub-nav';
import { ForbiddenError } from '@/lib/auth/guards';
import { canUseProgramConsole } from '@/lib/auth/roles';

/** Program console layout (program_lead): portfolio aggregates, ventures, resources, escalation queue. */
export const Route = createFileRoute('/$tenant/app/program')({
  beforeLoad: ({ context }) => {
    if (!canUseProgramConsole(context.me)) throw new ForbiddenError('the Program console');
  },
  head: () => ({ meta: [{ title: 'Program' }] }),
  component: ProgramLayout,
});

function ProgramLayout() {
  const { tenant } = Route.useParams();
  return (
    <ConsoleLayout
      title="Program"
      description="Portfolio health, enrolment and resources"
      icon={LayoutDashboard}
      nav={PROGRAM_SECTIONS.map((section) => (
        <SubNavLink key={section.id} to={section.to} params={{ tenant }} icon={section.icon}>
          {section.label}
        </SubNavLink>
      ))}
    >
      <Outlet />
    </ConsoleLayout>
  );
}
