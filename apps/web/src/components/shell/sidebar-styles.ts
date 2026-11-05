import { cn } from '@/lib/utils';

/**
 * One dense row of the side panel (design spec §8): 32 px (44 px for touch), 13 px labels, 16 px icons in the
 * muted tone. Hover fills with `--sidebar-hover`; the current page fills with `--sidebar-accent` and carries a
 * 2 px `--selected-cue` bar at its inside start, so selection never rests on colour alone.
 */
export const sidebarRowClasses = cn(
  'group relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground pointer-coarse:h-11',
  'transition-colors duration-(--dur-hover) hover:bg-sidebar-hover',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
  'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-selected-cue before:opacity-0',
  'data-[status=active]:bg-sidebar-accent data-[status=active]:before:opacity-100',
);

/** Quiet group label in the panel: 11 px mono, uppercase. */
export const sidebarGroupLabelClasses = 'px-2.5 pt-4 pb-1.5 text-caption font-medium text-sidebar-muted';
