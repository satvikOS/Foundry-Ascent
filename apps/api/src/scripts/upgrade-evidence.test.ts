import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveJournal, hashCommand, journalTranscript, scenarioRange } from './upgrade-evidence.js';

describe('acceptance evidence survives large outputs and interrupted finalization', () => {
  it('hashes more than the old stdout buffer without buffering the diff', async () => {
    const size = 2 * 1024 * 1024;
    const hash = await hashCommand(
      process.execPath,
      ['-e', `process.stdout.write('x'.repeat(${String(size)}))`],
      process.cwd(),
    );
    expect(hash).toBe(createHash('sha256').update(Buffer.alloc(size, 'x')).digest('hex'));
  });
  it('retains the journal after a later process fails and can archive it without losing Unicode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-evidence-'));
    try {
      const file = join(dir, 'transcripts.jsonl');
      const row = {
        id: 'synthetic',
        transcript: [{ role: 'student', text: 'A correction — not a new claim.' }],
      };
      journalTranscript(file, row);
      await expect(
        hashCommand(process.execPath, ['-e', "process.stderr.write('private-content');process.exit(1)"], dir),
      ).rejects.toThrow('Evidence hash process failed.');
      expect(JSON.parse(readFileSync(file, 'utf8').trim())).toEqual(row);
      await archiveJournal(file);
      expect(gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(readFileSync(file, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('partitions the corpus without duplicates or missing scenarios', () => {
    const ids = [0, 150, 300, 450].flatMap((offset) => {
      const range = scenarioRange(600, String(offset), '150');
      return Array.from({ length: range.limit }, (_, i) => i + range.offset);
    });
    expect(ids).toEqual(Array.from({ length: 600 }, (_, i) => i));
  });
  it.each([
    ['-1', '20'],
    ['0', '0'],
    ['0', '601'],
    ['600', '1'],
    ['1', '600'],
    ['NaN', '20'],
    ['0', '1.5'],
  ])('rejects invalid range %s / %s', (offset, limit) => {
    expect(() => scenarioRange(600, offset, limit)).toThrow('Invalid scenario range.');
  });
});
