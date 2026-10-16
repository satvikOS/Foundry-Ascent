import { createFileRoute, Outlet } from '@tanstack/react-router';

import { InspectorProvider, InspectorRegion } from '@/components/shell/inspector';
import { VentureUploadsProvider } from '@/features/documents/venture-uploads';
import { LazyDocumentViewerHost } from '@/features/documents/viewer/lazy-host';
import { isApiError } from '@/lib/api/errors';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { canAccessVenture, canManageAnyTeam, hasAnyRole } from '@/lib/auth/roles';

/**
 * A venture: its conversations and pages, with the right-hand context panel that pages fill with
 * `<Inspector title="…">` (closed until a citation, a selection or the panel toggle opens it). The
 * sidebar carries the venture's navigation, so the layout adds no chrome of its own. The venture's uploads
 * live here, above its pages, so a file keeps uploading while the person moves between them, and so does
 * the document viewer (`?doc=` / `?src=` with `&passage=`), which opens over any of them. Its params are
 * read by the viewer itself (unknown params pass through every route), so none of its code is in the entry.
 */
export const Route = createFileRoute('/$tenant/app/v/$ventureId')({
  loader: async ({ context, params, location }) => {
    const teamPage = location.pathname.endsWith(`/v/${params.ventureId}/team`);
    // Program leads and platform admins who are not on the venture open only its team (which carries the
    // venture's name): the venture itself, which would be refused (and audited as denied), is not requested.
    if (teamPage && !canAccessVenture(context.me, params.ventureId) && canManageAnyTeam(context.me)) {
      return { ventureName: null };
    }
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
        teamPage &&
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
  const { ventureId } = Route.useParams();
  return (
    <VentureUploadsProvider ventureId={ventureId}>
      <InspectorProvider>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
          <InspectorRegion />
        </div>
        <LazyDocumentViewerHost ventureId={ventureId} />
      </InspectorProvider>
    </VentureUploadsProvider>
  );
}
