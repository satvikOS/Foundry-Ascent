import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type scale's named sizes (globals.css `--text-*`). tailwind-merge must know they are font sizes:
 * otherwise `text-small` reads as a colour and is dropped when merged with `text-muted-foreground`.
 */
export const TYPE_SCALE = [
  'display',
  'title',
  'heading',
  'subheading',
  'body',
  'small',
  'caption',
  'label',
] as const;

const twMerge = extendTailwindMerge({
  extend: { theme: { text: [...TYPE_SCALE] } },
});

/** Merge class names, resolving Tailwind conflicts (last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
