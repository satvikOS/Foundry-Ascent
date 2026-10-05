import type { MemoryObjectView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Plus, type LucideIcon } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Label } from '@/components/ui/label';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { useMemory } from '@/lib/api/hooks/memory';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useVentureParams } from '@/features/venture/params';

import { MemoryActionBar } from '../memory-action-bar';
import { ConfidenceMeter, PinnedMark } from '../memory-meta';
import { TypedMemoryDialog, type TypedKind } from './typed-memory-dialog';

const HISTORY_STATUSES = new Set<MemoryObjectView['status']>([
  'superseded',
  'rejected',
  'expired',
  'deleted',
]);

export interface TypedPageContext {
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  edit: (memory: MemoryObjectView) => void;
}

interface TypedMemoryPageProps {
  kind: TypedKind;
  title: string;
  description: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  /** Optional header controls (e.g. a layout switch). */
  controls?: ReactNode;
  children: (items: MemoryObjectView[], ctx: TypedPageContext) => ReactNode;
}

/**
 * Frame for the typed memory views (decisions, experiments, milestones): data, header with "New …",
 * history toggle, the typed create/edit dialog and every async state.
 */
export function TypedMemoryPage({
  kind,
  title,
  description,
  icon,
  emptyTitle,
  emptyDescription,
  controls,
  children,
}: TypedMemoryPageProps) {
  const me = useRequiredMe();
  const { tenant, ventureId } = useVentureParams();
  const canEdit = canWrite(me, ventureId);
  const memory = useMemory(ventureId, { type: kind });
  const [showHistory, setShowHistory] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; memory: MemoryObjectView | null }>({
    open: false,
    memory: null,
  });
  const historyId = useId();

  const items = useMemo(
    () => (memory.data ?? []).filter((m) => showHistory || !HISTORY_STATUSES.has(m.status)),
    [memory.data, showHistory],
  );
  const hiddenCount = (memory.data?.length ?? 0) - items.length;
  const ctx: TypedPageContext = {
    tenant,
    ventureId,
    canEdit,
    edit: (m) => {
      setDialog({ open: true, memory: m });
    },
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title={title}
        description={description}
        actions={
          canEdit ? (
            <Button
              onClick={() => {
                setDialog({ open: true, memory: null });
              }}
            >
              <Plus aria-hidden />
              New {kind}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          {controls}
          <div className="flex items-center gap-2">
            <Switch id={historyId} checked={showHistory} onCheckedChange={setShowHistory} />
            <Label htmlFor={historyId} className="font-normal">
              Show history{hiddenCount > 0 && !showHistory ? ` (${hiddenCount})` : ''}
            </Label>
          </div>
          {memory.data ? (
            <p className="text-[13px] text-muted-foreground" role="status" aria-live="polite">
              {pluralize(items.length, kind)}
            </p>
          ) : null}
        </div>
      </PageHeader>

      {memory.isError ? (
        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
      ) : memory.isPending ? (
        <div aria-busy="true" className="grid gap-3 md:grid-cols-2">
          <span className="sr-only" role="status">
            Loading…
          </span>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={icon}
          title={emptyTitle}
          description={emptyDescription}
          action={
            canEdit ? (
              <Button
                size="sm"
                onClick={() => {
                  setDialog({ open: true, memory: null });
                }}
              >
                <Plus aria-hidden />
                New {kind}
              </Button>
            ) : null
          }
        />
      ) : (
        children(items, ctx)
      )}

      <TypedMemoryDialog
        ventureId={ventureId}
        kind={kind}
        open={dialog.open}
        memory={dialog.memory}
        onOpenChange={(open) => {
          setDialog((prev) => ({ ...prev, open }));
        }}
      />
    </PageContainer>
  );
}

/** Card chrome shared by the typed views: header row, body, and the lifecycle actions. */
export function TypedCard({
  memory,
  ctx,
  meta,
  children,
  className,
  headingLevel = 3,
}: {
  memory: MemoryObjectView;
  ctx: TypedPageContext;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  const headingId = `typed-${memory.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm',
        memory.status === 'proposed' ? 'border-dashed border-warning/50' : 'border-border',
        HISTORY_STATUSES.has(memory.status) && 'opacity-75',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {memory.status !== 'confirmed' ? (
          <StatusBadge kind="memory" status={memory.status} withTitle />
        ) : null}
        {meta}
        {memory.pinned ? <PinnedMark /> : null}
        <span className="ml-auto">
          <ConfidenceMeter value={memory.confidence} />
        </span>
      </div>
      <Heading
        id={headingId}
        className="text-[15px] leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]"
      >
        {memory.title}
      </Heading>
      {children}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <Link
          to="/$tenant/app/ventures/$ventureId/memory"
          params={{ tenant: ctx.tenant, ventureId: ctx.ventureId }}
          search={{ m: memory.id }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ExternalLink aria-hidden className="size-3" />
          Provenance & history
          <span className="sr-only"> for {memory.title}</span>
        </Link>
        {ctx.canEdit ? (
          <MemoryActionBar
            ventureId={ctx.ventureId}
            memory={memory}
            size="sm"
            onEdit={() => {
              ctx.edit(memory);
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

/** Label + value row used inside typed cards. */
export function TypedField({
  label,
  children,
  icon: Icon,
}: {
  label: string;
  children: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
        {label}
      </dt>
      <dd className="text-sm leading-6 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
