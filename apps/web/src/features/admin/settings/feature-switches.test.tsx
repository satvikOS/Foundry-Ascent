import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../shared/test-utils';
import { FeatureSwitches, facePrice, faceSummary } from './feature-switches';

const BASE = {
  callsEnabled: true,
  streamingEnabled: true,
  facesEnabled: false,
  clonedVoiceEnabled: false,
};

describe('FeatureSwitches: the video face’s mode and price', () => {
  it('says what the wired face is, who sees it and what it costs a minute', () => {
    const full = {
      mode: 'full' as const,
      usdPerMinute: 0.19,
      audience: 'admins' as const,
      stock: true,
      sandbox: false,
    };
    expect(faceSummary(full)).toBe('Stock AI avatar · admins + chosen people · $0.19/min');
    expect(
      faceSummary({ ...full, mode: 'lite', usdPerMinute: 0.093, audience: 'everyone', stock: false }),
    ).toBe('EIR’s face · everyone · $0.09/min');
    expect(facePrice({ usdPerMinute: 0.19, sandbox: true })).toBe('free sandbox');
  });

  it('shows the FULL face on the switch and in the confirmation before it is turned on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <FeatureSwitches
        {...BASE}
        faceVendor={{ mode: 'full', usdPerMinute: 0.19, audience: 'admins', stock: true, sandbox: false }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Off · Stock AI avatar · admins + chosen people · $0.19/min')).toBeVisible();
    await user.click(screen.getByRole('switch', { name: 'Video faces' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Turn on video faces?' });
    expect(within(dialog).getByText('Stock AI avatar · admins + chosen people · $0.19/min')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Turn on faces' }));
    expect(onChange).toHaveBeenCalledWith({ facesEnabled: true });
  });

  it('keeps the plain wording when no face is wired', () => {
    renderWithProviders(<FeatureSwitches {...BASE} onChange={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Video faces' })).toBeInTheDocument();
    expect(screen.queryByText(/Stock AI avatar/)).toBeNull();
  });
});
