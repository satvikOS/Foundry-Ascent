import type { MemoryObjectView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { History } from 'lucide-react';

import { InspectorSection } from '@/components/ui/inspector-panel';
import { Markdown } from '@/components/ui/markdown';
import { StatusBadge } from '@/components/ui/status-badge';
import { displayContent, useFullMemory } from '@/lib/api/hooks/memory';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';

import { MemoryActionBar } from './memory-action-bar';
import { MemoryHistoryTimeline } from './memory-history';
import { MemoryTypeLabel, PinnedMark, ProvenanceLine, SourceRefList, VisibilityLabel } from './memory-meta';
import { attributeRows } from './typed/attributes';

export function MemoryAttributesList({ attributes }: { attributes: Record<string, unknown> }) {
  const rows = attributeRows(attributes);
  if (rows.length === 0) return null;
  return (
    <dl className="grid gap-2">
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 text-[13px]">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="[overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface MemoryDetailProps {
  memory: MemoryObjectView;
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  onRemoved?: () => void;
  /** A type-specific editor (decisions, experiments, milestones) instead of the generic one. */
  onEdit?: (() => void) | undefined;
}

/** Statuses worth naming on an item: the history ones. Memory in use (kept or older suggestions) is not. */
const SHOWN_STATUS: ReadonlySet<MemoryObjectView['status']> = new Set([
  'disputed',
  'superseded',
  'expired',
  'rejected',
  'deleted',
]);

/**
 * One thing the vEIR knows: what it is, where it came from ("Learned from the call on …"), Edit, Pin and
 * Forget, then its sources and version history. Rendered inside the page's inspector.
 */
export function MemoryDetail({
  memory: listed,
  tenant,
  ventureId,
  canEdit,
  onRemoved,
  onEdit,
}: MemoryDetailProps) {
  // Lists carry an excerpt of the content; the detail shows the full text (GET /memory/:id).
  const { memory: full } = useFullMemory(listed);
  const memory = full ?? listed;
  return (
    <div>
      <InspectorSection title="Memory" className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <MemoryTypeLabel type={memory.type} />
          {SHOWN_STATUS.has(memory.status) ? (
            <StatusBadge kind="memory" status={memory.status} withTitle />
          ) : null}
          {memory.pinned ? <PinnedMark /> : null}
        </div>
        <h3 className="mt-2.5 text-[15px] leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">
          {memory.title}
        </h3>
        <Markdown size="sm" className="mt-1.5">
          {displayContent(memory)}
        </Markdown>
        <p className="mt-2 text-xs text-muted-foreground">
          <ProvenanceLine memory={memory} tenant={tenant} ventureId={ventureId} />
        </p>
        {canEdit ? (
          <MemoryActionBar
            ventureId={ventureId}
            memory={memory}
            size="sm"
            className="mt-3"
            onRemoved={onRemoved}
            onEdit={onEdit}
          />
        ) : null}
      </InspectorSection>

      {Object.keys(memory.attributes).length > 0 ? (
        <InspectorSection title="Details">
          <MemoryAttributesList attributes={memory.attributes} />
        </InspectorSection>
      ) : null}

      <InspectorSection title="Sources">
        <SourceRefList refs={memory.sourceRefs} tenant={tenant} ventureId={ventureId} />
        <dl className="mt-3 grid gap-2 text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Visible to</dt>
            <dd>
              <VisibilityLabel visibility={memory.visibility} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Updated</dt>
            <dd className="text-right">
              <time dateTime={isoString(memory.updatedAt)} title={formatDateTime(memory.updatedAt)}>
                {formatRelative(memory.updatedAt)}
              </time>
              {memory.version > 1 ? <span className="tabular"> · v{memory.version}</span> : null}
            </dd>
          </div>
          {memory.expiresAt ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Expires</dt>
              <dd>{formatDateTime(memory.expiresAt)}</dd>
            </div>
          ) : null}
        </dl>
        {memory.supersedesId ? (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <History aria-hidden className="size-3.5" />
            Replaces an{' '}
            <Link
              to="/$tenant/app/v/$ventureId/knowledge"
              params={{ tenant, ventureId }}
              search={{ m: memory.supersedesId }}
              className="font-medium text-foreground underline decoration-border-strong underline-offset-[3px] hover:decoration-foreground"
            >
              earlier version
            </Link>
          </p>
        ) : null}
      </InspectorSection>

      <InspectorSection title="History">
        <MemoryHistoryTimeline memoryId={memory.id} />
      </InspectorSection>
    </div>
  );
}
