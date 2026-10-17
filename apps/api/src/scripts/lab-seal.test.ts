import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { open, SealedEnvelope } from '../jobs/insights-envelope.js';
import {
  bundle,
  LAB_KIND,
  LabBundle,
  MAX_PART_BYTES,
  openDirectory,
  safeRelativePath,
  sealDirectory,
} from './lab-seal.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const SECRET = 'founder said: we price at forty-nine dollars per branch';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 250, 251]);

let root = '';
let input = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lab-seal-'));
  input = join(root, 'private');
  await mkdir(join(input, 'recall', 'shots'), { recursive: true });
  await writeFile(join(input, 'recall', 'R1.json'), JSON.stringify({ reply: SECRET }));
  await writeFile(join(input, 'recall', 'shots', 'R1.png'), PNG);
  await writeFile(join(input, 'api.log'), `{"msg":"turn.completed"}\n${SECRET}\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('lab-seal', () => {
  it('seals every file into envelopes that carry no plaintext, openable with the insights envelope code', async () => {
    const out = join(root, 'sealed');
    const done = await sealDirectory('recall', input, out, publicB64);
    expect(done).toEqual({ files: 3, envelopes: 1, skipped: 0 });
    const names = await readdir(out);
    expect(names).toEqual(['lab-recall-0001.json']);
    const text = await readFile(join(out, names[0] ?? ''), 'utf8');
    expect(text).not.toContain('forty-nine');
    expect(text).not.toContain('turn.completed');
    const raw = JSON.parse(text) as { kind: string; envelope: unknown };
    // Exactly the ops-insights upload check: only {kind, envelope} with the envelope's seven keys.
    expect(Object.keys(raw).sort()).toEqual(['envelope', 'kind']);
    expect(raw.kind).toBe(LAB_KIND);
    const envelope = SealedEnvelope.parse(raw.envelope);
    expect(Object.keys(envelope).sort()).toEqual(['alg', 'data', 'iv', 'key', 'kid', 'tag', 'v']);
    const opened = LabBundle.parse(open(envelope, privatePem));
    expect(opened.files.map((f) => [f.path, f.encoding])).toEqual([
      ['api.log', 'utf8'],
      ['recall/R1.json', 'utf8'],
      ['recall/shots/R1.png', 'base64'],
    ]);
  });

  it('opens the envelopes back into the same files', async () => {
    const sealed = join(root, 'sealed-2');
    await sealDirectory('recall', input, sealed, publicB64);
    const restored = join(root, 'restored');
    expect(await openDirectory(privatePem, sealed, restored)).toEqual({ envelopes: 1, files: 3 });
    expect(await readFile(join(restored, 'recall', 'recall', 'R1.json'), 'utf8')).toContain(SECRET);
    expect(Buffer.compare(await readFile(join(restored, 'recall', 'recall', 'shots', 'R1.png')), PNG)).toBe(
      0,
    );
  });

  it('splits large outputs into parts and leaves out a single file larger than a part', async () => {
    const big = join(root, 'big');
    await mkdir(big, { recursive: true });
    const chunk = Buffer.alloc(Math.floor(MAX_PART_BYTES * 0.6), 7);
    await writeFile(join(big, 'a.bin'), chunk);
    await writeFile(join(big, 'b.bin'), chunk);
    await writeFile(join(big, 'huge.bin'), Buffer.alloc(MAX_PART_BYTES + 1, 1));
    const parts = await bundle('ui', big);
    expect(parts.map((p) => [p.part, p.files.map((f) => f.path)])).toEqual([
      [1, ['a.bin']],
      [2, ['b.bin']],
    ]);
    const done = await sealDirectory('ui', big, join(root, 'sealed-big'), publicB64);
    expect(done).toEqual({ files: 2, envelopes: 2, skipped: 1 });
  });

  it('refuses a weak or malformed key and an unsafe suite name', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const weakB64 = weak.export({ format: 'der', type: 'spki' }).toString('base64');
    await expect(sealDirectory('recall', input, join(root, 'x'), weakB64)).rejects.toThrow(/3072/);
    await expect(sealDirectory('recall', input, join(root, 'x'), 'not a key')).rejects.toThrow();
    await expect(bundle('../etc', input)).rejects.toThrow(/suite/);
  });

  it('never restores a file outside the output folder', () => {
    expect(safeRelativePath('recall/R1.json')).toBe('recall/R1.json');
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'C:/x', '..']) {
      expect(() => safeRelativePath(bad)).toThrow(/unsafe/);
    }
  });
});
