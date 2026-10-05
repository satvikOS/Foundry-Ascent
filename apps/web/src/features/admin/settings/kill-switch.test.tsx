import type { PlatformSettingsView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '../shared/test-utils';
import { AiKillSwitch } from './kill-switch';
import { limitsPatch, toLimitsFormValues } from './limits-form';
import { SettingsPage } from './settings-page';

const SETTINGS: PlatformSettingsView = {
  aiEnabled: true,
  dailyUsdCapGlobal: 5,
  dailyUsdCapPerPrincipal: 1,
  maxTurnsPerSession: 40,
  groundingCoverageThreshold: 0.6,
  portfolioMinGroupSize: 3,
  dailyUploadDocumentsPerPrincipal: 20,
  dailyUploadBytesPerPrincipal: 52_428_800,
};

describe('AiKillSwitch (confirmation)', () => {
  it('does nothing until the pause is confirmed, and Cancel leaves AI on', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<(next: boolean) => void>();
    renderWithProviders(<AiKillSwitch aiEnabled onConfirm={onConfirm} />);
    const toggle = screen.getByRole('switch', { name: 'AI coaching enabled' });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    const dialog = screen.getByRole('alertdialog', { name: 'Pause AI coaching for everyone?' });
    // The consequences are spelled out before anything happens.
    expect(within(dialog).getByText(/next message in any open session are refused/)).toBeVisible();
    expect(within(dialog).getByText(/can still escalate to a human/)).toBeVisible();
    expect(within(dialog).getByText(/AI spend stops/)).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(toggle).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Keep AI on' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(toggle).toBeChecked();
  });

  it('pauses only after the destructive confirmation', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<(next: boolean) => void>();
    renderWithProviders(<AiKillSwitch aiEnabled onConfirm={onConfirm} />);
    await user.click(screen.getByRole('switch', { name: 'AI coaching enabled' }));
    await user.click(screen.getByRole('button', { name: 'Pause AI coaching' }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('asks before resuming when AI is paused', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<(next: boolean) => void>();
    renderWithProviders(<AiKillSwitch aiEnabled={false} onConfirm={onConfirm} />);
    expect(screen.getByTestId('ai-state')).toHaveTextContent('AI coaching is paused for everyone');
    await user.click(screen.getByRole('switch', { name: 'AI coaching enabled' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Resume AI coaching?' });
    expect(within(dialog).getByText(/Suspended personas stay suspended/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Resume AI coaching' }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('cannot be toggled while a change is in flight', () => {
    renderWithProviders(<AiKillSwitch aiEnabled pending onConfirm={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'AI coaching enabled' })).toBeDisabled();
  });
});

describe('SettingsPage kill switch wiring', () => {
  it('sends only { aiEnabled: false } after confirmation and shows the paused state', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === '/api/v1/admin/settings' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...SETTINGS, aiEnabled: false }));
      }
      if (url === '/api/v1/admin/settings') return Promise.resolve(jsonResponse(SETTINGS));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole('switch', { name: 'AI coaching enabled' }));
    await user.click(screen.getByRole('button', { name: 'Pause AI coaching' }));

    await waitFor(() => {
      expect(screen.getByTestId('ai-state')).toHaveTextContent('AI coaching is paused for everyone');
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[0]).toBe('/api/v1/admin/settings');
    expect(sentJson(patch?.[1])).toEqual({ aiEnabled: false });
    const headers = new Headers(patch?.[1]?.headers);
    expect(headers.get('x-requested-with')).toBe('foundry-ascent');
    expect(screen.getByText('AI coaching is paused platform-wide')).toBeVisible();
  });
});

describe('limits form', () => {
  it('converts the grounding percentage and sends only changed fields', () => {
    const values = toLimitsFormValues(SETTINGS);
    expect(values.groundingPercent).toBe(60);
    expect(limitsPatch(SETTINGS, values)).toEqual({});
    expect(limitsPatch(SETTINGS, { ...values, groundingPercent: 72.5, dailyUsdCapGlobal: 8 })).toEqual({
      groundingCoverageThreshold: 0.725,
      dailyUsdCapGlobal: 8,
    });
  });

  it('edits the daily upload quota in megabytes and sends bytes', () => {
    const values = toLimitsFormValues(SETTINGS);
    expect(values.dailyUploadMegabytesPerPrincipal).toBe(50);
    expect(
      limitsPatch(SETTINGS, {
        ...values,
        dailyUploadDocumentsPerPrincipal: 5,
        dailyUploadMegabytesPerPrincipal: 20,
      }),
    ).toEqual({ dailyUploadDocumentsPerPrincipal: 5, dailyUploadBytesPerPrincipal: 20 * 1024 * 1024 });
  });

  it('rejects a per-person cap above the platform cap', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(SETTINGS));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const perPerson = await screen.findByLabelText('Cap per person per day');
    await user.clear(perPerson);
    await user.type(perPerson, '9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('The per-person cap can’t exceed the platform cap.')).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
