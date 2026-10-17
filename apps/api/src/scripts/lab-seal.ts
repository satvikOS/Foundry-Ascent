/**
 * Seals the conversation lab's private outputs (transcripts, judge rationales, failure screenshots, server logs)
 * to the operator's RSA public key, with the same envelope as the insights export (jobs/insights-envelope.ts:
 * RSA-OAEP-256 wrapping a random AES-256-GCM key, gzip), and opens them again on the operator's machine.
 * docs/runbooks/conversation-lab.md, .github/workflows/ops-conversation-lab.yml.
 *
 *   LAB_PUBLIC_KEY=<base64 DER> tsx src/scripts/lab-seal.ts seal <suite> <inDir> <outDir>
 *   tsx src/scripts/lab-seal.ts open <private.pem> <sealedDir> <outDir>
 *
 * `seal` writes `<outDir>/lab-<suite>-NNNN.json` files that hold nothing but an envelope, and prints counts
 * only. `open` restores the files under `<outDir>` (paths are checked: relative, no `..`).
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';

import { z } from 'zod';

import { open, parseRecipientKey, SealedEnvelope, seal } from '../jobs/insights-envelope.js';

export const LAB_KIND = 'conversation-lab';
/** Raw bytes per envelope: well under the envelope schema's 16 MB of base64 once encoded and encrypted. */
export const MAX_PART_BYTES = 6 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt', '.log', '.csv']);
const SUITE = /^[a-z][a-z0-9-]{0,31}$/;

export const LabFile = z
  .object({
    path: z.string().min(1).max(300),
    encoding: z.enum(['utf8', 'base64']),
    data: z.string(),
  })
  .strict();
export type LabFile = z.infer<typeof LabFile>;

export const LabBundle = z
  .object({
    kind: z.literal(LAB_KIND),
    version: z.literal(1),
    suite: z.string().regex(SUITE),
    part: z.number().int().min(1),
    files: z.array(LabFile),
  })
  .strict();
export type LabBundle = z.infer<typeof LabBundle>;

/** A path as stored in a bundle: relative, forward slashes, no `..` or absolute part. */
export function safeRelativePath(path: string): string {
  const unified = path.replace(/\\/g, '/');
  const normal = normalize(unified).replace(/\\/g, '/');
  if (normal.startsWith('/') || normal === '..' || normal.startsWith('../') || /^[A-Za-z]:/.test(normal)) {
    throw new Error('unsafe path in bundle');
  }
  if (normal.split('/').some((segment) => segment === '..' || segment === ''))
    throw new Error('unsafe path in bundle');
  return normal;
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/** Packs every file under `inDir` into bundles of at most {@link MAX_PART_BYTES} raw bytes each. */
export async function bundle(suite: string, inDir: string): Promise<LabBundle[]> {
  if (!SUITE.test(suite)) throw new Error('suite must be a short lowercase name');
  const bundles: LabBundle[] = [];
  let files: LabFile[] = [];
  let size = 0;
  const flush = (): void => {
    if (files.length === 0) return;
    bundles.push({ kind: LAB_KIND, version: 1, suite, part: bundles.length + 1, files });
    files = [];
    size = 0;
  };
  for (const full of await filesUnder(inDir)) {
    const bytes = (await stat(full)).size;
    // A single file larger than a part is left out (traces, videos); it is counted, never uploaded in plaintext.
    if (bytes > MAX_PART_BYTES) continue;
    if (size + bytes > MAX_PART_BYTES) flush();
    const path = safeRelativePath(relative(inDir, full).split(sep).join('/'));
    const raw = await readFile(full);
    const text = TEXT_EXTENSIONS.has(extensionOf(full));
    files.push({ path, encoding: text ? 'utf8' : 'base64', data: raw.toString(text ? 'utf8' : 'base64') });
    size += bytes;
  }
  flush();
  return bundles;
}

export async function sealDirectory(
  suite: string,
  inDir: string,
  outDir: string,
  publicKey: string,
): Promise<{ files: number; envelopes: number; skipped: number }> {
  const recipient = parseRecipientKey(publicKey);
  const all = await filesUnder(inDir);
  const bundles = await bundle(suite, inDir);
  await mkdir(outDir, { recursive: true });
  for (const b of bundles) {
    const envelope = seal(b, recipient);
    const name = `lab-${suite}-${String(b.part).padStart(4, '0')}.json`;
    await writeFile(join(outDir, name), `${JSON.stringify({ kind: LAB_KIND, envelope })}\n`, { mode: 0o600 });
  }
  const packed = bundles.reduce((n, b) => n + b.files.length, 0);
  return { files: packed, envelopes: bundles.length, skipped: all.length - packed };
}

export async function openDirectory(
  privateKeyPem: string,
  sealedDir: string,
  outDir: string,
): Promise<{ envelopes: number; files: number }> {
  let envelopes = 0;
  let files = 0;
  for (const name of (await readdir(sealedDir)).filter((n) => n.endsWith('.json')).sort()) {
    const raw = JSON.parse(await readFile(join(sealedDir, name), 'utf8')) as {
      kind?: unknown;
      envelope?: unknown;
    };
    if (raw.kind !== LAB_KIND) continue;
    const parsed = LabBundle.parse(open(SealedEnvelope.parse(raw.envelope), privateKeyPem));
    envelopes += 1;
    for (const file of parsed.files) {
      const target = join(outDir, parsed.suite, safeRelativePath(file.path));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(file.data, file.encoding), { mode: 0o600 });
      files += 1;
    }
  }
  return { envelopes, files };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === 'seal') {
    const [suite, inDir, outDir] = args;
    if (!suite || !inDir || !outDir)
      fail('usage: LAB_PUBLIC_KEY=… lab-seal.ts seal <suite> <inDir> <outDir>');
    const key = process.env.LAB_PUBLIC_KEY?.trim();
    if (!key) fail('lab-seal: LAB_PUBLIC_KEY is not set');
    const done = await sealDirectory(suite, inDir, outDir, key);
    process.stdout.write(
      `lab-seal: ${String(done.files)} files sealed into ${String(done.envelopes)} envelopes (${String(done.skipped)} too large, left out)\n`,
    );
    return;
  }
  if (command === 'open') {
    const [keyFile, sealedDir, outDir] = args;
    if (!keyFile || !sealedDir || !outDir) fail('usage: lab-seal.ts open <private.pem> <sealedDir> <outDir>');
    const done = await openDirectory(await readFile(keyFile, 'utf8'), sealedDir, outDir);
    process.stderr.write(
      `lab-seal: opened ${String(done.envelopes)} envelopes, ${String(done.files)} files\n`,
    );
    return;
  }
  fail('usage: lab-seal.ts seal|open …');
}

if (process.argv[1] && /lab-seal\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // Names only: a message could echo content.
    fail(`lab-seal: ${err instanceof Error ? err.name : typeof err}`);
  });
}
