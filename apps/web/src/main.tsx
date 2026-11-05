// Self-hosted variable fonts (the CSP allows fonts from 'self' only). The platform (sign-in and every signed-in
// page) is set in Inter alone; the landing page's own faces (Newsreader, Geist, Geist Mono) are declared beside it
// (routes/index.tsx) and download only where the landing page draws them.
import './styles/inter.css';
// Sonner also injects these rules at runtime; shipping them in our own stylesheet keeps toasts styled
// under a strict CSP (style-src 'self') that blocks injected <style> tags.
import 'sonner/dist/styles.css';
import './styles/globals.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createQueryClient, setUnauthenticatedHandler } from '@/lib/api/query-client';
import { wakeDatabase } from '@/lib/api/wake';
import { safeRedirectPath } from '@/lib/auth/guards';
import { displayFacesReady } from '@/lib/display-faces';
import { preloadPlatformFont } from '@/lib/font-preload';
import { initPerfClass } from '@/lib/perf';
import { initTheme } from '@/lib/theme';

import { createAppRouter } from './router';

initTheme();
initPerfClass();
// The platform's face starts downloading now (not on the landing page, which is set in its own faces).
preloadPlatformFont(window.location.pathname);
// A paused database starts resuming now, while this page renders and the person reads or signs in (not awaited).
wakeDatabase();

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

// A request reported an expired or revoked session: send the person to sign in, then back here.
setUnauthenticatedHandler(() => {
  const { pathname, href } = router.state.location;
  if (pathname === '/' || pathname.startsWith('/sign-in')) return;
  void router.navigate({ to: '/sign-in', search: { redirect: safeRedirectPath(href) }, replace: true });
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

// The landing page waits (briefly, capped) for its display faces so its hero never re-wraps as they swap in;
// every other page renders at once (lib/display-faces.ts).
void displayFacesReady(window.location.pathname).then(() => {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
