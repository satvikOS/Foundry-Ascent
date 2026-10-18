import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { InfoTip } from './info-tip';
import { PageHeader } from './page-header';

describe('InfoTip', () => {
  it('keeps rarely needed detail off the page, behind a named button that describes it', async () => {
    render(<InfoTip label="Knowledge">What Corin’s vEIR knows, and where it came from.</InfoTip>);
    const button = screen.getByRole('button', { name: 'About Knowledge' });
    // A screen reader hears the detail without opening it; nothing is on screen until it opens.
    expect(button).toHaveAccessibleDescription('What Corin’s vEIR knows, and where it came from.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    const user = userEvent.setup();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('dialog')).toHaveTextContent('What Corin’s vEIR knows');

    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });
});

describe('PageHeader', () => {
  it('puts `info` behind a button beside the title, not in the heading or a description line', () => {
    render(<PageHeader title="Documents" info="Files Corin’s vEIR can cite. Private to this venture." />);
    // The heading's name stays the title alone.
    expect(screen.getByRole('heading', { level: 1, name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Documents' })).toHaveAccessibleDescription(
      'Files Corin’s vEIR can cite. Private to this venture.',
    );
    expect(screen.getByText('Files Corin’s vEIR can cite. Private to this venture.')).not.toBeVisible();
  });

  it('shows a description line, and no info button, when given a description', () => {
    render(<PageHeader title="Human help" description="Nothing is shared without your consent." />);
    expect(screen.getByText('Nothing is shared without your consent.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull();
  });
});
