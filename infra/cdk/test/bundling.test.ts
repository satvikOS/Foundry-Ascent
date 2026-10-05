/**
 * Exercises the real NodejsFunction bundling path (local esbuild, ESM, banner shim) end to end.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { PlatformFunction } from '../src/constructs/platform-function.js';
import {
  ensureLocalEsbuildOnPath,
  HANDLER_NAMES,
  INFRA_ROOT,
  realHandlerEntry,
  REPO_ROOT,
} from '../src/paths.js';

/** Synthesizes one PlatformFunction per entry and returns the bundle directory of each. */
function bundle(entries: Record<string, string>): Record<string, string> {
  ensureLocalEsbuildOnPath();
  const outdir = mkdtempSync(join(tmpdir(), 'foundry-bundle-test-'));
  const app = new App({ outdir });
  const stack = new Stack(app, 'BundleTest', { env: { region: 'us-east-1' } });
  for (const [name, entry] of Object.entries(entries)) {
    new PlatformFunction(stack, name, {
      functionName: `BundleTest-${name}`,
      description: 'bundling test',
      entry,
      depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
      projectRoot: REPO_ROOT,
      memorySize: 128,
      timeout: Duration.seconds(3),
      logRetention: RetentionDays.ONE_DAY,
      environment: {},
    });
  }
  const functions = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Function')) as {
    Properties: { FunctionName?: string; Code: { S3Key: string } };
  }[];
  const result: Record<string, string> = {};
  for (const name of Object.keys(entries)) {
    const key =
      functions.find((r) => r.Properties.FunctionName === `BundleTest-${name}`)?.Properties.Code.S3Key ?? '';
    const dir = join(outdir, `asset.${key.replace(/\.zip$/, '')}`);
    expect(existsSync(join(dir, 'index.mjs')), `${name} bundle`).toBe(true);
    result[name] = dir;
  }
  return result;
}

describe('ESM bundle shim', () => {
  it('lets bundled CommonJS code use require, __filename and __dirname', () => {
    const fixtureDir = join(INFRA_ROOT, 'node_modules', '.cache', 'foundry-cdk-test-fixtures', 'esm-shim');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, 'legacy.cjs'),
      [
        "const path = require('node:path');",
        'module.exports = { file: path.basename(__filename), dirIsString: typeof __dirname === "string" };',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(fixtureDir, 'entry.ts'),
      [
        "import legacy from './legacy.cjs';",
        'export const handler = async (): Promise<unknown> => legacy;',
        '',
      ].join('\n'),
      'utf8',
    );

    const { shim } = bundle({ shim: join(fixtureDir, 'entry.ts') });
    const bundlePath = join(shim ?? '', 'index.mjs');
    const source = readFileSync(bundlePath, 'utf8');
    expect(source.startsWith("import { createRequire as __faCreateRequire } from 'node:module';")).toBe(true);
    expect(existsSync(`${bundlePath}.map`)).toBe(true);

    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(pathToFileURL(bundlePath).href)}); console.log(JSON.stringify(await m.handler()));`,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output.trim())).toEqual({ file: 'index.mjs', dirIsString: true });
  });
});

const realHandlersPresent = HANDLER_NAMES.every((name) => existsSync(realHandlerEntry(name)));

describe.skipIf(!realHandlersPresent)('real apps/api handlers', () => {
  it('bundle with local esbuild into ESM for Node 24', () => {
    const dirs = bundle(Object.fromEntries(HANDLER_NAMES.map((name) => [name, realHandlerEntry(name)])));
    for (const [name, dir] of Object.entries(dirs)) {
      const files = readdirSync(dir);
      expect(files, name).toContain('index.mjs');
      const size = statSync(join(dir, 'index.mjs')).size;
      // Lambda's unzipped limit is 250 MB; anything near 50 MB means something leaked into the bundle.
      expect(size, `${name} bundle size`).toBeLessThan(50 * 1024 * 1024);
    }
  });
});
