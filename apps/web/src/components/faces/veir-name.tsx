import { cn } from '@/lib/utils';
import type { VeirName as VeirNameView } from '@/lib/veir';

/**
 * A mentor's name as the app shows it: the persona's display name alone ("Thomas"), with no "vEIR" badge or
 * suffix (lib/veir's naming rule). What the mentor is lives in the About dialog (the right panel), the first-visit
 * welcome and the call's disclosure, never in chrome repeated beside every mention.
 */
export function VeirName({
  veir,
  className,
  nameClassName,
}: {
  veir: VeirNameView;
  /** Accepted for older callers; the name is never a control. */
  interactive?: boolean;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span data-slot="veir-name" className={cn('inline-flex min-w-0 items-center', className)}>
      <span className={cn('min-w-0 truncate', nameClassName)}>{veir.name}</span>
    </span>
  );
}
