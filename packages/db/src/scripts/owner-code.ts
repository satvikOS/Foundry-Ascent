/**
 * Generates a new OWNER access code on a trusted machine (docs/runbooks/access-codes.md, "Rotate the
 * owner code"):
 *
 *   pnpm --filter @foundry/db owner-code
 *
 * Prints the plaintext code exactly once, with a warning, and the public prefix and scrypt hash to paste
 * into infra/cdk/config/production.json (`owner.accessCodePrefix`, `owner.accessCodeHash`). Nothing is
 * written to disk or sent anywhere. It refuses to run in CI, so a code can never land in a workflow log.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  accessCodePrefix,
  generateAccessCode,
  hashAccessCode,
  isAccessCodeHash,
  verifyAccessCode,
} from '../seed/access-code.js';

export interface OwnerCode {
  /** Plaintext code: a bearer credential. Show once, never store or log it. */
  readonly code: string;
  /** Public lookup prefix (`owner.accessCodePrefix`). */
  readonly prefix: string;
  /** scrypt hash (`owner.accessCodeHash`); public by design. */
  readonly hash: string;
}

/** A fresh owner code with its prefix and hash; the hash is verified against the code before use. */
export async function createOwnerCode(generate: () => string = generateAccessCode): Promise<OwnerCode> {
  const code = generate();
  const hash = await hashAccessCode(code);
  if (!isAccessCodeHash(hash) || !(await verifyAccessCode(code, hash))) {
    throw new Error('the generated hash does not verify against the code');
  }
  return { code, prefix: accessCodePrefix(code), hash };
}

/** The text printed for the operator: the warning, the code once, then the production.json values. */
export function renderOwnerCode({ code, prefix, hash }: OwnerCode): string {
  return [
    '',
    'WARNING: below is a new OWNER access code (platform admin + program lead). It is shown only once.',
    'Store it in your password manager now, then clear this terminal and its scrollback. Never paste it',
    'into git, an issue, a chat, a workflow input or a log.',
    '',
    `  owner access code   ${code}`,
    '',
    'Paste these two public values into infra/cdk/config/production.json ("owner"), open a PR, and let the',
    'normal deploy apply them (the previous owner code is revoked when the prefix changes):',
    '',
    `    "accessCodePrefix": ${JSON.stringify(prefix)},`,
    `    "accessCodeHash": ${JSON.stringify(hash)}`,
    '',
    'If the Actions secret FA_OWNER_ACCESS_CODE exists (evals), update it with the new code after the deploy.',
    '',
  ].join('\n');
}

/** True when running in CI (GitHub Actions or any runner that sets CI): never print a code there. */
export function runningInCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true' || (env.CI !== undefined && env.CI !== '' && env.CI !== 'false');
}

async function main(): Promise<void> {
  if (runningInCi()) {
    throw new Error('owner-code refuses to run in CI: generate owner codes on a trusted machine only');
  }
  process.stdout.write(renderOwnerCode(await createOwnerCode()));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(`owner-code failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  });
}
