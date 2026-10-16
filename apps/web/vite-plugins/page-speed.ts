import { type Plugin } from 'vite';

/*
 * Build-time page-speed guards for the SPA (docs/runbooks/latency.md): the entry chunk stays within a byte
 * budget, so the first paint of the app never waits on more script than that (the build fails when the
 * budget is exceeded), and React lives in a chunk of its own.
 */

/** Largest entry chunk (bytes, minified, before compression). */
export const ENTRY_CHUNK_BUDGET_BYTES = 650_000;

/** Entry chunks over `maxBytes`: their file name and size (empty when every entry fits). */
export function oversizedEntries(
  chunks: readonly { readonly fileName: string; readonly isEntry: boolean; readonly code: string }[],
  maxBytes: number,
): { fileName: string; bytes: number }[] {
  return chunks
    .filter((chunk) => chunk.isEntry)
    .map((chunk) => ({ fileName: chunk.fileName, bytes: Buffer.byteLength(chunk.code, 'utf8') }))
    .filter((entry) => entry.bytes > maxBytes);
}

export function entryChunkBudget(maxBytes: number = ENTRY_CHUNK_BUDGET_BYTES): Plugin {
  return {
    name: 'foundry:entry-chunk-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) => (output.type === 'chunk' ? [output] : []));
      for (const entry of oversizedEntries(chunks, maxBytes)) {
        this.error(
          `The entry chunk ${entry.fileName} is ${String(entry.bytes)} bytes, over its budget of ${String(maxBytes)}: ` +
            'move what first paint does not need into a route chunk or a lazy import.',
        );
      }
    },
  };
}

/**
 * Libraries that change rarely and that every page needs, kept in a chunk of their own: the app's own
 * chunk changes with every release, this one almost never, so a returning visitor's cache keeps it.
 */
export const FRAMEWORK_CHUNK = {
  name: 'framework',
  test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
} as const;
