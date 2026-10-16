/**
 * Operator insights helpers for the ops-insights workflow (.github/workflows/ops-insights.yml) and the
 * operator's own machine (docs/runbooks/insights.md):
 *
 *   tsx src/scripts/insights.ts report <response.json>          metadata response → Markdown (stdout)
 *   tsx src/scripts/insights.ts part <response.json> <outDir>   export response → <outDir>/part-NNNN.json,
 *                                                               prints `next=<cursor>` or `next=none`
 *   tsx src/scripts/insights.ts logs <events.json>...           filter-log-events outputs → Markdown; with
 *                                                               INSIGHTS_PUBLIC_KEY and INSIGHTS_OUT_DIR also
 *                                                               seals the kept events to <outDir>/logs.json
 *   tsx src/scripts/insights.ts open <private.pem> <dir> <out.json>   decrypts every sealed file of <dir>
 *
 * Nothing it prints can carry content: responses are validated against the strict schemas first, and an error
 * response prints only its code.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { groupName, renderLogs, renderReport, sanitizeLogEvent, eventsOf } from '../jobs/insights-render.js';
import { open, parseRecipientKey, SealedEnvelope, seal } from '../jobs/insights-envelope.js';
import { InsightsExportPart, InsightsResponse } from '../jobs/insights.js';

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Parses a Lambda response; an unexpected shape is reported by its top-level keys only. */
async function response(file: string): Promise<InsightsResponse> {
  const raw = await readJson(file);
  const parsed = InsightsResponse.safeParse(raw);
  if (!parsed.success) {
    const keys =
      typeof raw === 'object' && raw !== null ? Object.keys(raw).slice(0, 10).join(',') : typeof raw;
    fail(`insights: unexpected response (keys: ${keys})`);
  }
  if (parsed.data.kind === 'error') fail(`insights: the function answered ${parsed.data.error}`);
  return parsed.data;
}

async function report(file: string): Promise<void> {
  const value = await response(file);
  if (value.kind !== 'metadata') fail('insights: expected a metadata response');
  process.stdout.write(renderReport(value));
}

async function part(file: string, outDir: string): Promise<void> {
  const value = await response(file);
  if (value.kind !== 'export') fail('insights: expected an export response');
  const sealed = InsightsExportPart.parse(value);
  await mkdir(outDir, { recursive: true });
  const name = `part-${String(sealed.part).padStart(4, '0')}.json`;
  await writeFile(join(outDir, name), `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
  process.stderr.write(`insights: ${name}: ${String(sealed.conversations)} conversations (sealed)\n`);
  process.stdout.write(`next=${sealed.nextCursor === null ? 'none' : String(sealed.nextCursor)}\n`);
}

async function logs(files: readonly string[]): Promise<void> {
  const kept = [];
  for (const file of files) {
    // File names are `<function>.json` (the workflow writes one per log group).
    const group = groupName(`FoundryAscent-${basename(file, '.json')}`);
    for (const e of eventsOf(await readJson(file))) {
      const event = sanitizeLogEvent(group, e.message, e.timestamp);
      if (event !== null) kept.push(event);
    }
  }
  process.stdout.write(renderLogs(kept));
  const publicKey = process.env.INSIGHTS_PUBLIC_KEY?.trim();
  const outDir = process.env.INSIGHTS_OUT_DIR?.trim();
  if (publicKey && outDir) {
    await mkdir(outDir, { recursive: true });
    const envelope = seal({ kind: 'insights-logs', version: 1, events: kept }, parseRecipientKey(publicKey));
    await writeFile(join(outDir, 'logs.json'), `${JSON.stringify({ kind: 'logs', envelope })}\n`, {
      mode: 0o600,
    });
  }
}

async function openAll(privateKeyFile: string, dir: string, outFile: string): Promise<void> {
  const privateKey = await readFile(privateKeyFile, 'utf8');
  const opened: Record<string, unknown> = {};
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const raw = (await readJson(join(dir, name))) as { envelope?: unknown };
    const envelope = SealedEnvelope.safeParse(raw.envelope);
    if (!envelope.success) continue;
    opened[name] = open(envelope.data, privateKey);
  }
  await writeFile(outFile, JSON.stringify(opened, null, 1), { mode: 0o600 });
  process.stderr.write(`insights: opened ${String(Object.keys(opened).length)} files into ${outFile}\n`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'report':
      return report(args[0] ?? fail('usage: report <response.json>'));
    case 'part':
      return part(
        args[0] ?? fail('usage: part <response.json> <outDir>'),
        args[1] ?? fail('usage: part <response.json> <outDir>'),
      );
    case 'logs':
      return logs(args);
    case 'open':
      return openAll(
        args[0] ?? fail('usage: open <private.pem> <dir> <out.json>'),
        args[1] ?? fail('usage: open <private.pem> <dir> <out.json>'),
        args[2] ?? fail('usage: open <private.pem> <dir> <out.json>'),
      );
    default:
      fail('usage: insights.ts report|part|logs|open …');
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  // Names only: a message could echo a value.
  fail(`insights: ${err instanceof Error ? err.name : typeof err}`);
});
