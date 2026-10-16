import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface SelectFieldOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
}

interface SelectFieldProps<V extends string> {
  label: ReactNode;
  value: V;
  onChange: (value: V) => void;
  onBlur?: () => void;
  options: readonly SelectFieldOption<V>[];
  description?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Width or other classes for the trigger (it fills the field by default). */
  triggerClassName?: string;
}

/**
 * The one labelled select of every form: a Radix select whose trigger is the Field's control, so the
 * <label>, description and error are wired to the element that receives focus.
 */
export function SelectField<V extends string>({
  label,
  value,
  onChange,
  onBlur,
  options,
  description,
  error,
  required,
  disabled,
  placeholder,
  className,
  triggerClassName,
}: SelectFieldProps<V>) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next);
        if (match) onChange(match.value);
      }}
      disabled={disabled}
    >
      <Field label={label} description={description} error={error} required={required} className={className}>
        <SelectTrigger className={cn('w-full', triggerClassName)} onBlur={onBlur}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </Field>
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
