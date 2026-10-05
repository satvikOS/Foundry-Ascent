import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface PageHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Small label above the title (e.g. section or venture name). */
  eyebrow?: ReactNode;
  /** Right-aligned actions. */
  actions?: ReactNode;
  /** Content under the title row (filters, tabs, meta). */
  children?: ReactNode;
}

/**
 * Page title block. Renders the page's single <h1>, which receives focus after client-side
 * navigation (see RouteAnnouncer), so every routed page should render exactly one PageHeader.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header data-slot="page-header" className={cn('flex flex-col gap-4 pb-6', className)} {...props}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          {eyebrow ? <div className="text-[13px] font-medium text-muted-foreground">{eyebrow}</div> : null}
          <h1
            data-page-title
            tabIndex={-1}
            className="text-2xl leading-tight font-semibold tracking-tight text-balance outline-none"
          >
            {title}
          </h1>
          {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Standard page container: max width, responsive padding. */
export function PageContainer({
  className,
  size = 'default',
  ...props
}: ComponentProps<'div'> & { size?: 'default' | 'wide' | 'narrow' | 'full' }) {
  return (
    <div
      data-slot="page-container"
      className={cn(
        'mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        size === 'default' && 'max-w-6xl',
        size === 'wide' && 'max-w-7xl',
        size === 'narrow' && 'max-w-3xl',
        className,
      )}
      {...props}
    />
  );
}
