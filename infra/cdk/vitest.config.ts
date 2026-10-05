import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesis bundles three Lambdas with esbuild and runs cdk-nag over every stack.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // One synthesized app is shared per file; files run in separate workers.
    fileParallelism: true,
  },
});
