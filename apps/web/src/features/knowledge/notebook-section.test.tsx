import type { VeirNotebook } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { queryKeys } from '@/lib/api/query-keys';

import { NotebookEditor } from './notebook-section';
import { bodyOf, json, problem, renderWithRouter, stubFetch, testQueryClient, urlOf } from './test-utils';
import { IDS, makeNotebook } from './testing';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

async function renderNotebook(notebook: VeirNotebook, canEdit = true) {
  const client = testQueryClient();
  client.setQueryData(queryKeys.venture.notebook(IDS.venture), notebook);
  await renderWithRouter(
    <NotebookEditor ventureId={IDS.venture} veirName="Corin" canEdit={canEdit} />,
    client,
  );
  return { client, user: userEvent.setup() };
}

function patches() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
}

describe('NotebookEditor', () => {
  it('labels the notes as AI notes and shows every section', async () => {
    await renderNotebook(makeNotebook());
    expect(screen.getByRole('heading', { name: 'What Corin knows' })).toBeInTheDocument();
    expect(screen.getByText(/never treated as facts/)).toBeInTheDocument();
    for (const name of [
      'Summary',
      'About you',
      'Commitments',
      'Open questions',
      'Last advice',
      'Next conversation',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('edits a line in place against the version on screen', async () => {
    const notebook = makeNotebook();
    fetchMock.mockResolvedValue(
      json({
        ...notebook,
        version: 4,
        founderProfile: [{ ...notebook.founderProfile[0], text: 'Numbers first.' }],
      }),
    );
    const { user, client } = await renderNotebook(notebook);
    const about = screen.getByRole('region', { name: 'About you' });
    await user.click(within(about).getByRole('button', { name: 'Edit' }));
    const box = within(about).getByRole('textbox', { name: 'Edit note' });
    await user.clear(box);
    await user.type(box, 'Numbers first.{Enter}');

    await waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    const [input, init] = patches()[0] ?? [];
    expect(urlOf(input)).toContain(`/ventures/${IDS.venture}/notebook`);
    expect(bodyOf(init)).toEqual({
      expectedVersion: 3,
      edit: { action: 'edit_entry', section: 'founderProfile', id: 'fp-numbers', text: 'Numbers first.' },
    });
    await waitFor(() => {
      expect(client.getQueryData<VeirNotebook>(queryKeys.venture.notebook(IDS.venture))?.version).toBe(4);
    });
    expect(within(about).getByText('Numbers first.')).toBeInTheDocument();
  });

  it('undoes the edit, reloads the notebook and tells the person when it changed meanwhile (409)', async () => {
    const notebook = makeNotebook();
    const latest = makeNotebook({ version: 5, nextOpener: 'What did facilities say?' });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(init?.method === 'PATCH' ? problem(409, 'conflict') : json(latest)),
    );
    const { user, client } = await renderNotebook(notebook);
    const next = screen.getByRole('region', { name: 'Next conversation' });
    await user.click(within(next).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('The notebook changed')).toBeInTheDocument();
    expect(bodyOf(patches()[0]?.[1])).toEqual({ expectedVersion: 3, edit: { action: 'remove_opener' } });
    await waitFor(() => {
      expect(client.getQueryData<VeirNotebook>(queryKeys.venture.notebook(IDS.venture))?.version).toBe(5);
    });
    expect(screen.getByText('What did facilities say?')).toBeInTheDocument();
  });

  it('marks a commitment done and removes the opener', async () => {
    const notebook = makeNotebook();
    fetchMock.mockImplementation((_input, init) => {
      const body = bodyOf(init) as { edit: { action: string } };
      return Promise.resolve(
        json(
          body.edit.action === 'remove_opener'
            ? { ...notebook, version: 5, nextOpener: null }
            : { ...notebook, version: 4, commitments: [{ ...notebook.commitments[0], status: 'done' }] },
        ),
      );
    });
    const { user } = await renderNotebook(notebook);
    await user.click(
      within(screen.getByRole('region', { name: 'Commitments' })).getByRole('checkbox', { name: 'Done' }),
    );
    await waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    expect(bodyOf(patches()[0]?.[1])).toEqual({
      expectedVersion: 3,
      edit: { action: 'edit_commitment', id: 'c-interviews', status: 'done' },
    });

    await user.click(
      within(screen.getByRole('region', { name: 'Next conversation' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => {
      expect(patches()).toHaveLength(2);
    });
    // The second edit waits for the first and sends the version it produced.
    expect(bodyOf(patches()[1]?.[1])).toEqual({ expectedVersion: 4, edit: { action: 'remove_opener' } });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Next conversation' })).toBeNull();
    });
  });

  it('after a queued edit fails, the next edit sends the version the server last saved', async () => {
    const notebook = makeNotebook();
    const done = { ...notebook, version: 4, commitments: [{ ...notebook.commitments[0], status: 'done' }] };
    let releaseFirst: (response: Response) => void = () => undefined;
    let patchCount = 0;
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== 'PATCH') return Promise.resolve(json(done)); // the reload after the failure
      patchCount += 1;
      if (patchCount === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (patchCount === 2) return Promise.resolve(problem(503, 'unavailable'));
      return Promise.resolve(json({ ...done, version: 5, nextOpener: null }));
    });
    const { user, client } = await renderNotebook(notebook);
    const key = queryKeys.venture.notebook(IDS.venture);

    // Edit 1 is saving while edit 2 is made on top of it.
    await user.click(
      within(screen.getByRole('region', { name: 'Commitments' })).getByRole('checkbox', { name: 'Done' }),
    );
    await user.click(
      within(screen.getByRole('region', { name: 'Next conversation' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(patches()).toHaveLength(1);
    releaseFirst(json(done));

    // Edit 2 fails: the screen shows the notebook edit 1 saved (version 4), not the one from before it.
    await waitFor(() => {
      expect(patches()).toHaveLength(2);
    });
    expect(bodyOf(patches()[1]?.[1])).toEqual({ expectedVersion: 4, edit: { action: 'remove_opener' } });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Next conversation' })).toBeInTheDocument();
    });
    expect(client.getQueryData<VeirNotebook>(key)?.version).toBe(4);

    // Trying again sends version 4, so it is accepted instead of failing as a false conflict.
    await user.click(
      within(screen.getByRole('region', { name: 'Next conversation' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => {
      expect(patches()).toHaveLength(3);
    });
    expect(bodyOf(patches()[2]?.[1])).toEqual({ expectedVersion: 4, edit: { action: 'remove_opener' } });
    await waitFor(() => {
      expect(client.getQueryData<VeirNotebook>(key)?.version).toBe(5);
    });
    expect(screen.queryByText('The notebook changed')).toBeNull();
  });

  it('drops an edit made on top of one the server refused as stale, without sending it', async () => {
    const notebook = makeNotebook();
    const latest = makeNotebook({ version: 6, summary: 'A teammate rewrote the summary.' });
    let refuseFirst: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== 'PATCH') return Promise.resolve(json(latest));
      return new Promise<Response>((resolve) => {
        refuseFirst = resolve;
      });
    });
    const { user, client } = await renderNotebook(notebook);

    await user.click(
      within(screen.getByRole('region', { name: 'Commitments' })).getByRole('checkbox', { name: 'Done' }),
    );
    await user.click(
      within(screen.getByRole('region', { name: 'Next conversation' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    refuseFirst(problem(409, 'conflict'));

    expect(await screen.findByText('The notebook changed')).toBeInTheDocument();
    await waitFor(() => {
      expect(client.getQueryData<VeirNotebook>(queryKeys.venture.notebook(IDS.venture))?.version).toBe(6);
    });
    // The second edit was never sent against the teammate's notebook.
    expect(patches()).toHaveLength(1);
    expect(screen.getByText('A teammate rewrote the summary.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Next conversation' })).toBeInTheDocument();
  });

  it('credits the notes to the vEIR, not to the human EIR', async () => {
    await renderNotebook(makeNotebook());
    expect(screen.getByText(/^Updated by Corin’s vEIR/)).toBeInTheDocument();
    expect(screen.getByText(/Notes Corin’s vEIR keeps from your conversations/)).toBeInTheDocument();
  });

  it('asks before clearing the whole notebook', async () => {
    const notebook = makeNotebook();
    fetchMock.mockResolvedValue(
      json({
        ...notebook,
        version: 4,
        summary: '',
        founderProfile: [],
        commitments: [],
        openQuestions: [],
        lastAdvice: [],
        nextOpener: null,
      }),
    );
    const { user } = await renderNotebook(notebook);
    await user.click(screen.getByRole('button', { name: 'Clear notebook' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Clear the notebook?' });
    expect(patches()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Clear notebook' }));
    await waitFor(() => {
      expect(bodyOf(patches()[0]?.[1])).toEqual({ expectedVersion: 3, edit: { action: 'clear' } });
    });
    expect(await screen.findByRole('heading', { name: 'Nothing noted yet' })).toBeInTheDocument();
  });

  it('is read-only for the assigned EIR', async () => {
    await renderNotebook(makeNotebook(), false);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear notebook' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
