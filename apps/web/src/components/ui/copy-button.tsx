import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';

interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  value: string;
  /** Accessible label, e.g. "Copy request ID". */
  label?: string;
  /** Show the label next to the icon. */
  showLabel?: boolean;
  onCopied?: () => void;
}

async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Copies a value and confirms with an icon change plus a polite live-region message. */
export function CopyButton({
  value,
  label = 'Copy',
  showLabel = false,
  onCopied,
  variant = 'ghost',
  size,
  className,
  ...props
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const Icon = state === 'copied' ? Check : Copy;
  const status =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select and copy manually' : '';

  return (
    <>
      <Button
        variant={variant}
        size={size ?? (showLabel ? 'sm' : 'icon-sm')}
        aria-label={showLabel ? undefined : label}
        className={cn(className)}
        onClick={() => {
          void writeClipboard(value).then((ok) => {
            setState(ok ? 'copied' : 'failed');
            if (ok) onCopied?.();
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setState('idle');
            }, 2000);
          });
        }}
        {...props}
      >
        <Icon aria-hidden className={cn(state === 'copied' && 'text-success')} />
        {showLabel ? <span>{state === 'copied' ? 'Copied' : label}</span> : null}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {status}
      </span>
    </>
  );
}
