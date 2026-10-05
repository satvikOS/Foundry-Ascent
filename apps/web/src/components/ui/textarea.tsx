import { useCallback, useLayoutEffect, useRef, type ComponentProps, type Ref } from 'react';

import { cn } from '@/lib/utils';

import { inputClasses } from './input';

interface TextareaProps extends ComponentProps<'textarea'> {
  /** Grow with content (default true). */
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * Multi-line input that grows with its content between `minRows` and `maxRows`, then scrolls.
 * Sizing is done through the CSSOM (not inline style attributes), so it is CSP-safe.
 */
export function Textarea({
  className,
  autosize = true,
  minRows = 3,
  maxRows = 12,
  ref,
  onInput,
  value,
  ...props
}: TextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = innerRef.current;
    if (!el || !autosize) return;
    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const border = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const min = minRows * lineHeight + padding + border;
    const max = maxRows * lineHeight + padding + border;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight + border, min), max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight + border > max ? 'auto' : 'hidden';
  }, [autosize, minRows, maxRows]);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  return (
    <textarea
      data-slot="textarea"
      ref={(node) => {
        innerRef.current = node;
        assignRef(ref, node);
      }}
      rows={minRows}
      value={value}
      onInput={(event) => {
        resize();
        onInput?.(event);
      }}
      className={cn(
        inputClasses,
        'h-auto min-h-16 resize-none py-2 leading-5',
        !autosize && 'resize-y',
        className,
      )}
      {...props}
    />
  );
}
