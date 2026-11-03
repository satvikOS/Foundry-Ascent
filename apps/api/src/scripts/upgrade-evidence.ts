/** Bounded, crash-recoverable evidence utilities; no conversation content is sent to stdout. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, createWriteStream, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export function scenarioRange(total: number, offset = '0', limit = String(total)) {
  if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit)) throw new Error('Invalid scenario range.');
  const start = Number(offset);
  const count = Number(limit);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 1 ||
    start + count > total
  )
    throw new Error('Invalid scenario range.');
  return { offset: start, limit: count };
}

/** Hash arbitrarily large output incrementally, instead of execFileSync's 1MB stdout buffer. */
export function hashCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk));
    child.once('error', () => {
      reject(new Error('Evidence hash process failed.'));
    });
    child.once('close', (code) => {
      if (code === 0) resolve(hash.digest('hex'));
      else reject(new Error('Evidence hash process failed.'));
    });
  });
}

/** Each completed scenario survives later finalization errors; never keep the whole corpus only in RAM. */
export function journalTranscript(file: string, transcript: unknown): void {
  appendFileSync(file, JSON.stringify(transcript) + '\n', { flush: true });
}

/** Publish only a complete gzip archive; the source journal remains available for recovery. */
export async function archiveJournal(file: string): Promise<void> {
  await pipeline(createReadStream(file), createGzip(), createWriteStream(`${file}.gz.tmp`, { flags: 'wx' }));
  renameSync(`${file}.gz.tmp`, `${file}.gz`);
}
