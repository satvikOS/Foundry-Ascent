import { type HtmlTagDescriptor, type Plugin } from 'vite';

/*
 * The platform's one face is preloaded (owner refinement 2026-11-05): index.html asks for Inter's Latin file while
 * it parses, instead of when the stylesheet's first rule that uses it is laid out. One file only: Latin Extended
 * and the italic still load on demand (styles/inter.css). The landing page's faces are not preloaded: its first
 * render waits for its display face on its own (lib/display-faces.ts).
 */

/** The source file of the preloaded face (as @fontsource-variable/inter ships it). */
export const PRELOADED_FONT = 'inter-latin-wght-normal.woff2';

/** What the plugin reads of an emitted asset. */
export interface AssetFacts {
  readonly type: 'asset' | 'chunk';
  readonly fileName: string;
  /** The source file names the asset was emitted from (Rollup/Rolldown `originalFileNames`). */
  readonly originalFileNames?: readonly string[];
}

/** The emitted file of `font` (matched by its source file's name), or undefined when the build has none. */
export function emittedFont(
  outputs: readonly AssetFacts[],
  font: string = PRELOADED_FONT,
): string | undefined {
  return outputs.find(
    (output) =>
      output.type === 'asset' &&
      (output.originalFileNames ?? []).some((name) => name === font || name.endsWith(`/${font}`)),
  )?.fileName;
}

/** The `<link rel="preload">` for a font file at `href` (fonts are fetched in CORS mode, so `crossorigin`). */
export function fontPreloadTag(href: string): HtmlTagDescriptor {
  return {
    tag: 'link',
    attrs: { rel: 'preload', href, as: 'font', type: 'font/woff2', crossorigin: '' },
    injectTo: 'head',
  };
}

export function fontPreload(font: string = PRELOADED_FONT): Plugin {
  return {
    name: 'foundry:font-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const outputs = Object.values(context.bundle ?? {}) as unknown as AssetFacts[];
        const file = emittedFont(outputs, font);
        if (file === undefined) {
          throw new Error(
            `foundry:font-preload: the build emitted no ${font}; is styles/inter.css imported?`,
          );
        }
        return [fontPreloadTag(`/${file}`)];
      },
    },
  };
}
