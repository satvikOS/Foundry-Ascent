import '@fontsource-variable/inter/wght.css';
// Sonner also injects these rules at runtime; shipping them in our own stylesheet keeps toasts styled
// under a strict CSP (style-src 'self') that blocks injected <style> tags.
import 'sonner/dist/styles.css';
import './styles/globals.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createQueryClient, setUnauthenticatedHandler } from '@/lib/api/query-client';
import { safeRedirectPath } from '@/lib/auth/guards';
import { initTheme } from '@/lib/theme';

import { createAppRouter } from './router';

initTheme();

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

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
