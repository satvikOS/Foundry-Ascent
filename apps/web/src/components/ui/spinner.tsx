import { LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

interface SpinnerProps extends ComponentProps<'svg'> {
  /** Accessible label; omit when the surrounding control already announces a busy state. */
  label?: string;
}

export function Spinner({ className, label, ...props }: SpinnerProps) {
  return (
    <LoaderCircle
      data-slot="spinner"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('size-4 animate-spin motion-reduce:animate-[spin_1.5s_linear_infinite]', className)}
      {...props}
    />
  );
}
