import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { veirExplanation, type VeirName as VeirNameView } from '@/lib/veir';

const BADGE =
  'inline-flex h-5 shrink-0 items-center rounded-full border border-border-strong px-2 font-mono text-[0.625rem] leading-none font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground';

/**
 * The persistent badge beside a vEIR's name ("vEIR" for an EIR's digital twin under their first name, "AI"
 * otherwise). Text, not colour, carries the meaning. As a button it opens one short paragraph on what the vEIR is
 * (the disclosure, said once and kept one tap away instead of under every composer).
 */
export function VeirNameBadge({
  veir,
  interactive = true,
  className,
}: {
  veir: VeirNameView;
  /** False where the badge sits inside another control (a list row, a link): the label alone. */
  interactive?: boolean;
  className?: string;
}) {
  if (!interactive) {
    return (
      <span data-slot="veir-badge" className={cn(BADGE, className)}>
        {veir.badge}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        data-slot="veir-badge"
        aria-label={`${veir.badge}: what is ${veir.name}?`}
        className={cn(
          BADGE,
          'cursor-pointer transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          className,
        )}
      >
        {veir.badge}
      </PopoverTrigger>
      <PopoverContent aria-label={`About ${veir.name}`} data-slot="veir-explanation">
        <p className="font-medium text-foreground">{veir.name}</p>
        <p className="mt-1.5 text-pretty text-muted-foreground">{veirExplanation(veir)}</p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A vEIR's name with its badge, like a call tile's name tag: "Corin" + "vEIR" (its EIR's first-person consent),
 * "Corin’s vEIR" + "AI" otherwise, a guide's name + "AI". Use it wherever the name is rendered; `veir.name` is the
 * same in text.
 */
export function VeirName({
  veir,
  interactive = true,
  className,
  nameClassName,
}: {
  veir: VeirNameView;
  interactive?: boolean;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span data-slot="veir-name" className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <span className={cn('min-w-0 truncate', nameClassName)}>{veir.shortName}</span>
      <VeirNameBadge veir={veir} interactive={interactive} />
    </span>
  );
}
