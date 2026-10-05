import { cn } from '@/lib/utils';

/** The geometric "ascent" mark: three rising steps. Decorative unless a label is given. */
export function BrandMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-6 shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <path d="M7 24h5v-4H7z" className="fill-background opacity-55" />
      <path d="M13.5 24h5v-8h-5z" className="fill-background opacity-75" />
      <path d="M20 24h5V8l-5 5z" className="fill-background" />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <BrandMark />
      <span>Foundry Ascent</span>
    </span>
  );
}
