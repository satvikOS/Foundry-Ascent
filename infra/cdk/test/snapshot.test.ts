/**
 * Template snapshots (system design §11: "cdk synth + cdk-nag + snapshot"). Content hashes (assets,
 * migrations checksum) are normalised so the snapshots change only when the infrastructure does.
 * Review the diff, then update with `pnpm --filter @foundry/infra test -- -u`.
 */
import { describe, expect, it } from 'vitest';
import { defaultSynth } from './helpers.js';

const HASH = /\b[0-9a-f]{64}\b/g;

function normalise(template: unknown): unknown {
  return JSON.parse(JSON.stringify(template).replace(HASH, '<sha256>')) as unknown;
}

describe('template snapshots', () => {
  const { templates } = defaultSynth();

  it.each([
    ['FoundryAscent-Foundation', templates.foundation],
    ['FoundryAscent-Data', templates.data],
    ['FoundryAscent-App', templates.app],
  ])('%s', (_name, template) => {
    expect(normalise(template.toJSON())).toMatchSnapshot();
  });
});
