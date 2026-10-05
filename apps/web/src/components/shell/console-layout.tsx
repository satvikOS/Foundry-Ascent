import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { SubNav } from './sub-nav';

interface ConsoleLayoutProps {
  title: string;
  description: string;
  icon: LucideIcon;
  /** <SubNavLink> elements for the console's areas. */
  nav: ReactNode;
  children: ReactNode;
}

/**
 * Frame for the EIR studio, Program and Admin consoles: a sticky band with the console name and its
 * area navigation. Child pages render their own <PageHeader> (the page's h1).
 */
export function ConsoleLayout({ title, description, icon: Icon, nav, children }: ConsoleLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="sticky top-(--header-height) z-10 border-b border-border bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75"
        data-print="hide"
      >
        <div className="flex items-center gap-2 px-4 pt-3 text-sm sm:px-6 lg:px-8">
          <span className="flex size-6 items-center justify-center rounded-md border border-border bg-card">
            <Icon aria-hidden className="size-3.5" />
          </span>
          <span className="font-semibold tracking-tight">{title}</span>
          <span className="hidden truncate text-muted-foreground sm:inline">· {description}</span>
        </div>
        <SubNav label={`${title} areas`} className="mt-1 px-2 sm:px-4 lg:px-6">
          {nav}
        </SubNav>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
