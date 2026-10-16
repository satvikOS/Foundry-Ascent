import { describe, expect, it } from 'vitest';

import {
  FIRST_LOAD_SCRIPT_BUDGET_BYTES,
  FRAMEWORK_CHUNK,
  firstLoads,
  oversizedFirstLoads,
  type ChunkFacts,
} from './page-speed';

const chunk = (fileName: string, bytes: number, imports: string[] = [], isEntry = false): ChunkFacts => ({
  fileName,
  isEntry,
  code: 'x'.repeat(bytes),
  imports,
});

describe('page-speed build guards', () => {
  it('counts the entry and every chunk it imports statically, each once, and nothing loaded later', () => {
    const chunks = [
      chunk('assets/index.js', 100, ['assets/framework.js', 'assets/client.js'], true),
      chunk('assets/framework.js', 200),
      // Imports the framework too (a diamond) and imports the entry back (a cycle).
      chunk('assets/client.js', 30, ['assets/framework.js', 'assets/zod.js', 'assets/index.js']),
      chunk('assets/zod.js', 7),
      // A route chunk: loaded on navigation, so never part of the first load.
      chunk('assets/knowledge.js', 5_000, ['assets/framework.js']),
    ];
    const [load] = firstLoads(chunks);
    expect(load?.entry).toBe('assets/index.js');
    expect([...(load?.files ?? [])].sort()).toEqual([
      'assets/client.js',
      'assets/framework.js',
      'assets/index.js',
      'assets/zod.js',
    ]);
    expect(load?.bytes).toBe(337);
  });

  it('fails a small entry whose static imports carry the weight (the bytes still load first)', () => {
    // An entry well under the budget on its own: moving code into a preloaded chunk must not pass the guard.
    const chunks = [
      chunk('assets/index.js', 400_000, ['assets/framework.js'], true),
      chunk('assets/framework.js', FIRST_LOAD_SCRIPT_BUDGET_BYTES - 400_000 + 1),
      chunk('assets/route.js', 900_000),
    ];
    expect(oversizedFirstLoads(chunks, FIRST_LOAD_SCRIPT_BUDGET_BYTES)).toEqual([
      {
        entry: 'assets/index.js',
        files: ['assets/index.js', 'assets/framework.js'],
        bytes: FIRST_LOAD_SCRIPT_BUDGET_BYTES + 1,
      },
    ]);
    // Exactly at the budget fits; bytes are UTF-8 bytes, not characters.
    const fits = [
      { ...chunk('assets/index.js', 0, [], true), code: 'é'.repeat(FIRST_LOAD_SCRIPT_BUDGET_BYTES / 2) },
    ];
    expect(oversizedFirstLoads(fits, FIRST_LOAD_SCRIPT_BUDGET_BYTES)).toEqual([]);
  });

  it('puts React and its scheduler, and nothing else, in the framework chunk', () => {
    const inFramework = (id: string) => FRAMEWORK_CHUNK.test.test(id);
    expect(inFramework('/repo/node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/client.js')).toBe(
      true,
    );
    expect(inFramework('/repo/node_modules/.pnpm/react@19.3.0/node_modules/react/jsx-runtime.js')).toBe(true);
    expect(inFramework('/repo/node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/index.js')).toBe(
      true,
    );
    expect(
      inFramework('/repo/node_modules/.pnpm/react-markdown@10.1.0/node_modules/react-markdown/index.js'),
    ).toBe(false);
    expect(
      inFramework('/repo/node_modules/.pnpm/react-hook-form@7.89.0/node_modules/react-hook-form/x.js'),
    ).toBe(false);
    expect(inFramework('/repo/apps/web/src/react/thing.ts')).toBe(false);
  });
});
