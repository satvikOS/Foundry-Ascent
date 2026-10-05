import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

import { LiveAnnouncer } from '@/components/a11y/live-announcer';
import { RouteAnnouncer } from '@/components/shell/route-announcer';
import { NotFoundState, RouteErrorBoundary } from '@/components/shell/route-states';
import { Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RouterContext } from '@/lib/auth/guards';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: NotFoundState,
});

function SkipLink() {
  return (
    <a
      href="#main-content"
      onClick={(event) => {
        const main = document.getElementById('main-content');
        if (!main) return;
        event.preventDefault();
        main.focus();
        main.scrollIntoView({ block: 'start' });
      }}
      className="fixed top-2 left-2 z-[100] -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-transform focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      Skip to main content
    </a>
  );
}

function RootLayout() {
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={150}>
      <SkipLink />
      <RouteAnnouncer />
      <Outlet />
      <Toaster />
      <LiveAnnouncer />
    </TooltipProvider>
  );
}
