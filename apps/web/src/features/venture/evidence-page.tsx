import type { DocumentView, EvidenceItem, MemoryObjectView } from '@foundry/contracts';
import { useQueries } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { BookOpen, Brain, FileText, Library, Search, SearchX, Sparkles, type LucideIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MetricTile } from '@/components/ui/metric-tile';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useDocuments } from '@/lib/api/hooks/documents';
import { useMemory } from '@/lib/api/hooks/memory';
import { sessionQueryOptions, useSessions } from '@/lib/api/hooks/sessions';
import { formatNumber, pluralize } from '@/lib/format';
import { MemoryTypeLabel } from '@/features/memory/memory-meta';

import { FreshnessBadge, freshnessLevel, type FreshnessLevel } from './freshness';
import { SegmentedControl } from './segmented-control';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/evidence');

type SourceKind = 'document' | 'memory' | 'program';
type SourceFilter = 'all' | SourceKind;
type FreshnessFilter = 'any' | FreshnessLevel;

/** How many recent sessions are scanned for cited program sources. */
const RECENT_SESSIONS = 5;

interface SourceRow {
  id: string;
  kind: SourceKind;
  title: string;
  excerpt: string;
  freshnessAt: string | null;
  citations: number;
  document?: DocumentView;
  memory?: MemoryObjectView;
  evidence?: EvidenceItem;
}

const PROGRAM_KIND: Partial<Record<EvidenceItem['kind'], { label: string; icon: LucideIcon }>> = {
  resource: { label: 'Program resource', icon: Library },
  doctrine: { label: 'Program guidance', icon: BookOpen },
  pattern: { label: 'Reviewed pattern', icon: Sparkles },
};

function SourceIcon({ row }: { row: SourceRow }) {
  const Icon =
    row.kind === 'document'
      ? FileText
      : row.kind === 'memory'
        ? Brain
        : (PROGRAM_KIND[row.evidence?.kind ?? 'resource']?.icon ?? Library);
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
      <Icon aria-hidden className="size-4 text-muted-foreground" />
    </span>
  );
}

export function EvidencePage() {
  const { tenant, ventureId } = routeApi.useParams();
  const documents = useDocuments(ventureId);
  const memory = useMemory(ventureId, { status: 'confirmed' });
  const sessions = useSessions(ventureId);
  const ids = { search: useId(), freshness: useId() };
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [freshness, setFreshness] = useState<FreshnessFilter>('any');

  const recent = useMemo(
    () =>
      [...(sessions.data ?? [])]
        .filter((s) => s.turnCount > 0)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, RECENT_SESSIONS),
    [sessions.data],
  );
  const details = useQueries({ queries: recent.map((s) => sessionQueryOptions(s.id)) });
  const detailsPending = sessions.isPending || details.some((d) => d.isPending);

  const { rows, citedCount } = useMemo(() => {
    // Count citations by underlying source across the recent sessions' answers.
    const citations = new Map<string, number>();
    const program = new Map<string, SourceRow>();
    for (const detail of details) {
      for (const turn of detail.data?.turns ?? []) {
        for (const item of turn.evidence) {
          citations.set(item.refId, (citations.get(item.refId) ?? 0) + 1);
          if (PROGRAM_KIND[item.kind]) {
            const existing = program.get(item.refId);
            program.set(item.refId, {
              id: `program-${item.refId}`,
              kind: 'program',
              title: item.title,
              excerpt: item.excerpt,
              freshnessAt: item.freshnessAt,
              citations: (existing?.citations ?? 0) + 1,
              evidence: item,
            });
          }
        }
      }
    }
    const all: SourceRow[] = [
      ...(documents.data ?? [])
        .filter((d) => d.status !== 'deleted')
        .map((d): SourceRow => ({
          id: `document-${d.id}`,
          kind: 'document',
          title: d.filename,
          excerpt:
            d.status === 'ready'
              ? pluralize(d.chunkCount, 'searchable passage')
              : d.status === 'failed'
                ? (d.failureReason ?? 'Processing failed — not searchable.')
                : 'Processing — not yet searchable.',
          freshnessAt: d.createdAt,
          citations: 0,
          document: d,
        })),
      ...(memory.data ?? []).map((m): SourceRow => ({
        id: `memory-${m.id}`,
        kind: 'memory',
        title: m.title,
        excerpt: m.content,
        freshnessAt: m.updatedAt,
        citations: citations.get(m.id) ?? 0,
        memory: m,
      })),
      ...program.values(),
    ];
    return { rows: all, citedCount: program.size };
  }, [details, documents.data, memory.data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((r) => source === 'all' || r.kind === source)
      .filter((r) => freshness === 'any' || freshnessLevel(r.freshnessAt) === freshness)
      .filter(
        (r) => !needle || r.title.toLowerCase().includes(needle) || r.excerpt.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          b.citations - a.citations || Date.parse(b.freshnessAt ?? '0') - Date.parse(a.freshnessAt ?? '0'),
      );
  }, [rows, source, freshness, query]);

  const staleCount = rows.filter((r) => freshnessLevel(r.freshnessAt) === 'stale').length;
  const readyDocs = (documents.data ?? []).filter((d) => d.status === 'ready').length;
  const loading = documents.isPending || memory.isPending;
  const error = documents.error ?? memory.error;

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Evidence"
        description="Everything Foundry Guide can cite for this venture: your documents, confirmed memory, and the program resources it has drawn on. Stale sources are flagged so you can refresh them."
      />

      <section aria-label="Evidence at a glance" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          label="Documents ready"
          value={formatNumber(readyDocs)}
          icon={FileText}
          loading={documents.isPending}
        />
        <MetricTile
          label="Confirmed memory"
          value={formatNumber(memory.data?.length ?? 0)}
          icon={Brain}
          loading={memory.isPending}
        />
        <MetricTile
          label="Program sources cited"
          value={formatNumber(citedCount)}
          icon={Library}
          loading={detailsPending}
          hint={`From the last ${RECENT_SESSIONS} sessions`}
        />
        <MetricTile
          label="Stale sources"
          value={formatNumber(staleCount)}
          icon={SearchX}
          loading={loading}
          hint="Not updated in 90+ days"
        />
      </section>

      <div role="search" aria-label="Filter evidence" className="mb-4 flex flex-wrap items-end gap-3">
        <div className="grid min-w-[14rem] flex-1 gap-1.5">
          <Label htmlFor={ids.search} className="text-xs text-muted-foreground">
            Search
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={ids.search}
              type="search"
              value={query}
              placeholder="Search titles and excerpts"
              className="pl-9"
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.freshness} className="text-xs text-muted-foreground">
            Freshness
          </Label>
          <Select
            value={freshness}
            onValueChange={(value) => {
              setFreshness(value as FreshnessFilter);
            }}
          >
            <SelectTrigger id={ids.freshness} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any freshness</SelectItem>
              <SelectItem value="fresh">Fresh (≤ 30 days)</SelectItem>
              <SelectItem value="aging">Aging (30–90 days)</SelectItem>
              <SelectItem value="stale">Stale (90+ days)</SelectItem>
              <SelectItem value="undated">Undated</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <SegmentedControl
          label="Source type"
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: 'All' },
            { value: 'document', label: 'Documents' },
            { value: 'memory', label: 'Memory' },
            { value: 'program', label: 'Program' },
          ]}
        />
      </div>

      <p className="mb-3 text-[13px] text-muted-foreground" role="status" aria-live="polite">
        {loading ? 'Loading sources…' : pluralize(filtered.length, 'source')}
      </p>

      {error && !documents.data && !memory.data ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void documents.refetch();
            void memory.refetch();
          }}
        />
      ) : loading ? (
        <div aria-busy="true" className="grid gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        rows.length === 0 ? (
          <EmptyState
            icon={Library}
            title="No evidence yet"
            description="Upload documents or approve memory from your sessions. Foundry Guide can only cite what is here."
            action={
              <Link
                to="/$tenant/app/ventures/$ventureId/documents"
                params={{ tenant, ventureId }}
                className="text-sm font-medium underline underline-offset-4"
              >
                Upload documents
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={SearchX}
            title="No sources match"
            description="Try another search, source type or freshness."
          />
        )
      ) : (
        <ul
          aria-label="Evidence sources"
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        >
          {filtered.map((row) => (
            <li key={row.id} className="flex gap-3 border-b border-border px-4 py-3 last:border-0">
              <SourceIcon row={row} />
              <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  {row.kind === 'memory' && row.memory ? (
                    <Link
                      to="/$tenant/app/ventures/$ventureId/memory"
                      params={{ tenant, ventureId }}
                      search={{ m: row.memory.id }}
                      className="min-w-0 truncate text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {row.title}
                    </Link>
                  ) : row.kind === 'document' ? (
                    <Link
                      to="/$tenant/app/ventures/$ventureId/documents"
                      params={{ tenant, ventureId }}
                      className="min-w-0 truncate text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {row.title}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate text-sm font-medium">{row.title}</span>
                  )}
                </div>
                <p className="line-clamp-2 text-[13px] text-muted-foreground">{row.excerpt}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {row.kind === 'document' && row.document ? (
                    <>
                      <span>Document</span>
                      <StatusBadge kind="document" status={row.document.status} />
                    </>
                  ) : null}
                  {row.kind === 'memory' && row.memory ? <MemoryTypeLabel type={row.memory.type} /> : null}
                  {row.kind === 'program' && row.evidence ? (
                    <span>{PROGRAM_KIND[row.evidence.kind]?.label ?? 'Program source'}</span>
                  ) : null}
                  <FreshnessBadge date={row.freshnessAt} />
                  {row.citations > 0 ? <span>Cited {row.citations}× in recent sessions</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
