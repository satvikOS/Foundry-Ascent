import { describe, expect, it } from 'vitest';

import { cn } from './utils';

describe('cn', () => {
  it('keeps a type-scale size next to a text colour', () => {
    expect(cn('text-small text-muted-foreground')).toBe('text-small text-muted-foreground');
    expect(cn('text-caption', 'text-sidebar-muted')).toBe('text-caption text-sidebar-muted');
  });

  it('lets a later size replace an earlier one', () => {
    expect(cn('text-small', 'text-caption')).toBe('text-caption');
    expect(cn('text-sm', 'text-body')).toBe('text-body');
  });
});
