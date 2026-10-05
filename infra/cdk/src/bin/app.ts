#!/usr/bin/env node
/**
 * CDK CLI entry point (cdk.json: `npx tsx src/bin/app.ts`).
 *
 *   pnpm --filter @foundry/infra exec cdk synth --quiet -c appVersion=$GITHUB_SHA
 *   FA_SYNTH_STUB_ASSETS=1 pnpm --filter @foundry/infra exec cdk synth --quiet   # without built assets
 */
import { buildApp } from '../app.js';
import { ConfigError } from '../config.js';
import { MissingAssetError } from '../paths.js';

try {
  const { app, assets } = buildApp();
  if (assets.stub) {
    console.warn(
      'FA_SYNTH_STUB_ASSETS=1: synthesized with stub Lambda handlers and SPA. This assembly is not deployable.',
    );
  }
  app.synth();
} catch (error) {
  if (error instanceof MissingAssetError || error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
