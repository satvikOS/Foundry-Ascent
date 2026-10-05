import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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
// emit inline scripts or data: URIs. The API is reached same-origin under /api (proxied in dev).
export default defineConfig({
  plugins: [
    // The router plugin must run before the React plugin so generated route chunks get Fast Refresh.
    tanstackRouter({
      target: 'react',
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
      autoCodeSplitting: true,
      quoteStyle: 'single',
      semicolons: true,
    }),
    react(),
    tailwindcss(),
    sonnerWithoutInjectedStyles(),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    // Keep every asset a separate file so the CSP never needs `data:` for fonts or images.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
  },
});
