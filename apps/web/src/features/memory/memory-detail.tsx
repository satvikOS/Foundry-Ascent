import type { MemoryObjectView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { History } from 'lucide-react';

import { InspectorSection } from '@/components/ui/inspector-panel';
import { Markdown } from '@/components/ui/markdown';
import { StatusBadge, getStatusDefinition } from '@/components/ui/status-badge';
import { displayContent, useFullMemory } from '@/lib/api/hooks/memory';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';

import { MemoryActionBar } from './memory-action-bar';
import { MemoryHistoryTimeline } from './memory-history';
import {
  ConfidenceMeter,
  MemoryTypeLabel,
  OriginLabel,
  PinnedMark,
  SourceRefList,
  VisibilityLabel,
} from './memory-meta';
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
}

/**
 * Full detail for one memory object: content, typed attributes, provenance, confidence, visibility,
 * lifecycle actions and the version history. Rendered inside the page's inspector.
 */
export function MemoryDetail({ memory: listed, tenant, ventureId, canEdit, onRemoved }: MemoryDetailProps) {
  // Lists carry an excerpt of the content; the detail shows the full text (GET /memory/:id).
  const { memory: full } = useFullMemory(listed);
  const memory = full ?? listed;
  const statusDef = getStatusDefinition('memory', memory.status);
  return (
    <div>
      <InspectorSection title="Memory" className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <MemoryTypeLabel type={memory.type} />
          <StatusBadge kind="memory" status={memory.status} withTitle />
          {memory.pinned ? <PinnedMark /> : null}
        </div>
        <h3 className="mt-2.5 text-[15px] leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">
          {memory.title}
        </h3>
        <Markdown size="sm" className="mt-1.5">
          {displayContent(memory)}
        </Markdown>
        <p className="mt-2 text-xs text-muted-foreground">{statusDef.description}</p>
        {canEdit ? (
          <MemoryActionBar
            ventureId={ventureId}
            memory={memory}
            size="sm"
            className="mt-3"
            onRemoved={onRemoved}
          />
        ) : null}
      </InspectorSection>

      {Object.keys(memory.attributes).length > 0 ? (
        <InspectorSection title="Details">
          <MemoryAttributesList attributes={memory.attributes} />
        </InspectorSection>
      ) : null}

      <InspectorSection title="Provenance">
        <SourceRefList refs={memory.sourceRefs} tenant={tenant} ventureId={ventureId} />
        <dl className="mt-3 grid gap-2 text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Confidence</dt>
            <dd>
              <ConfidenceMeter value={memory.confidence} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Visible to</dt>
            <dd>
              <VisibilityLabel visibility={memory.visibility} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Origin</dt>
            <dd>
              <OriginLabel origin={memory.origin} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Created</dt>
            <dd className="text-right">
              {memory.createdBy.displayName} ·{' '}
              <time dateTime={isoString(memory.createdAt)} title={formatDateTime(memory.createdAt)}>
                {formatRelative(memory.createdAt)}
              </time>
            </dd>
          </div>
          {memory.approvedAt ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Approved</dt>
              <dd className="text-right">
                {memory.approvedBy ? `${memory.approvedBy.displayName} · ` : ''}
                <time dateTime={isoString(memory.approvedAt)} title={formatDateTime(memory.approvedAt)}>
                  {formatRelative(memory.approvedAt)}
                </time>
              </dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="tabular">v{memory.version}</dd>
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
              to="/$tenant/app/ventures/$ventureId/memory"
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
