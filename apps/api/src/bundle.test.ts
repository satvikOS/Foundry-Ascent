import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESM_REQUIRE_SHIM, LAMBDA_CONTRACT } from './lambda-contract.js';
import {
  bundleEntry,
  bundleHandler,
  HANDLERS,
  type HandlerName,
  handlerEnv,
  IMPORT_CHECK_ENV,
  importCheck,
  runModuleScript,
} from './scripts/bundle.js';
import { minimalDocx, minimalPdf } from './testing/fixtures.js';

/**
 * The handlers must bundle the way CDK NodejsFunction bundles them (esbuild, ESM, node24, createRequire
 * banner) and import cleanly in a fresh Node process with the production environment shape.
 */
let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'fa-bundle-test-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('Lambda bundles', () => {
  for (const name of HANDLERS) {
    it(`${name}: bundles and imports with only the runtime-contract environment`, async () => {
      const bundle = await bundleHandler(name, outDir);
      expect(bundle.bytes).toBeGreaterThan(10_000);
      expect(bundle.bytes).toBeLessThan(20 * 1024 * 1024);
      const check = await importCheck(bundle.outfile, handlerEnv(name));
      expect(check.ok, check.output).toBe(true);
    });
  }

  it('bundles with the createRequire banner and externals from lambda-contract.json (shared with CDK)', async () => {
    const bundle = await bundleHandler('migrate', join(outDir, 'banner'));
    const source = await readFile(bundle.outfile, 'utf8');
    expect(source.startsWith(ESM_REQUIRE_SHIM)).toBe(true);
    expect(LAMBDA_CONTRACT.bundling.externalModules).toContain('pg-native');
  });

  it.each(HANDLERS)('%s: refuses to start without a variable of its role', async (name) => {
    const bundle = await bundleHandler(name, join(outDir, `missing-${name}`));
    const required: Record<HandlerName, string> = {
      api: 'DOCUMENTS_BUCKET',
      worker: 'DOCUMENTS_BUCKET',
      migrate: 'OWNER_ACCESS_CODE_HASH',
    };
    const { [required[name]]: _dropped, ...env } = handlerEnv(name);
    const result = await importCheck(bundle.outfile, env);
    expect(result.ok).toBe(false);
    expect(result.output).toContain(required[name]);
  });

  it('api: fails fast outside the Lambda runtime (no awslambda global)', async () => {
    const bundle = await bundleHandler('api', join(outDir, 'bare'));
    const script = `await import(${JSON.stringify(pathToFileURL(bundle.outfile).href)});`;
    const result = await runModuleScript(script, IMPORT_CHECK_ENV, 'never printed');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('awslambda.streamifyResponse is missing');
  });

  it('worker: unpdf and mammoth work inside the bundle', async () => {
    const outfile = join(outDir, 'extractor', 'index.mjs');
    await bundleEntry(resolve(import.meta.dirname, 'adapters', 'text-extractor.ts'), outfile);
    const pdfPath = join(outDir, 'sample.pdf');
    const docxPath = join(outDir, 'sample.docx');
    await writeFile(pdfPath, minimalPdf([['Bundled PDF text survives']]));
    await writeFile(
      docxPath,
      minimalDocx([{ text: 'Bundled heading', style: 'Heading1' }, { text: 'Body text' }]),
    );
    const script = `
import { readFileSync } from 'node:fs';
const { DocumentTextExtractor } = await import(${JSON.stringify(pathToFileURL(outfile).href)});
const ex = new DocumentTextExtractor();
const pdf = await ex.extract(new Uint8Array(readFileSync(${JSON.stringify(pdfPath)})), 'application/pdf');
const docx = await ex.extract(new Uint8Array(readFileSync(${JSON.stringify(docxPath)})), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
process.stdout.write(JSON.stringify({ pdf: pdf.text, docx: docx.text }) + '\\nEXTRACTED\\n');`;
    const result = await runModuleScript(script, { NODE_OPTIONS: '--enable-source-maps' }, 'EXTRACTED');
    expect(result.ok, result.output).toBe(true);
    const parsed = JSON.parse(result.output.split('\n')[0] ?? '{}') as { pdf: string; docx: string };
    expect(parsed.pdf).toContain('Bundled PDF text survives');
    expect(parsed.docx).toBe('# Bundled heading\n\nBody text');
  });
});
