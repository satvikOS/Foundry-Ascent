/**
 * Renders the operator insights for the ops-insights workflow's public log and job summary: the metadata
 * report as Markdown tables of numbers, and the platform's Lambda log events reduced to an allow-list of
 * fields whose values are ids, codes, numbers and timings (anything else is dropped before it is counted or
 * printed). Pure functions; the CLI wrapper is src/scripts/insights.ts.
 */
import { type InsightsReport } from './insights.js';

// ---- Markdown helpers ----------------------------------------------------------------------------------------

type Cell = string | number | boolean | null | undefined;

function cell(value: Cell): string {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).replace(/\|/g, '/');
}

export function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  if (rows.length === 0) return '_none_\n';
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
  return `${lines.join('\n')}\n`;
}

const short = (id: string | null): string => (id === null ? '–' : id.slice(0, 8));
/** `2026-10-16T12:34:56.789Z` → `10-16 12:34:56` (UTC). */
const when = (iso: string | null): string =>
  iso === null ? '–' : `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
const x100 = (value: number | null): string => (value === null ? '–' : (value / 100).toFixed(2));
const usd = (value: number): string => value.toFixed(4);

function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

// ---- The metadata report -----------------------------------------------------------------------------------

/** Distillation state of a standard conversation with completed turns, from its metadata. */
export function distillState(c: InsightsReport['conversations'][number]): string {
  if (c.privacy !== 'standard') return 'private';
  if (c.deleted) return 'deleted';
  if (c.turns.completed === 0) return 'no_turns';
  if (c.digestDeleted) return 'digest_deleted';
  if (c.distillRunning) return 'running';
  if (c.distilledAt === null) return 'never';
  if (c.distillVersion >= c.turns.completed) return c.hasDigest ? 'up_to_date' : 'recorded_without_digest';
  return 'behind';
}

export function renderReport(report: InsightsReport): string {
  const out: string[] = [];
  const conversations = report.conversations;
  const standard = conversations.filter((c) => c.privacy === 'standard');
  const callSeconds = report.calls.reduce((sum, c) => sum + c.seconds, 0);
  const spend = report.usage.reduce((sum, u) => sum + u.usd, 0);
  out.push(`## Platform insights (last ${String(report.days)} days, generated ${report.generatedAt})\n`);
  out.push(
    table(
      [
        'Conversations',
        'Standard',
        'Private',
        'Deleted',
        'Turns (completed)',
        'Calls',
        'Call minutes',
        'AI spend USD',
      ],
      [
        [
          conversations.length,
          standard.length,
          conversations.length - standard.length,
          conversations.filter((c) => c.deleted).length,
          conversations.reduce((sum, c) => sum + c.turns.completed, 0),
          report.calls.length,
          (callSeconds / 60).toFixed(1),
          usd(spend),
        ],
      ],
    ),
  );

  out.push('\n### Conversations by channel\n');
  const groups = new Map<string, typeof conversations>();
  for (const c of conversations) {
    const key = `${c.channel}/${c.privacy}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  out.push(
    table(
      [
        'Channel / privacy',
        'Conversations',
        'Turns completed',
        'Avg turns',
        'Max turns',
        'Blocked',
        'Failed',
        'Ended',
      ],
      [...groups].map(([key, list]) => {
        const turns = list.map((c) => c.turns.completed);
        const total = turns.reduce((a, b) => a + b, 0);
        return [
          key,
          list.length,
          total,
          (total / list.length).toFixed(1),
          Math.max(...turns),
          list.reduce((s, c) => s + c.turns.blocked, 0),
          list.reduce((s, c) => s + c.turns.failed, 0),
          list.filter((c) => c.status === 'ended').length,
        ];
      }),
    ),
  );

  out.push('\n### Distillation health (standard conversations)\n');
  const states = new Map<string, number>();
  for (const c of standard) states.set(distillState(c), (states.get(distillState(c)) ?? 0) + 1);
  out.push(
    table(
      ['State', 'Conversations'],
      [...states].sort((a, b) => b[1] - a[1]),
    ),
  );
  const recorded = report.audit.filter((a) => a.action.startsWith('session.distill'));
  out.push('\nRecorded distillation outcomes (audit):\n\n');
  out.push(
    table(
      ['Action', 'Outcome', 'Reason', 'Events'],
      recorded.map((a) => [a.action, a.outcome, a.reason, a.events]),
    ),
  );

  out.push('\n### Conversations\n');
  out.push(
    table(
      [
        'Id',
        'Venture',
        'Channel',
        'Privacy',
        'Status',
        'Started (UTC)',
        'Last activity',
        'Turns c/b/f',
        'Calls',
        'Distilled at',
        'Covers',
        'Digest',
        'Distill',
        'Opener',
        'Opener from',
      ],
      conversations.map((c) => [
        short(c.id),
        short(c.ventureId),
        c.channel,
        c.privacy,
        c.deleted ? 'deleted' : c.status,
        when(c.startedAt),
        when(c.lastActivityAt),
        `${String(c.turns.completed)}/${String(c.turns.blocked)}/${String(c.turns.failed)}`,
        c.calls,
        when(c.distilledAt),
        c.distillVersion,
        c.hasDigest,
        distillState(c),
        c.hasOpener,
        short(c.openerSourceSessionId),
      ]),
    ),
  );

  out.push('\n### Calls\n');
  out.push(
    table(
      [
        'Id',
        'Conversation',
        'Started (UTC)',
        'Seconds',
        'End',
        'Detail',
        'Last state',
        'Turns',
        'Interrupted',
        'Speech units',
        'Plays',
        'Chars',
        'First audio p50/p95 ms',
        'Barge-ins',
        'Reconnects',
        'Turn latency p50/p95 ms',
      ],
      report.calls.map((c) => [
        short(c.id),
        short(c.sessionId),
        when(c.startedAt),
        c.seconds,
        c.endReason ?? c.status,
        c.endDetail,
        c.lastState,
        c.turns,
        c.interruptedTurns,
        c.speechUnits,
        c.speechPlays,
        c.speechCharacters,
        `${cell(c.firstAudioMsP50)}/${cell(c.firstAudioMsP95)}`,
        c.bargeIns,
        c.reconnects,
        `${cell(c.turnLatencyMsP50)}/${cell(c.turnLatencyMsP95)}`,
      ]),
    ),
  );

  out.push('\n### Turns by channel\n');
  out.push(
    table(
      [
        'Channel',
        'Turns',
        'Completed',
        'Blocked',
        'Failed',
        'Fallback',
        'Model ms p50/p95',
        'First token ms p50/p95',
        'Output tokens avg',
        'Answer chars p50/p95',
        'Spoken chars p50',
        '? per answer',
        'Follow-ups avg',
        'Actions avg',
        'Claims avg',
        'With challenge',
        'Founder chars p50',
      ],
      report.turns.map((t) => [
        t.channel,
        t.turns,
        t.completed,
        t.blocked,
        t.failed,
        t.fallbackUsed,
        `${cell(t.latencyMsP50)}/${cell(t.latencyMsP95)}`,
        `${cell(t.firstTokenMsP50)}/${cell(t.firstTokenMsP95)}`,
        t.outputTokensAvg,
        `${cell(t.answerCharsP50)}/${cell(t.answerCharsP95)}`,
        t.spokenCharsP50,
        x100(t.questionMarksPerAnswerX100),
        x100(t.followUpQuestionsAvgX100),
        x100(t.nextActionsAvgX100),
        x100(t.claimsAvgX100),
        t.withChallenge,
        t.founderCharsP50,
      ]),
    ),
  );
  out.push('\nValidator outcomes:\n\n');
  out.push(
    table(
      [
        'Channel',
        'Identity rewrites',
        'Cross-venture',
        'Narrowed',
        'Escalation forced',
        'Facts downgraded',
        'Evidence ids removed',
      ],
      report.turns.map((t) => [
        t.channel,
        t.identityViolations,
        t.crossVentureViolations,
        t.narrowed,
        t.escalationForced,
        t.factsDowngraded,
        t.evidenceIdsRemoved,
      ]),
    ),
  );
  out.push('\nValidator notes (turns carrying each code):\n\n');
  out.push(
    table(
      ['Code', 'Turns'],
      report.validatorNotes.map((n) => [n.code, n.turns]),
    ),
  );

  out.push('\n### End-to-end turn time (audit `totalMs`) and what each turn remembered\n');
  const byChannel = new Map<string, number[]>();
  for (const t of report.turnTrace) {
    if (t.totalMs === null) continue;
    const key = t.channel ?? 'unknown';
    byChannel.set(key, [...(byChannel.get(key) ?? []), t.totalMs]);
  }
  out.push(
    table(
      ['Channel', 'Turns', 'Total ms p50', 'Total ms p95', 'Max', 'With notebook', 'With digests'],
      [...byChannel].map(([channel, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        const turns = report.turnTrace.filter((t) => (t.channel ?? 'unknown') === channel);
        return [
          channel,
          values.length,
          percentile(sorted, 0.5),
          percentile(sorted, 0.95),
          sorted.at(-1),
          turns.filter((t) => t.notebook === true).length,
          turns.filter((t) => (t.digests ?? 0) > 0).length,
        ];
      }),
    ),
  );
  out.push('\nPer turn:\n\n');
  out.push(
    table(
      [
        'Conversation',
        'Turn',
        'At (UTC)',
        'Channel',
        'Outcome',
        'Notebook',
        'Digests',
        'Opener replayed',
        'Evidence',
        'Total ms',
        'Model ms',
        'First token ms',
        'Stream',
        'Speech units',
        'Input tokens est.',
      ],
      report.turnTrace.map((t) => [
        short(t.sessionId),
        t.ordinal,
        when(t.at),
        t.channel,
        t.reason === null ? t.outcome : `${t.outcome}:${t.reason}`,
        t.notebook,
        t.digests,
        t.openerReplayed,
        t.evidence,
        t.totalMs,
        t.modelMs,
        t.firstTokenMs,
        t.stream,
        t.speechUnits,
        t.inputTokensEstimate,
      ]),
    ),
  );

  out.push('\n### Knowledge per venture\n');
  out.push(
    table(
      [
        'Venture',
        'Conversations',
        'Digests',
        'Notebook v',
        'Notebook updated',
        'Next opener',
        'Commitments',
        'Open questions',
        'Profile',
        'Advice',
        'Memory proposed',
        'Confirmed',
        'Rejected',
        'Expired',
        'Deleted',
        'From AI',
        'Lessons',
      ],
      report.ventures.map((v) => [
        short(v.ventureId),
        v.conversations,
        v.digests,
        v.notebookVersion,
        when(v.notebookUpdatedAt),
        v.notebookHasNextOpener,
        v.notebookCommitments,
        v.notebookOpenQuestions,
        v.notebookProfileLines,
        v.notebookAdviceLines,
        v.memory.proposed,
        v.memory.confirmed,
        v.memory.rejected,
        v.memory.expired,
        v.memory.deleted,
        v.memoryFromAi,
        v.lessonsDrafted,
      ]),
    ),
  );

  out.push('\n### Usage by purpose and model\n');
  out.push(
    table(
      ['Purpose', 'Model', 'Calls', 'Input', 'Output', 'USD'],
      report.usage.map((u) => [u.purpose, u.modelId, u.calls, u.inputTokens, u.outputTokens, usd(u.usd)]),
    ),
  );

  out.push('\n### Audit events\n');
  out.push(
    table(
      ['Action', 'Outcome', 'Reason', 'Events'],
      report.audit.map((a) => [a.action, a.outcome, a.reason, a.events]),
    ),
  );
  return out.join('');
}

// ---- Lambda log events -------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ROUTE = /^\/[A-Za-z0-9/:_.-]{0,160}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The fields kept from a log line, each with the shape its value must have (anything else is dropped). */
const FIELDS: Readonly<
  Record<string, 'uuid' | 'code' | 'iso' | 'route' | 'name' | 'request' | 'number' | 'boolean'>
> = {
  time: 'iso',
  level: 'code',
  event: 'code',
  process: 'code',
  requestId: 'request',
  messageId: 'uuid',
  sessionId: 'uuid',
  callId: 'uuid',
  turnId: 'uuid',
  batchId: 'uuid',
  jobType: 'code',
  attempt: 'number',
  status: 'code',
  reason: 'code',
  outcome: 'code',
  trigger: 'code',
  code: 'code',
  turns: 'number',
  delaySeconds: 'number',
  notebookVersion: 'number',
  memoryProposed: 'number',
  memoryRepeated: 'number',
  lessonsDrafted: 'number',
  retryable: 'boolean',
  replayed: 'boolean',
  errorName: 'name',
  candidates: 'number',
  distilled: 'number',
  skipped: 'number',
  dropped: 'number',
  failed: 'number',
  deferred: 'number',
  parts: 'number',
  part: 'number',
  round: 'number',
  records: 'number',
  failures: 'number',
  method: 'name',
  route: 'route',
  latencyMs: 'number',
  streaming: 'boolean',
  frames: 'number',
  deltas: 'number',
  speechUnits: 'number',
  ephemeralSessionsEnded: 'number',
  staleCallsEnded: 'number',
  proposalsExpired: 'number',
  distillCandidates: 'number',
  distillFailed: 'number',
  distillDeferred: 'number',
};

export type LogValue = string | number | boolean;
export type SanitizedLogEvent = Readonly<Record<string, LogValue>> & { readonly group: string };

function keep(kind: (typeof FIELDS)[string], value: unknown): LogValue | undefined {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    default: {
      if (typeof value !== 'string') return undefined;
      const pattern = { uuid: UUID, code: CODE, iso: ISO, route: ROUTE, name: NAME, request: REQUEST_ID }[
        kind
      ];
      return pattern.test(value) ? value : undefined;
    }
  }
}

/** A Lambda REPORT line's numbers (duration, billed, memory, init when it was a cold start). */
const REPORT_LINE =
  /^REPORT RequestId: [0-9a-f-]{36}\s+Duration: ([0-9.]+) ms\s+Billed Duration: ([0-9]+) ms\s+Memory Size: ([0-9]+) MB\s+Max Memory Used: ([0-9]+) MB(?:\s+Init Duration: ([0-9.]+) ms)?/;

/** The group's short name: `/aws/lambda/FoundryAscent-Worker` → `worker`. */
export function groupName(logGroup: string): string {
  const match = /FoundryAscent-([A-Za-z]+)$/.exec(logGroup);
  return match?.[1]?.toLowerCase() ?? 'other';
}

/**
 * One raw CloudWatch event (`aws logs filter-log-events` output) reduced to its allowed fields, or null. A
 * REPORT line becomes `{event: 'lambda.report', durationMs, initMs?, memoryMb}`; other non-JSON lines are
 * dropped.
 */
export function sanitizeLogEvent(
  group: string,
  message: string,
  timestamp: number,
): SanitizedLogEvent | null {
  const text = message.trim();
  const report = REPORT_LINE.exec(text);
  if (report) {
    const event: Record<string, LogValue> = {
      group,
      event: 'lambda.report',
      time: new Date(timestamp).toISOString(),
      durationMs: Number(report[1]),
      maxMemoryMb: Number(report[4]),
    };
    if (report[5] !== undefined) event.initMs = Number(report[5]);
    return event as SanitizedLogEvent;
  }
  if (!text.startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const event: Record<string, LogValue> = { group };
  for (const [key, kind] of Object.entries(FIELDS)) {
    const value = keep(kind, record[key]);
    if (value !== undefined) event[key] = value;
  }
  if (typeof event.event !== 'string') return null;
  if (typeof event.time !== 'string') event.time = new Date(timestamp).toISOString();
  return event as SanitizedLogEvent;
}

/** Events of `aws logs filter-log-events` JSON output (`{events: [{message, timestamp, logStreamName}]}`). */
export function eventsOf(output: unknown): { message: string; timestamp: number }[] {
  const events = (output as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((e: unknown) => {
    const { message, timestamp } = (e ?? {}) as { message?: unknown; timestamp?: unknown };
    return typeof message === 'string' && typeof timestamp === 'number' ? [{ message, timestamp }] : [];
  });
}

const DISTILL_EVENTS = /^(distill\.|worker\.distill|worker\.maintenance|maintenance\.)/;

export function renderLogs(events: readonly SanitizedLogEvent[]): string {
  const out: string[] = [];
  out.push(`## Lambda logs (${String(events.length)} events kept)\n`);

  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event === 'http.request' || e.event === 'lambda.report') continue;
    const detail = [e.status, e.outcome, e.reason, e.code, e.trigger].filter((v) => typeof v === 'string');
    const key = [e.group, e.event, detail.join('/')].join('\u0000');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  out.push('\n### Events\n');
  out.push(
    table(
      ['Function', 'Event', 'Status / reason', 'Count'],
      [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([key, n]) => [...key.split('\u0000'), n]),
    ),
  );

  out.push('\n### Distillation timeline (per conversation)\n');
  const timeline = events
    .filter((e) => DISTILL_EVENTS.test(String(e.event)))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  out.push(
    table(
      [
        'At (UTC)',
        'Function',
        'Event',
        'Conversation',
        'Trigger',
        'Status',
        'Reason',
        'Turns',
        'Delay s',
        'Error',
      ],
      timeline.map((e) => [
        when(typeof e.time === 'string' ? e.time : null),
        e.group,
        e.event,
        typeof e.sessionId === 'string' ? short(e.sessionId) : null,
        e.trigger,
        e.status ?? e.outcome,
        e.reason,
        e.turns,
        e.delaySeconds,
        e.errorName,
      ]),
    ),
  );

  out.push('\n### API routes\n');
  const routes = new Map<string, { latency: number[]; errors: number }>();
  for (const e of events) {
    if (e.event !== 'http.request' || typeof e.route !== 'string') continue;
    const key = `${typeof e.method === 'string' ? e.method : '?'} ${e.route}`;
    const entry = routes.get(key) ?? { latency: [], errors: 0 };
    if (typeof e.latencyMs === 'number') entry.latency.push(e.latencyMs);
    if (e.level === 'error') entry.errors += 1;
    routes.set(key, entry);
  }
  out.push(
    table(
      ['Route', 'Requests', 'p50 ms', 'p95 ms', 'Max ms', '5xx'],
      [...routes]
        .sort((a, b) => b[1].latency.length - a[1].latency.length)
        .map(([route, { latency, errors }]) => {
          const sorted = [...latency].sort((a, b) => a - b);
          return [
            route,
            latency.length,
            percentile(sorted, 0.5),
            percentile(sorted, 0.95),
            sorted.at(-1),
            errors,
          ];
        }),
    ),
  );

  out.push('\n### Lambda invocations\n');
  const functions = new Map<string, { durations: number[]; inits: number[] }>();
  for (const e of events) {
    if (e.event !== 'lambda.report' || typeof e.durationMs !== 'number') continue;
    const entry = functions.get(e.group) ?? { durations: [], inits: [] };
    entry.durations.push(e.durationMs);
    if (typeof e.initMs === 'number') entry.inits.push(e.initMs);
    functions.set(e.group, entry);
  }
  out.push(
    table(
      ['Function', 'Invocations', 'Duration p50 ms', 'p95 ms', 'Cold starts', 'Init p50 ms', 'Init max ms'],
      [...functions].map(([name, { durations, inits }]) => {
        const d = [...durations].sort((a, b) => a - b);
        const i = [...inits].sort((a, b) => a - b);
        const round = (v: number | null | undefined): number | null =>
          v === null || v === undefined ? null : Math.round(v);
        return [
          name,
          d.length,
          round(percentile(d, 0.5)),
          round(percentile(d, 0.95)),
          i.length,
          round(percentile(i, 0.5)),
          round(i.at(-1)),
        ];
      }),
    ),
  );
  return out.join('');
}
