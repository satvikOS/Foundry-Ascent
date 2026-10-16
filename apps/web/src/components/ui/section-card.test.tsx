import { render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { MetricTile } from './metric-tile';
import { SectionCard } from './section-card';

/*
 * The minimal section and tile dropped their icon (and the section its padded body), but callers written
 * against the boxed versions (other streams' branches pass `icon` and `flush`) must keep compiling and
 * must not leak those props onto the DOM. This file type-checks those calls (`pnpm typecheck`) and
 * renders them.
 */

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('SectionCard', () => {
  it('accepts the old icon and flush props, ignores them and keeps them off the DOM', () => {
    render(
      <SectionCard title="Conversations and memory" description="Last 30 days" icon={Activity} flush>
        <p>Body</p>
      </SectionCard>,
    );
    const section = screen.getByRole('region', { name: 'Conversations and memory' });
    expect(section).not.toHaveAttribute('icon');
    expect(section).not.toHaveAttribute('flush');
    // No icon beside the title: the header is the title and its description only.
    expect(section.querySelector('svg')).toBeNull();
    // React warns (console.error) when an unknown prop reaches a DOM element.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('is a hairline section, not a box', () => {
    render(
      <SectionCard title="By model">
        <p>Body</p>
      </SectionCard>,
    );
    const section = screen.getByRole('region', { name: 'By model' });
    expect(section).toHaveClass('border-t');
    expect(section).not.toHaveClass('rounded-xl');
    expect(section).not.toHaveClass('shadow-sm');
  });
});

describe('MetricTile', () => {
  it('accepts the old icon prop and draws no icon', () => {
    const { container } = render(<MetricTile label="Coaching turns" value="12" icon={Activity} />);
    expect(screen.getByText('Coaching turns')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
