import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FilterChips } from './filter-chips';

describe('FilterChips', () => {
  it('is a group of toggle buttons with counts, never tabs without panels', async () => {
    const onSelect = vi.fn();
    render(
      <FilterChips
        label="Filter escalations"
        chips={[
          { key: 'open', label: 'Open', count: 2 },
          { key: 'closed', label: 'Closed', count: undefined },
        ]}
        selected="open"
        onSelect={onSelect}
      />,
    );
    const group = screen.getByRole('group', { name: 'Filter escalations' });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('button', { name: /^Open\s*2$/ })).toHaveAttribute('aria-pressed', 'true');
    // A count that isn't known yet is left out rather than shown blank.
    const closed = screen.getByRole('button', { name: 'Closed' });
    expect(closed).toHaveAttribute('aria-pressed', 'false');
    expect(group).toContainElement(closed);
    await userEvent.click(closed);
    expect(onSelect).toHaveBeenCalledWith('closed');
  });
});
