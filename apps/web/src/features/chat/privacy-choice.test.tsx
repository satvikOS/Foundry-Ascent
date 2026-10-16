import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { PrivacyChoice, type ConversationPrivacy } from './privacy-choice';

function Choice() {
  const [value, setValue] = useState<ConversationPrivacy>('standard');
  return <PrivacyChoice value={value} onChange={setValue} veirName="Corin's vEIR" />;
}

/** The visible pill around a radio: what a sighted person reads the choice from. */
function pill(name: string): HTMLElement {
  const label = screen.getByRole('radio', { name }).closest('label');
  if (!label) throw new Error(`no pill for ${name}`);
  return label;
}

describe('PrivacyChoice', () => {
  it('shows the chosen option as a solid pill and the other as plain text, in step with the radios', async () => {
    render(<Choice />);
    const group = screen.getByRole('group', { name: 'Memory for this conversation' });
    expect(within(group).getByRole('radio', { name: 'Remember this conversation' })).toBeChecked();
    // A solid fill in the text colour (inverse text), not a faint tint: at least 3:1 against the page.
    expect(pill('Remember this conversation')).toHaveAttribute('data-state', 'checked');
    expect(pill('Remember this conversation')).toHaveClass('bg-foreground', 'text-background');
    expect(pill('Private, a one-off')).toHaveAttribute('data-state', 'unchecked');
    expect(pill('Private, a one-off')).not.toHaveClass('bg-foreground');
    expect(pill('Private, a one-off')).not.toHaveClass('bg-accent');

    await userEvent.click(screen.getByRole('radio', { name: 'Private, a one-off' }));
    expect(pill('Private, a one-off')).toHaveClass('bg-foreground', 'text-background');
    expect(pill('Remember this conversation')).not.toHaveClass('bg-foreground');
    expect(group).toHaveAccessibleDescription(
      'A one-off: nothing is remembered, and it’s erased when it ends.',
    );
  });
});
