import { CircleAlert } from 'lucide-react';
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Label } from './label';

interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-required'?: boolean | 'true' | 'false';
}

interface FieldProps {
  label: ReactNode;
  /** A single form control; Field wires id, aria-describedby, aria-invalid and aria-required. */
  children: ReactElement<FieldControlProps>;
  description?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  /** Visually hide the label (it stays available to assistive technology). */
  hideLabel?: boolean;
  className?: string;
  id?: string;
}

/**
 * Accessible form field: label, optional description and an error message that is announced and
 * referenced from the control. Works with react-hook-form (`{...register('name')}` on the child).
 */
export function Field({
  label,
  children,
  description,
  error,
  required,
  hideLabel,
  className,
  id,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? children.props.id ?? `field-${generated}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy =
    [children.props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : children.props['aria-invalid'],
        'aria-required': required ? true : children.props['aria-required'],
      })
    : children;

  return (
    <div data-slot="field" className={cn('grid gap-2', className)}>
      <Label htmlFor={controlId} className={cn(hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span aria-hidden className="text-muted-foreground">
            *
          </span>
        ) : null}
      </Label>
      {control}
      {description ? (
        <p id={descriptionId} className="text-[13px] leading-snug text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-[13px] leading-snug text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
