import { Activity } from 'lucide-react';

import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useInsights, type Insights } from '@/lib/api/hooks/admin';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/** `1840` → `1.8 s`, `640` → `0.6 s`; null → `—`. */
export function formatSeconds(ms: number | null): string {
  if (ms === null) return '—';
  return `${(ms / 1000).toFixed(1)} s`;
}

const CHANNEL = { text: 'Chat', voice: 'Calls' } as const;

function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 border-b border-border py-2.5', className)}>
      <dt className="text-small text-muted-foreground">{label}</dt>
      <dd className="tabular text-right text-sm font-medium text-foreground">
        {value}
        {hint ? <span className="ml-1.5 font-normal text-muted-foreground">· {hint}</span> : null}
      </dd>
    </div>
  );
}

function Overview({ insights }: { insights: Insights }) {
  const { distillation: d } = insights;
  const waiting = d.pending + d.running;
  // One column on phones (a hairline between every row), two from `sm` (no line under either column).
  const left = 'sm:last:border-b-0';
  const right = 'last:border-b-0';
  return (
    <div className="grid gap-x-8 px-5 py-2 sm:grid-cols-2">
      <dl>
        {insights.conversations.map((c) => (
          <Stat
            key={c.channel}
            className={left}
            label={c.channel === 'voice' ? 'Conversations with a call' : 'Chat conversations'}
            value={formatNumber(c.conversations)}
            hint={`${String(c.averageTurns)} turns each`}
          />
        ))}
        {insights.conversations.length === 0 ? (
          <Stat className={left} label="Conversations" value="0" />
        ) : null}
        <Stat
          className={left}
          label="Calls"
          value={formatNumber(insights.calls.calls)}
          hint={`${String(insights.calls.minutes)} min`}
        />
        <Stat
          className={left}
          label="Private conversations"
          value={formatNumber(insights.privateConversations)}
          hint="never remembered"
        />
      </dl>
      <dl>
        <Stat className={right} label="Remembered, up to date" value={formatNumber(d.upToDate)} />
        <Stat className={right} label="Waiting to be remembered" value={formatNumber(waiting)} />
        <Stat className={right} label="Nothing worth keeping" value={formatNumber(d.dropped)} />
        <Stat className={right} label="Could not be summarised" value={formatNumber(d.failed)} />
      </dl>
    </div>
  );
}

function MemoryTable({ insights }: { insights: Insights }) {
  if (insights.memory.length === 0) {
    return (
      <p className="px-5 py-4 text-small text-muted-foreground">No ventures have talked with a vEIR yet.</p>
    );
  }
  return (
    <Table containerClassName="rounded-none border-0">
      <TableCaption className="sr-only">What each venture’s vEIR remembers</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Venture</TableHead>
          <TableHead scope="col" className="text-right">
            Summaries
          </TableHead>
          <TableHead scope="col" className="text-right">
            To review
          </TableHead>
          <TableHead scope="col" className="text-right">
            Kept
          </TableHead>
          <TableHead scope="col" className="hidden text-right sm:table-cell">
            Set aside
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {insights.memory.map((v) => (
          <TableRow key={v.ventureId}>
            <TableHead scope="row" className="h-auto py-2.5 font-medium text-foreground">
              {v.ventureName}
            </TableHead>
            <TableCell className="tabular text-right">{formatNumber(v.digests)}</TableCell>
            <TableCell className="tabular text-right">{formatNumber(v.proposed)}</TableCell>
            <TableCell className="tabular text-right">{formatNumber(v.confirmed)}</TableCell>
            <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
              {formatNumber(v.other)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LatencyTable({ insights }: { insights: Insights }) {
  if (insights.latency.length === 0) {
    return <p className="px-5 py-4 text-small text-muted-foreground">No answers in the last 30 days.</p>;
  }
  return (
    <Table containerClassName="rounded-none border-0">
      <TableCaption className="sr-only">How long answers take, last 30 days</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Where</TableHead>
          <TableHead scope="col" className="text-right">
            Answers
          </TableHead>
          <TableHead scope="col" className="text-right">
            First words
          </TableHead>
          <TableHead scope="col" className="text-right">
            Typical answer
          </TableHead>
          <TableHead scope="col" className="hidden text-right sm:table-cell">
            Slowest 1 in 20
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {insights.latency.map((l) => (
          <TableRow key={l.channel}>
            <TableHead scope="row" className="h-auto py-2.5 font-medium text-foreground">
              {CHANNEL[l.channel]}
            </TableHead>
            <TableCell className="tabular text-right">{formatNumber(l.turns)}</TableCell>
            <TableCell className="tabular text-right">{formatSeconds(l.firstWordsP50Ms)}</TableCell>
            <TableCell className="tabular text-right">{formatSeconds(l.p50Ms)}</TableCell>
            <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
              {formatSeconds(l.p95Ms)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Admin → Usage: how conversations, calls and the vEIRs’ memory are doing (counts only, no content). */
export function InsightsSection() {
  const insights = useInsights();
  if (insights.isError) return null;
  return (
    <SectionCard
      title="Conversations and memory"
      description="Your organisation, last 30 days. Counts only: no conversation content."
      icon={Activity}
      flush
    >
      {insights.isPending ? (
        <div className="grid gap-2 px-5 py-4" aria-busy="true" aria-label="Loading conversations and memory">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : (
        <div className="divide-y divide-border">
          <Overview insights={insights.data} />
          <MemoryTable insights={insights.data} />
          <LatencyTable insights={insights.data} />
        </div>
      )}
    </SectionCard>
  );
}
