import type { RecordingView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';
import { queryKeys } from '@/lib/api/query-keys';

import { RecordingsList } from './recordings-list';

const RECORDING: RecordingView = {
  id: '55555555-5555-4555-8555-555555555555',
  callId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  ventureId: '33333333-3333-4333-8333-333333333333',
  conversationTitle: 'Pilot pricing',
  mimeType: 'video/webm',
  kind: 'video',
  bytes: 4_096,
  durationMs: 125_000,
  hasCaptions: true,
  status: 'ready',
  createdAt: '2026-11-06T12:00:00.000Z',
  completedAt: '2026-11-06T12:00:05.000Z',
};

const VTT = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<v.veir Thomas>What changed this week?\n';

/** The list with its own playing state, as the pages hold it. */
function Playing({ onPlay }: { onPlay: (id: string | null) => void }) {
  const [playing, setPlaying] = useState<string | null>(null);
  return (
    <RecordingsList
      items={[RECORDING]}
      playing={playing}
      onPlay={(id) => {
        onPlay(id);
        setPlaying(id);
      }}
      showConversation
      label="Your recordings"
    />
  );
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecordingsList', () => {
  it('plays a recording with its captions as a transcript, from presigned URLs, without calling the vEIR', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.includes('/playback')) {
        return Promise.resolve(
          jsonResponse({
            recording: RECORDING,
            media: { url: 'https://recordings.test/call.webm?sig=1', expiresAt: '2026-11-06T13:00:00.000Z' },
            captions: {
              url: 'https://recordings.test/captions.vtt?sig=1',
              expiresAt: '2026-11-06T13:00:00.000Z',
            },
          }),
        );
      }
      if (url.startsWith('https://recordings.test/captions.vtt'))
        return Promise.resolve(new Response(VTT, { status: 200 }));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const { client } = renderWithProviders(<Playing onPlay={onPlay} />);
    const row = within(screen.getByRole('list', { name: 'Your recordings' })).getByRole('listitem');
    expect(row).toHaveTextContent('Pilot pricing');
    expect(row).toHaveTextContent('2:05');
    await user.click(within(row).getByRole('button', { name: /^Play the recording from / }));
    expect(onPlay).toHaveBeenCalledWith(RECORDING.id);
    const transcript = await screen.findByRole('list', { name: 'Transcript' });
    await waitFor(() => {
      expect(transcript).toHaveTextContent('Thomas: What changed this week?');
    });
    const video = document.querySelector('video[data-slot="recording-video"]');
    expect(video?.getAttribute('src')).toBe('https://recordings.test/call.webm?sig=1');
    expect(video?.getAttribute('crossorigin')).toBe('anonymous');
    // Only the playback grant and the captions file: no turn, no speech, no model.
    const urls = fetchMock.mock.calls.map(([input]) => urlOf(input));
    expect(
      urls.every((url) => url.includes('/recordings/') || url.startsWith('https://recordings.test/')),
    ).toBe(true);

    // Another recording saved or deleted refreshes the lists, never the one playing: no new URLs, no restart.
    await client.invalidateQueries({ queryKey: queryKeys.recordings.all() });
    const playbacks = fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/playback'));
    expect(playbacks).toHaveLength(1);
    expect(document.querySelector('video[data-slot="recording-video"]')).toBe(video);
  });

  it('deletes a recording after confirming', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderWithProviders(
      <RecordingsList
        items={[RECORDING]}
        playing={null}
        onPlay={vi.fn()}
        label="Recordings of this conversation"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Delete the recording from / }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this recording?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete recording' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input === undefined ? '' : urlOf(input)).toContain(`/recordings/${RECORDING.id}`);
    expect(init?.method).toBe('DELETE');
  });
});
