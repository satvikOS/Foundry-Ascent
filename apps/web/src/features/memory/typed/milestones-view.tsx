import type { MemoryObjectView } from '@foundry/contracts';
import { AlarmClock, CalendarRange, Columns3, Link2, Milestone, UserRound } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { displayContent } from '@/lib/api/hooks/memory';

import {
  MILESTONE_STATUSES,
  daysUntil,
  formatIsoDate,
  milestoneAttributes,
  todayIso,
  type MilestoneStatus,
} from './attributes';
import { TypedCard, TypedField, TypedMemoryPage, type TypedPageContext } from './typed-page';
import { MILESTONE_STATUS_DEFS, TypedStatusBadge } from './typed-status';

type Layout = 'timeline' | 'board';
const CLOSED: ReadonlySet<MilestoneStatus> = new Set(['done', 'missed']);

interface Row {
  memory: MemoryObjectView;
  status: MilestoneStatus;
  date: string | undefined;
  owner: string | undefined;
  dependency: string | undefined;
  overdueDays: number | null;
}

function toRow(memory: MemoryObjectView, today: string): Row {
  const a = milestoneAttributes(memory);
  const status = a.status ?? 'planned';
  const days = a.target_date ? daysUntil(a.target_date) : null;
  return {
    memory,
    status,
    date: a.target_date,
    owner: a.owner,
    dependency: a.dependency,
    overdueDays:
      days !== null && days < 0 && !CLOSED.has(status) && (a.target_date ?? '') < today ? -days : null,
  };
}

function relativeDay(date: string): string {
  const days = daysUntil(date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

function MilestoneMeta({ row }: { row: Row }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <TypedStatusBadge kind="milestone" status={row.status} />
      {row.overdueDays !== null ? (
        <span className="inline-flex h-5 items-center gap-1 rounded-md border border-destructive/45 px-1.5 text-xs font-medium text-destructive">
          <AlarmClock aria-hidden className="size-3" />
          Overdue by {row.overdueDays} day{row.overdueDays === 1 ? '' : 's'}
        </span>
      ) : null}
    </span>
  );
}

function MilestoneBody({ row }: { row: Row }) {
  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">{displayContent(row.memory)}</p>
      {row.owner || row.dependency ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          {row.owner ? (
            <TypedField label="Owner" icon={UserRound}>
              {row.owner}
            </TypedField>
          ) : null}
          {row.dependency ? (
            <TypedField label="Depends on" icon={Link2}>
              {row.dependency}
            </TypedField>
          ) : null}
        </dl>
      ) : null}
    </>
  );
}

function Timeline({ rows, ctx }: { rows: Row[]; ctx: TypedPageContext }) {
  const today = todayIso();
  const sorted = [...rows].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const groups: { id: string; title: string; rows: Row[] }[] = [
    { id: 'overdue', title: 'Overdue', rows: sorted.filter((r) => r.overdueDays !== null) },
    {
      id: 'upcoming',
      title: 'Upcoming',
      rows: sorted.filter(
        (r) => r.overdueDays === null && !CLOSED.has(r.status) && r.date && r.date >= today,
      ),
    },
    { id: 'undated', title: 'No target date', rows: sorted.filter((r) => !r.date && !CLOSED.has(r.status)) },
    { id: 'closed', title: 'Done or missed', rows: sorted.filter((r) => CLOSED.has(r.status)).reverse() },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="grid gap-8">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`milestones-${group.id}`}>
          <h2
            id={`milestones-${group.id}`}
            className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            {group.title} <span className="tabular font-medium normal-case">· {group.rows.length}</span>
          </h2>
          <ol className="grid gap-4">
            {group.rows.map((row) => (
              <li key={row.memory.id} className="grid gap-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4">
                <div className="flex items-baseline gap-2 text-sm sm:flex-col sm:items-end sm:gap-0.5 sm:pt-4 sm:text-right">
                  <span className="tabular font-medium">
                    {row.date ? <time dateTime={row.date}>{formatIsoDate(row.date)}</time> : 'No date'}
                  </span>
                  {row.date ? (
                    <span className="text-xs text-muted-foreground">{relativeDay(row.date)}</span>
                  ) : null}
                </div>
                <TypedCard memory={row.memory} ctx={ctx} meta={<MilestoneMeta row={row} />}>
                  <MilestoneBody row={row} />
                </TypedCard>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Board({ rows, ctx }: { rows: Row[]; ctx: TypedPageContext }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      {MILESTONE_STATUSES.map((status) => {
        const list = rows
          .filter((r) => r.status === status)
          .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
        return (
          <section
            key={status}
            aria-label={`${MILESTONE_STATUS_DEFS[status].label} milestones`}
            className="grid content-start gap-3 rounded-xl bg-muted/40 p-3"
          >
            <h2 className="flex items-center justify-between gap-2 px-1">
              <TypedStatusBadge kind="milestone" status={status} />
              <span className="tabular text-xs text-muted-foreground">{list.length}</span>
            </h2>
            {list.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                Empty
              </p>
            ) : (
              <ul className="grid gap-3">
                {list.map((row) => (
                  <li key={row.memory.id}>
                    <TypedCard
                      memory={row.memory}
                      ctx={ctx}
                      headingLevel={4}
                      meta={
                        <span className="text-xs text-muted-foreground">
                          {row.date ? formatIsoDate(row.date) : 'No date'}
                          {row.overdueDays !== null ? (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 font-medium text-destructive">
                              <AlarmClock aria-hidden className="size-3" />
                              Overdue
                            </span>
                          ) : null}
                        </span>
                      }
                    >
                      <MilestoneBody row={row} />
                    </TypedCard>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Milestones as a dated timeline (overdue first) or a status board. */
export function MilestonesView() {
  const [layout, setLayout] = useState<Layout>('timeline');
  const today = todayIso();
  return (
    <TypedMemoryPage
      kind="milestone"
      title="Milestones"
      description="Dated goals with owners and dependencies. Overdue milestones surface in your overview and in coaching sessions."
      icon={Milestone}
      emptyTitle="No milestones yet"
      emptyDescription="Add the next two or three outcomes that matter, each with a target date and an owner."
      controls={
        <div className="flex items-center gap-1" role="group" aria-label="Layout">
          <Button
            size="sm"
            variant={layout === 'timeline' ? 'secondary' : 'ghost'}
            aria-pressed={layout === 'timeline'}
            onClick={() => {
              setLayout('timeline');
            }}
          >
            <CalendarRange aria-hidden />
            Timeline
          </Button>
          <Button
            size="sm"
            variant={layout === 'board' ? 'secondary' : 'ghost'}
            aria-pressed={layout === 'board'}
            onClick={() => {
              setLayout('board');
            }}
          >
            <Columns3 aria-hidden />
            Board
          </Button>
        </div>
      }
    >
      {(items, ctx) => {
        const rows = items.map((memory) => toRow(memory, today));
        return layout === 'timeline' ? <Timeline rows={rows} ctx={ctx} /> : <Board rows={rows} ctx={ctx} />;
      }}
    </TypedMemoryPage>
  );
}
