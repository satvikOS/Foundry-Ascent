import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SectionCardProps extends Omit<ComponentProps<'section'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned header actions (e.g. "View all"). */
  actions?: ReactNode;
  /** Footer row. */
  footer?: ReactNode;
  headingLevel?: 2 | 3;
}

/**
 * A titled, landmark-labelled section for dashboards and detail pages: a hairline rule, a quiet title and
 * the content on the page itself. No box, no shadow: whitespace and the rule do the grouping.
 */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  headingLevel = 2,
  className,
  children,
  ...props
}: SectionCardProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      data-slot="section-card"
      aria-labelledby={headingId}
      className={cn('flex min-w-0 flex-col gap-4 border-t border-border pt-5', className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading id={headingId} className="text-sm leading-5 font-semibold tracking-tight">
            {title}
          </Heading>
          {description ? <p className="mt-0.5 text-small text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {footer ? <div>{footer}</div> : null}
    </section>
  );
}
