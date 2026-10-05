import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';

import { InspectorProvider, InspectorRegion } from '@/components/shell/inspector';
import { SubNav, SubNavLink } from '@/components/shell/sub-nav';
import { VENTURE_SECTION_ROUTES, VENTURE_SECTIONS } from '@/components/shell/nav';
import { VentureContextBar } from '@/components/ventures/venture-context-bar';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { useRequiredMe } from '@/lib/auth/use-me';

/**
 * VentureLayout: context bar + section navigation + canvas (<Outlet/>) + right inspector.
 * Section pages fill the inspector with <Inspector title="…">…</Inspector> (see README).
 */
export const Route = createFileRoute('/$tenant/app/ventures/$ventureId')({
  loader: async ({ context, params }) => {
    const venture = await context.queryClient.query({
      ...ventureQueryOptions(params.ventureId),
      staleTime: 'static',
    });
    return { ventureName: venture.name };
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.ventureName ?? 'Venture' }] }),
  component: VentureLayout,
});

function VentureLayout() {
  const me = useRequiredMe();
  const { tenant, ventureId } = Route.useParams();
  const navigate = useNavigate();
  const { data: venture } = useQuery(ventureQueryOptions(ventureId));

  useHotkeys({
    'g o': () => void navigate({ to: VENTURE_SECTION_ROUTES.overview, params: { tenant, ventureId } }),
    'g c': () => void navigate({ to: VENTURE_SECTION_ROUTES.coach, params: { tenant, ventureId } }),
    'g m': () => void navigate({ to: VENTURE_SECTION_ROUTES.memory, params: { tenant, ventureId } }),
    'g d': () => void navigate({ to: VENTURE_SECTION_ROUTES.documents, params: { tenant, ventureId } }),
    'g x': () => void navigate({ to: VENTURE_SECTION_ROUTES.escalations, params: { tenant, ventureId } }),
  });

  // The loader guarantees the venture is cached; `data` is only undefined if it was evicted mid-render.
  if (!venture) return null;

  return (
    <InspectorProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="sticky top-(--header-height) z-10 border-b border-border bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75"
          data-print="hide"
        >
          <VentureContextBar venture={venture} me={me} />
          <SubNav label={`${venture.name} sections`} className="mt-1 px-2 sm:px-4 lg:px-6">
            {VENTURE_SECTIONS.map((section) => (
              <SubNavLink
                key={section.id}
                to={VENTURE_SECTION_ROUTES[section.id]}
                params={{ tenant, ventureId }}
                icon={section.icon}
                badge={
                  section.id === 'memory' && venture.pendingMemory > 0 ? (
                    <span className="tabular ml-0.5 rounded-sm bg-warning/15 px-1 text-[11px] text-warning">
                      {venture.pendingMemory}
                      <span className="sr-only"> to review</span>
                    </span>
                  ) : section.id === 'escalations' && venture.openEscalations > 0 ? (
                    <span className="tabular ml-0.5 rounded-sm bg-muted px-1 text-[11px] text-foreground">
                      {venture.openEscalations}
                      <span className="sr-only"> open</span>
                    </span>
                  ) : null
                }
              >
                {section.label}
              </SubNavLink>
            ))}
          </SubNav>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <Outlet />
          </div>
          <InspectorRegion />
        </div>
      </div>
    </InspectorProvider>
  );
}
