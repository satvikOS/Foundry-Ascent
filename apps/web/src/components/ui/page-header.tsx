import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { InfoTip } from './info-tip';

interface PageHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /**
   * Detail most people never need, behind an info button beside the title (instead of a description line).
   * Plain text: it is also the button's description for screen readers.
   */
  info?: string;
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
  info,
  eyebrow,
  actions,
  children,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header data-slot="page-header" className={cn('flex flex-col gap-5 pb-8', className)} {...props}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          {eyebrow ? <div className="text-small font-medium text-muted-foreground">{eyebrow}</div> : null}
          <div className="flex items-center gap-1.5">
            <h1
              data-page-title
              tabIndex={-1}
              className="font-serif text-heading font-normal text-balance outline-none"
            >
              {title}
            </h1>
            {info ? <InfoTip label={typeof title === 'string' ? title : 'this page'}>{info}</InfoTip> : null}
          </div>
          {description ? (
            <p className="max-w-[68ch] text-small text-pretty text-muted-foreground">{description}</p>
          ) : null}
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
        'mx-auto w-full px-4 py-8 sm:px-6 lg:px-10 lg:py-12',
        size === 'default' && 'max-w-6xl',
        size === 'wide' && 'max-w-7xl',
        size === 'narrow' && 'max-w-3xl',
        className,
      )}
      {...props}
    />
  );
}
