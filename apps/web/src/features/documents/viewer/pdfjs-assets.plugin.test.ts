import { describe, expect, it, vi } from 'vitest';

import { pdfjsAssetDir } from './pdf-assets';
import { pdfjsAssets, pdfjsDataFiles } from './pdfjs-assets.plugin';

describe('pdf.js data files', () => {
  const { version, files } = pdfjsDataFiles();
  const paths = files.map((file) => file.path);

  it('ship what the reader can ask for: the image decoders, every packed CMap and the Symbol fonts', () => {
    expect(paths).toContain('wasm/jbig2_nowasm_fallback.js');
    expect(paths).toContain('wasm/openjpeg_nowasm_fallback.js');
    expect(paths).toContain('cmaps/UniJIS-UCS2-H.bcmap');
    expect(paths).toContain('cmaps/Adobe-Japan1-UCS2.bcmap');
    expect(paths.filter((p) => p.endsWith('.bcmap')).length).toBeGreaterThan(150);
    expect(paths).toContain('standard_fonts/FoxitSymbol.pfb');
    expect(paths).toContain('standard_fonts/FoxitDingbats.pfb');
  });

  it('ship each one with its licence, and nothing a browser never asks for', () => {
    for (const licence of [
      'cmaps/LICENSE',
      'standard_fonts/LICENSE_FOXIT',
      'wasm/LICENSE_JBIG2',
      'wasm/LICENSE_OPENJPEG',
      'wasm/LICENSE_PDFJS_JBIG2',
      'wasm/LICENSE_PDFJS_OPENJPEG',
    ]) {
      expect(paths).toContain(licence);
    }
    // WebAssembly stays off (no 'wasm-unsafe-eval'), and the browser uses system fonts for the rest.
    expect(paths.some((p) => p.endsWith('.wasm'))).toBe(false);
    expect(paths.some((p) => p.includes('quickjs'))).toBe(false);
    expect(paths.some((p) => p.includes('Liberation'))).toBe(false);
  });

  it('are emitted into the build under the version’s folder the reader points pdf.js at', () => {
    const plugin = pdfjsAssets();
    const emitFile = vi.fn();
    const generate = plugin.generateBundle as unknown as (this: { emitFile: typeof emitFile }) => void;
    generate.call({ emitFile });
    const emitted = emitFile.mock.calls.map(([asset]) => (asset as { fileName: string }).fileName);
    expect(emitted).toHaveLength(files.length);
    expect(emitted).toContain(`${pdfjsAssetDir(version)}/wasm/jbig2_nowasm_fallback.js`);
    expect(pdfjsAssetDir(version)).toBe(`assets/pdfjs-${version}`);
  });
});
