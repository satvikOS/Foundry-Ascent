import { DEFAULT_SPEECH_VOICE_ID, SPEECH_VOICE_IDS, type PersonaEmbodiment } from '@foundry/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { EmbodimentTab } from './embodiment-tab';
import { IDS, persona } from './test-fixtures';

const EMBODIMENT: PersonaEmbodiment = {
  provider: 'builtin',
  voiceId: 'Matthew',
  portraitUrl: null,
  voiceConsented: true,
  likenessConsented: false,
};

describe('EmbodimentTab (voice & face)', () => {
  it('saves a voice from the allowed list', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        jsonResponse(init?.method === 'PATCH' ? { ...EMBODIMENT, voiceId: 'Ruth' } : EMBODIMENT),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <EmbodimentTab persona={persona()} displayName="Corin’s vEIR" onOpenConsent={vi.fn()} />,
    );
    const voice = await screen.findByRole('combobox', { name: 'Voice on calls' });
    expect(voice).toHaveTextContent('Matthew');
    expect(screen.getByRole('button', { name: 'Save voice' })).toBeDisabled();
    await user.click(voice);
    await user.click(screen.getByRole('option', { name: 'Ruth' }));
    await user.click(screen.getByRole('button', { name: 'Save voice' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[0]).toBe(`/api/v1/personas/${IDS.corin}/embodiment`);
    expect(sentJson(patch?.[1])).toEqual({ voiceId: 'Ruth' });
  });

  it('offers every voice the speech service accepts, and still shows a saved voice it has dropped', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ ...EMBODIMENT, voiceId: 'Brian' }));
    const user = userEvent.setup();
    renderWithProviders(
      <EmbodimentTab persona={persona()} displayName="Corin’s vEIR" onOpenConsent={vi.fn()} />,
    );
    const voice = await screen.findByRole('combobox', { name: 'Voice on calls' });
    expect(voice).toHaveTextContent('Brian (retired)');
    await user.click(voice);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      `Platform default (${DEFAULT_SPEECH_VOICE_ID})`,
      ...SPEECH_VOICE_IDS,
      'Brian (retired)',
    ]);
  });

  it('keeps the platform voice until the consent covers voice', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ ...EMBODIMENT, voiceId: null, voiceConsented: false }));
    const onOpenConsent = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <EmbodimentTab persona={persona()} displayName="Corin’s vEIR" onOpenConsent={onOpenConsent} />,
    );
    const voice = await screen.findByRole('combobox', { name: 'Voice on calls' });
    expect(voice).toBeDisabled();
    expect(voice).toHaveTextContent('Platform default (Danielle)');
    expect(screen.getByText(/consent doesn’t cover voice/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save voice' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Update consent' }));
    expect(onOpenConsent).toHaveBeenCalledOnce();
  });
});
