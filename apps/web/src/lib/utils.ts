import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names, resolving Tailwind conflicts (last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Exhaustiveness guard for discriminated unions. */
export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}

/** Two-letter initials for avatars ("Ada Lovelace" → "AL", "foundry" → "FO"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
