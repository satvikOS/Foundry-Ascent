/**
 * Filesystem locations the CDK app reads at synth time (handler entry points, the built SPA, migrations).
 *
 * The real synth path always uses the real files and fails fast when one is missing. For infrastructure
 * checks that must not depend on other packages being built (unit tests, `cdk synth` in a fresh checkout),
 * `FA_SYNTH_STUB_ASSETS=1` swaps in throw-away stubs generated in a cache directory. Stub assets are
 * never deployable: every stub handler throws, so the migration custom resource fails and CloudFormation
 * rolls the App stack back before any stub code or stub page can be served (the functions and both site
 * deployments depend on the migrations).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** infra/cdk */
export const INFRA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Repository root (pnpm workspace). */
export const REPO_ROOT = resolve(INFRA_ROOT, '..', '..');

export const STUB_ASSETS_ENV = 'FA_SYNTH_STUB_ASSETS';

export type HandlerName = 'api' | 'worker' | 'migrate';
export const HANDLER_NAMES: readonly HandlerName[] = ['api', 'worker', 'migrate'];

export interface AppAssets {
  /** Absolute path of each Lambda entry file (TypeScript, bundled by esbuild). */
  readonly handlers: Readonly<Record<HandlerName, string>>;
  /** Directory with the built SPA (`index.html` + `assets/`). */
  readonly webDist: string;
  /** Directory with `NNNN_name.sql` migrations (checksummed into the migrate custom resource). */
  readonly migrationsDir: string;
  /** Lock file and project root handed to NodejsFunction. */
  readonly depsLockFilePath: string;
  readonly projectRoot: string;
  readonly stub: boolean;
}

export function realHandlerEntry(name: HandlerName): string {
  return join(REPO_ROOT, 'apps', 'api', 'src', 'handlers', `${name}.ts`);
}

export const REAL_WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations');

export function stubAssetsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[STUB_ASSETS_ENV];
  return value === '1' || value === 'true';
}

/**
 * Makes the workspace's esbuild visible to NodejsFunction's local bundling (which shells out to
 * `esbuild` on PATH when it cannot resolve the package from aws-cdk-lib). Docker bundling is disabled.
 */
export function ensureLocalEsbuildOnPath(env: NodeJS.ProcessEnv = process.env): void {
  const bin = join(INFRA_ROOT, 'node_modules', '.bin');
  const current = env.PATH ?? '';
  if (!current.split(delimiter).includes(bin)) env.PATH = current ? `${bin}${delimiter}${current}` : bin;
}

const STUB_HANDLER = (name: HandlerName): string =>
  [
    `// Synth-only stub for apps/api/src/handlers/${name}.ts (${STUB_ASSETS_ENV}=1). Never deployable.`,
    'export const handler = async (): Promise<never> => {',
    `  throw new Error('Foundry Ascent stub asset (${name}): rebuild without ${STUB_ASSETS_ENV} before deploying');`,
    '};',
    '',
  ].join('\n');

const STUB_INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Foundry Ascent (stub)</title></head><body></body></html>\n';

/**
 * Stubs live under infra/cdk/node_modules/.cache (git-ignored): NodejsFunction requires entry files to be
 * inside the project root (the repository), so the OS temp directory cannot be used. The directory and
 * contents are fixed, so stub asset hashes are stable across runs.
 */
const STUB_ROOT = join(INFRA_ROOT, 'node_modules', '.cache', 'foundry-cdk-stub-assets', 'v1');

/** Write-then-rename, so concurrent test workers never observe a partially written stub. */
function writeAtomically(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

function createStubAssets(): { handlers: Record<HandlerName, string>; webDist: string } {
  const handlers = {} as Record<HandlerName, string>;
  for (const name of HANDLER_NAMES) {
    handlers[name] = join(STUB_ROOT, 'handlers', `${name}.ts`);
    writeAtomically(handlers[name], STUB_HANDLER(name));
  }
  const webDist = join(STUB_ROOT, 'web-dist');
  writeAtomically(join(webDist, 'index.html'), STUB_INDEX_HTML);
  writeAtomically(join(webDist, 'assets', 'stub.js'), '// stub\n');
  return { handlers, webDist };
}

export class MissingAssetError extends Error {
  constructor(missing: readonly string[]) {
    super(
      [
        'Cannot synthesize a deployable App stack; missing build inputs:',
        ...missing.map((m) => `  - ${m}`),
        `Build them (pnpm --filter @foundry/web build) or set ${STUB_ASSETS_ENV}=1 for a synth-only check.`,
      ].join('\n'),
    );
    this.name = 'MissingAssetError';
  }
}

export function resolveAssets(options: { stub?: boolean } = {}): AppAssets {
  const stub = options.stub ?? stubAssetsRequested();
  const common = {
    migrationsDir: MIGRATIONS_DIR,
    depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
    projectRoot: REPO_ROOT,
  };
  if (stub) return { ...createStubAssets(), ...common, stub: true };

  const handlers = {} as Record<HandlerName, string>;
  const missing: string[] = [];
  for (const name of HANDLER_NAMES) {
    handlers[name] = realHandlerEntry(name);
    if (!existsSync(handlers[name])) missing.push(handlers[name]);
  }
  const indexHtml = join(REAL_WEB_DIST, 'index.html');
  if (!existsSync(indexHtml) || !statSync(indexHtml).isFile()) missing.push(indexHtml);
  if (missing.length > 0) throw new MissingAssetError(missing);
  return { handlers, webDist: REAL_WEB_DIST, ...common, stub: false };
}
