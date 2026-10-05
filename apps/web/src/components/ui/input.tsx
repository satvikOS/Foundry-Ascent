import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export const inputClasses = cn(
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-xs',
  'transition-[border-color,box-shadow] duration-150 outline-none',
  'placeholder:text-subtle-foreground',
  'hover:border-foreground/45',
  'focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/40',
  'file:me-3 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
);

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" type={type} className={cn(inputClasses, className)} {...props} />;
}
