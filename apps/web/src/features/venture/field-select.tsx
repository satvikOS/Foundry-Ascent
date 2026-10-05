import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface FieldSelectOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
}

interface FieldSelectProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly FieldSelectOption<T>[];
  className?: string;
  disabled?: boolean;
  /** Wired by <Field>: forwarded to the trigger so the label and messages are associated with it. */
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-required'?: boolean | 'true' | 'false';
}

/**
 * A Select that works as the single child of <Field>: the id and ARIA wiring that Field injects land
 * on the focusable trigger (a bare Radix Select root would drop them, leaving the control unnamed).
 */
export function FieldSelect<T extends string>({
  value,
  onValueChange,
  options,
  className,
  disabled,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-required': required,
}: FieldSelectProps<T>) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next);
        if (match) onValueChange(match.value);
      }}
    >
      <SelectTrigger
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={required}
        className={cn('w-full', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <SelectItem key={option.value} value={option.value}>
              {Icon ? <Icon aria-hidden className="size-4 text-muted-foreground" /> : null}
              {option.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
