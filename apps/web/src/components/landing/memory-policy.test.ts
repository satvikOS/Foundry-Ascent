import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * One memory policy on every surface that describes memory. The product is moving from "nothing is
 * remembered until someone keeps it" (approval) to "it remembers on its own, and never from a private
 * conversation" (automatic). The public pages, the page description and the in-app Data use & privacy
 * dialog are written in different places and land in different changes; whichever lands first, they must
 * never state both policies at once, and none may promise the automatic one before the dialog does.
 */

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SURFACES: Record<string, string> = {
  landing: 'src/routes/index.tsx',
  'sign-in': 'src/routes/sign-in.tsx',
  'page description': 'index.html',
  'product preview': 'src/components/landing/product-preview.tsx',
  'Data use & privacy dialog': 'src/components/shell/account-dialogs.tsx',
};

const POLICIES = {
  approval: [
    /\buntil (?:someone|you|your team)\b[^.]*\b(?:keeps?|approves?)\b/i,
    /\bapprove what\b/i,
    /\bfounder-approved memory\b/i,
    /\bmemory you approve\b/i,
    /\bwould like to remember\b/i,
  ],
  automatic: [/\bon its own\b/i, /\bremember(?:s|ed)? automatically\b/i, /\bnothing from a private\b/i],
} as const;

type Policy = keyof typeof POLICIES;

function statedPolicies(source: string): Policy[] {
  // Line breaks inside JSX text are spaces when rendered.
  const text = source.replace(/\s+/g, ' ');
  return (Object.keys(POLICIES) as Policy[]).filter((policy) =>
    POLICIES[policy].some((pattern) => pattern.test(text)),
  );
}

const stated = Object.entries(SURFACES).map(([surface, path]) => ({
  surface,
  policies: statedPolicies(readFileSync(join(web, path), 'utf8')),
}));

describe('memory policy copy', () => {
  it('recognises both wordings (so the check below is not vacuous)', () => {
    expect(statedPolicies('Nothing becomes venture memory until someone on your team keeps it.')).toEqual([
      'approval',
    ]);
    expect(
      statedPolicies(
        'It keeps what matters from every conversation on its own, and nothing from a private one.',
      ),
    ).toEqual(['automatic']);
    expect(statedPolicies('Everything it keeps is yours to read, correct or delete.')).toEqual([]);
  });

  it('the dialog that explains data use states a policy', () => {
    const dialog = stated.find((s) => s.surface === 'Data use & privacy dialog');
    expect(dialog?.policies).toHaveLength(1);
  });

  it('every surface agrees with the Data use & privacy dialog', () => {
    const dialog = stated.find((s) => s.surface === 'Data use & privacy dialog')?.policies[0];
    const disagreeing = stated
      .filter((s) => s.policies.some((policy) => policy !== dialog))
      .map((s) => `${s.surface}: ${s.policies.join(', ')}`);
    expect(disagreeing).toEqual([]);
  });
});
