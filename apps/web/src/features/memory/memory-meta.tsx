import type { MemoryObjectView, MemoryType, SourceRef, Visibility } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  Brain,
  FileText,
  Globe,
  Lock,
  MessagesSquare,
  PenLine,
  Pin,
  ScanText,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { MEMORY_TYPE_LABELS, VISIBILITY_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { memoryProvenance } from './provenance';

/** Memory type as icon + label (neutral chip; type is not a status). */
export function MemoryTypeLabel({
  type,
  className,
  iconOnly = false,
}: {
  type: MemoryType;
  className?: string;
  iconOnly?: boolean;
}) {
  const def = MEMORY_TYPE_LABELS[type];
  const Icon = def.icon;
  if (iconOnly) {
    return (
      <span className={cn('inline-flex shrink-0 text-muted-foreground', className)} title={def.label}>
        <Icon aria-hidden className="size-4" />
        <span className="sr-only">{def.label}</span>
      </span>
    );
  }
  return (
    <span
      data-slot="memory-type"
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {def.label}
    </span>
  );
}

const VISIBILITY_ICONS: Record<Visibility, LucideIcon> = {
  founder_private: Lock,
  team: Users,
  venture: Globe,
  advisors: UserRound,
};

export function VisibilityLabel({ visibility, className }: { visibility: Visibility; className?: string }) {
  const Icon = VISIBILITY_ICONS[visibility];
  const def = VISIBILITY_LABELS[visibility];
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}
      title={def.description}
    >
      <Icon aria-hidden className="size-3.5" />
      {def.label}
    </span>
  );
}

export function PinnedMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium text-foreground', className)}>
      <Pin aria-hidden className="size-3.5" />
      Pinned
    </span>
  );
}

const SOURCE_KIND: Record<SourceRef['kind'], { icon: LucideIcon; label: string }> = {
  session: { icon: MessagesSquare, label: 'Conversation' },
  turn: { icon: MessagesSquare, label: 'An answer in a conversation' },
  document: { icon: FileText, label: 'Document' },
  chunk: { icon: ScanText, label: 'Document excerpt' },
  manual: { icon: PenLine, label: 'Added manually' },
  memory: { icon: Brain, label: 'Earlier memory' },
};

/** Labels the server writes for its own bookkeeping, not for people: the kind's own label is shown instead. */
const MACHINE_LABELS: ReadonlySet<string> = new Set(['ai proposal', 'call', 'chat']);

const linkClasses =
  'font-medium text-foreground underline decoration-border-strong underline-offset-[3px] hover:decoration-foreground';

/** Provenance: where a memory object came from, linking to the source when it lives in the workspace. */
export function SourceRefList({
  refs,
  tenant,
  ventureId,
  className,
}: {
  refs: readonly SourceRef[];
  tenant: string;
  ventureId: string;
  className?: string;
}) {
  if (refs.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No source recorded.</p>;
  }
  return (
    <ul className={cn('grid gap-1.5', className)}>
      {refs.map((ref, index) => {
        const def = SOURCE_KIND[ref.kind];
        const Icon = def.icon;
        const label = ref.label?.trim();
        const text = label && !MACHINE_LABELS.has(label.toLowerCase()) ? label : def.label;
        let body = <span>{text}</span>;
        if (ref.kind === 'session') {
          body = (
            <Link
              to="/$tenant/app/v/$ventureId/c/$sessionId"
              params={{ tenant, ventureId, sessionId: ref.id }}
              className={linkClasses}
            >
              {text}
            </Link>
          );
        } else if (ref.kind === 'document' || ref.kind === 'chunk') {
          body = (
            <Link
              to="/$tenant/app/v/$ventureId/documents"
              params={{ tenant, ventureId }}
              className={linkClasses}
            >
              {text}
            </Link>
          );
        } else if (ref.kind === 'memory') {
          body = (
            <Link
              to="/$tenant/app/v/$ventureId/knowledge"
              params={{ tenant, ventureId }}
              search={{ m: ref.id }}
              className={linkClasses}
            >
              {text}
            </Link>
          );
        }
        return (
          <li key={`${ref.kind}-${ref.id}-${index}`} className="flex items-start gap-2 text-[13px]">
            <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="sr-only">{def.label}: </span>
              {body}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Where an item came from, in one line ("Learned from the conversation on Oct 16, 2026"), linking to that
 * conversation when its source names one (`link` off inside a row that is itself a button).
 */
export function ProvenanceLine({
  memory,
  tenant,
  ventureId,
  link = true,
  className,
}: {
  memory: Pick<MemoryObjectView, 'origin' | 'createdAt' | 'createdBy' | 'sourceRefs'>;
  tenant: string;
  ventureId: string;
  link?: boolean;
  className?: string;
}) {
  const { text, sessionId } = memoryProvenance(memory);
  if (link && sessionId) {
    return (
      <Link
        to="/$tenant/app/v/$ventureId/c/$sessionId"
        params={{ tenant, ventureId, sessionId }}
        className={cn(linkClasses, 'font-normal', className)}
      >
        {text}
      </Link>
    );
  }
  return <span className={className}>{text}</span>;
}
