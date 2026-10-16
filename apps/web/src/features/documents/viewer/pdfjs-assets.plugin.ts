import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Plugin } from 'vite';

import { pdfjsAssetDir } from './pdf-assets.ts';

/*
 * Build plugin: serves pdf.js's data files from the site itself (same origin, so the CSP's 'self' covers
 * them): copied into the build under `assets/pdfjs-<version>/`, served from the package in development.
 * pdf.js asks for them only when a PDF needs them. Only what a browser can ask for ships, with its licence:
 * every packed CMap, the Foxit Symbol and Dingbats fonts (other standard fonts come from the system), and
 * the JavaScript image decoders (WebAssembly stays off, so the CSP needs no 'wasm-unsafe-eval').
 */

/** What each of pdf.js's data folders ships. */
const SHIPPED: Record<string, RegExp> = {
  cmaps: /^(?:[\w-]+\.bcmap|LICENSE)$/,
  standard_fonts: /^(?:Foxit\w+\.pfb|LICENSE_FOXIT)$/,
  wasm: /^(?:(?:jbig2|openjpeg)_nowasm_fallback\.js|LICENSE_(?:PDFJS_)?(?:JBIG2|OPENJPEG))$/,
};

export interface PdfjsDataFile {
  /** Path under the version's folder, e.g. `cmaps/UniJIS-UCS2-H.bcmap`. */
  readonly path: string;
  /** The file in the installed package. */
  readonly source: string;
}

function packageRoot(): string {
  return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
}

/** The installed pdf.js's version and the data files a browser may ask for. */
export function pdfjsDataFiles(root = packageRoot()): { version: string; files: PdfjsDataFile[] } {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const files: PdfjsDataFile[] = [];
  for (const [folder, shipped] of Object.entries(SHIPPED)) {
    for (const name of readdirSync(join(root, folder)).sort()) {
      if (shipped.test(name)) files.push({ path: `${folder}/${name}`, source: join(root, folder, name) });
    }
  }
  return { version, files };
}

const contentType = (path: string): string =>
  path.endsWith('.js')
    ? 'text/javascript'
    : path.includes('LICENSE')
      ? 'text/plain'
      : 'application/octet-stream';

export function pdfjsAssets(): Plugin {
  const { version, files } = pdfjsDataFiles();
  const dir = pdfjsAssetDir(version);
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    name: 'foundry:pdfjs-assets',
    configureServer(server) {
      const prefix = `${server.config.base}${dir}/`;
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const file = path.startsWith(prefix) ? byPath.get(path.slice(prefix.length)) : undefined;
        if (!file) {
          next();
          return;
        }
        res.setHeader('content-type', contentType(file.path));
        res.end(readFileSync(file.source));
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: `${dir}/${file.path}`, source: readFileSync(file.source) });
      }
    },
  };
}
