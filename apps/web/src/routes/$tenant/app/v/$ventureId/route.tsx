import { createFileRoute, Outlet } from '@tanstack/react-router';

import { InspectorProvider, InspectorRegion } from '@/components/shell/inspector';
import { isApiError } from '@/lib/api/errors';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { hasAnyRole } from '@/lib/auth/roles';

/**
 * A venture: its conversations and pages, with the right-hand context panel that pages fill with
 * `<Inspector title="…">` (closed until a citation, a selection or the panel toggle opens it). The
 * sidebar carries the venture's navigation, so the layout adds no chrome of its own.
 */
export const Route = createFileRoute('/$tenant/app/v/$ventureId')({
  loader: async ({ context, params, location }) => {
    try {
      const venture = await context.queryClient.query({
        ...ventureQueryOptions(params.ventureId),
        staleTime: 'static',
      });
      return { ventureName: venture.name };
    } catch (error) {
      // Program leads and platform admins see and invite to any venture's team without reading the venture
      // itself (the team endpoint allows them); everything else of a venture they cannot read stays closed.
      if (
        location.pathname.endsWith(`/v/${params.ventureId}/team`) &&
        hasAnyRole(context.me, ['program_lead', 'platform_admin']) &&
        isApiError(error) &&
        (error.status === 403 || error.status === 404)
      ) {
        return { ventureName: null };
      }
      // 403/404 surface through the route error boundary ("no access" / "not found").
      throw error;
    }
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.ventureName ?? 'Venture' }] }),
  component: VentureLayout,
});

function VentureLayout() {
  return (
    <InspectorProvider>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <InspectorRegion />
      </div>
    </InspectorProvider>
  );
}
