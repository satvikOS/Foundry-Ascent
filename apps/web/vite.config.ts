import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { FRAMEWORK_CHUNK, firstLoadBudget } from './vite-plugins/page-speed.js';

/**
 * Sonner injects its stylesheet with a runtime <style> tag, which a strict CSP (style-src 'self')
 * blocks and reports. We ship the identical rules from `sonner/dist/styles.css` (imported in
 * main.tsx), so the runtime injection is disabled in production builds. Fails the build if the
 * library changes shape, so the CSP assumption can't silently regress.
 */
function sonnerWithoutInjectedStyles(): Plugin {
  const marker = 'function __insertCSS(code) {';
  return {
    name: 'foundry:sonner-without-injected-styles',
    apply: 'build',
    transform(code, id) {
      if (!/[\\/]sonner[\\/]dist[\\/]index\.m?js$/.test(id)) return null;
      if (!code.includes(marker)) {
        this.error('sonner no longer defines __insertCSS; re-check CSP compatibility of toast styles.');
      }
      return { code: code.replace(marker, `${marker}\n  return;`), map: null };
    },
  };
}

// The SPA is served by CloudFront from S3 with a strict CSP (default-src 'self'), so the build must not
// emit inline scripts or data: URIs. The API is reached same-origin under /api (proxied in dev and by
// `vite preview`; API_PROXY_TARGET points it at another local API, e.g. the e2e server).
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    // The router plugin must run before the React plugin so generated route chunks get Fast Refresh.
    tanstackRouter({
      target: 'react',
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
      autoCodeSplitting: true,
      codeSplittingOptions: {
        // The first screens people see ship in the main bundle, so first paint never waits for a route
        // chunk: the landing page, sign-in, and the app shell every signed-in page renders inside.
        splitBehavior: ({ routeId }) =>
          routeId === '/' || routeId === '/sign-in' || routeId === '/$tenant/app' ? [] : undefined,
      },
      quoteStyle: 'single',
      semicolons: true,
    }),
    react(),
    tailwindcss(),
    sonnerWithoutInjectedStyles(),
    // Page speed (docs/runbooks/latency.md): the script a first page load fetches (the entry and its static
    // imports) stays within its budget; the build fails otherwise.
    firstLoadBudget(),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: false },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    // Keep every asset a separate file so the CSP never needs `data:` for fonts or images.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 650,
    rolldownOptions: {
      output: {
        // React in a chunk of its own. The first load fetches it alongside the entry either way (same bytes);
        // the gain is that a returning visitor still has it cached after a release changed the app.
        codeSplitting: { groups: [FRAMEWORK_CHUNK] },
      },
    },
  },
});
