import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { DisclosureBanner, disclosureSummary } from './disclosure-banner';

const PERSONA_DISCLOSURE =
  "You are talking with Corin's vEIR, an AI coach built from Corin Halvorsen's approved frameworks and coaching " +
  'style. It is not a person, and no human EIR, including Corin, wrote or approved these responses.';

describe('DisclosureBanner line', () => {
  it('always shows a complete summary: an AI, not a person, and no human wrote or approved it', () => {
    renderWithProviders(<DisclosureBanner text={PERSONA_DISCLOSURE} veirName="Corin's vEIR" />);
    const note = screen.getByRole('note', { name: 'AI disclosure' });
    const summary = note.querySelector('[data-slot="disclosure-summary"]');
    expect(summary).toHaveTextContent(
      "Corin's vEIR is an AI, not a person. No human wrote or approved its answers.",
    );
    // Nothing clips the visible line; it wraps instead.
    expect(summary?.parentElement).not.toHaveClass('truncate');
    expect(summary).not.toHaveClass('truncate');
    // Assistive technology always gets the persona's own disclosure in full.
    expect(note).toHaveTextContent(PERSONA_DISCLOSURE);
  });

  it('shows the persona’s full disclosure on More', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DisclosureBanner text={PERSONA_DISCLOSURE} veirName="Corin's vEIR" />);
    const note = screen.getByRole('note', { name: 'AI disclosure' });
    await user.click(within(note).getByRole('button', { name: 'More of the AI disclosure' }));
    expect(note.querySelector('[data-slot="disclosure-summary"]')).toBeNull();
    expect(within(note).getByText(PERSONA_DISCLOSURE)).toBeVisible();
    expect(within(note).getByRole('button', { name: 'Less of the AI disclosure' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('names no one when the vEIR is unknown', () => {
    expect(disclosureSummary(null)).toBe(
      'You are talking with an AI, not a person. No human wrote or approved its answers.',
    );
  });
});
