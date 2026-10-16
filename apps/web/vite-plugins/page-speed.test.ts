import { describe, expect, it } from 'vitest';

import { ENTRY_CHUNK_BUDGET_BYTES, FRAMEWORK_CHUNK, oversizedEntries } from './page-speed';

describe('page-speed build guards', () => {
  it('reports entry chunks over the budget only (other chunks may be larger)', () => {
    const chunks = [
      { fileName: 'assets/index-a.js', isEntry: true, code: 'x'.repeat(650_001) },
      { fileName: 'assets/markdown-b.js', isEntry: false, code: 'x'.repeat(900_000) },
      { fileName: 'assets/other-entry.js', isEntry: true, code: 'é'.repeat(325_000) },
    ];
    // Bytes, not characters: the second entry is 650,000 bytes and fits exactly.
    expect(oversizedEntries(chunks, ENTRY_CHUNK_BUDGET_BYTES)).toEqual([
      { fileName: 'assets/index-a.js', bytes: 650_001 },
    ]);
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
