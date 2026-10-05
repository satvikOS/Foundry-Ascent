import { PanelRightClose } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';

interface InspectorPanelProps extends Omit<ComponentProps<'div'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Header actions (e.g. tabs or filters). */
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}

/** Drawer-like side panel frame: sticky header with title and close, scrolling body. */
export function InspectorPanel({
  title,
  description,
  actions,
  onClose,
  closeLabel = 'Close inspector',
  className,
  children,
  ...props
}: InspectorPanelProps) {
  const titleId = useId();
  return (
    <div
      data-slot="inspector-panel"
      role="region"
      aria-labelledby={titleId}
      className={cn('flex h-full min-h-0 flex-col bg-card', className)}
      {...props}
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-sm font-semibold tracking-tight">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {onClose ? (
            <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={closeLabel}>
              <PanelRightClose aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

interface InspectorSectionProps extends Omit<ComponentProps<'section'>, 'title'> {
  title: ReactNode;
  /** Count or status shown next to the title. */
  meta?: ReactNode;
  actions?: ReactNode;
}

/** A labelled block inside the inspector (Sources, Known facts, Assumptions, Proposed memory…). */
export function InspectorSection({
  title,
  meta,
  actions,
  className,
  children,
  ...props
}: InspectorSectionProps) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn('border-b border-border px-4 py-3.5 last:border-b-0', className)}
      {...props}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3
          id={id}
          className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {title}
          {meta ? <span className="tabular font-medium normal-case">{meta}</span> : null}
        </h3>
        {actions}
      </div>
      <div className="text-sm">{children}</div>
    </section>
  );
}
