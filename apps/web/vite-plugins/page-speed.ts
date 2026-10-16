import { type Plugin } from 'vite';

/*
 * Build-time page-speed guards for the SPA (docs/runbooks/latency.md).
 *
 * The first page load runs the entry chunk and every chunk it imports statically (index.html modulepreloads
 * them all), so the budget counts that whole set: moving code from the entry into another statically imported
 * chunk changes nothing for first paint and does not pass the guard. The build fails when the set grows past
 * the budget. Route chunks and lazy imports load later and are not counted.
 */

/**
 * Most script a first page load may fetch (bytes, minified, before compression): the entry and its static
 * imports. About 831 kB at the time of writing (React 219 kB, zod 92 kB, the router, the landing and sign-in
 * screens and the app shell; the status banners' `motion` library, 125 kB, left it for a CSS fade); the budget
 * leaves room for ordinary growth and stops a new library from landing on the first page load. Lower it as that
 * set shrinks.
 */
export const FIRST_LOAD_SCRIPT_BUDGET_BYTES = 860_000;

/** What the guard reads of an output chunk. */
export interface ChunkFacts {
  readonly fileName: string;
  readonly isEntry: boolean;
  readonly code: string;
  /** File names of the chunks it imports statically. */
  readonly imports: readonly string[];
}

export interface FirstLoad {
  /** The entry chunk. */
  readonly entry: string;
  /** The entry and every chunk it imports statically, directly or not, each once. */
  readonly files: readonly string[];
  readonly bytes: number;
}

/** The script each entry loads before it runs: itself and its static imports, transitively. */
export function firstLoads(chunks: readonly ChunkFacts[]): FirstLoad[] {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk] as const));
  return chunks
    .filter((chunk) => chunk.isEntry)
    .map((entry) => {
      const seen = new Set<string>();
      const stack = [entry.fileName];
      let bytes = 0;
      for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
        if (seen.has(name)) continue;
        seen.add(name);
        const chunk = byName.get(name);
        if (chunk === undefined) continue;
        bytes += Buffer.byteLength(chunk.code, 'utf8');
        stack.push(...chunk.imports);
      }
      return { entry: entry.fileName, files: [...seen], bytes };
    });
}

/** First loads over `maxBytes` (empty when every entry fits). */
export function oversizedFirstLoads(chunks: readonly ChunkFacts[], maxBytes: number): FirstLoad[] {
  return firstLoads(chunks).filter((load) => load.bytes > maxBytes);
}

export function firstLoadBudget(maxBytes: number = FIRST_LOAD_SCRIPT_BUDGET_BYTES): Plugin {
  return {
    name: 'foundry:first-load-budget',
    apply: 'build',
    // After every other plugin: the chunks as they are written (Vite fills in the preload lists last).
    enforce: 'post',
    writeBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) => (output.type === 'chunk' ? [output] : []));
      for (const load of oversizedFirstLoads(chunks, maxBytes)) {
        this.error(
          `The first page load of ${load.entry} fetches ${String(load.bytes)} bytes of script in ` +
            `${String(load.files.length)} files, over its budget of ${String(maxBytes)}: move what first paint ` +
            'does not need into a route chunk or a lazy import.',
        );
      }
    },
  };
}

/**
 * Libraries that change rarely and that every page needs, kept in a chunk of their own. It does not make
 * the first load smaller (the entry imports it statically, so it is fetched alongside): its gain is caching.
 * The app's own chunk changes with every release, this one almost never, so a returning visitor keeps it.
 */
export const FRAMEWORK_CHUNK = {
  name: 'framework',
  test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
} as const;
