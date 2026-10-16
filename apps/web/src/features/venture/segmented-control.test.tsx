import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SegmentedControl } from './segmented-control';

function Filter() {
  const [value, setValue] = useState<'open' | 'closed'>('open');
  return (
    <SegmentedControl
      label="Show requests"
      value={value}
      onChange={setValue}
      options={[
        { value: 'open', label: 'Open', count: 2 },
        { value: 'closed', label: 'Closed' },
      ]}
    />
  );
}

describe('SegmentedControl', () => {
  it('shows the pressed option as an inverted chip, never as a fill that matches hover', async () => {
    render(<Filter />);
    const open = screen.getByRole('button', { name: 'Open 2' });
    const closed = screen.getByRole('button', { name: 'Closed' });
    expect(open).toHaveAttribute('aria-pressed', 'true');
    expect(open).toHaveClass('bg-foreground', 'text-background');
    expect(closed).toHaveAttribute('aria-pressed', 'false');
    expect(closed).not.toHaveClass('bg-foreground');
    expect(closed).toHaveClass('hover:bg-accent/50');

    await userEvent.click(closed);
    expect(closed).toHaveAttribute('aria-pressed', 'true');
    expect(closed).toHaveClass('bg-foreground');
    expect(open).not.toHaveClass('bg-foreground');
  });
});
