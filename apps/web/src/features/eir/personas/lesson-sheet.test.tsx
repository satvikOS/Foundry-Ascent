import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { lessonEdit, LessonForm, lessonToForm } from './lesson-form';
import { LessonSheet } from './lesson-sheet';
import { IDS, lesson } from './test-fixtures';

describe('lesson form', () => {
  it('edits only the fields that changed, trimmed', () => {
    const draft = lesson();
    expect(lessonEdit(draft, lessonToForm(draft))).toBeNull();
    expect(lessonEdit(draft, { ...lessonToForm(draft), title: '  Compliments are not demand  ' })).toEqual({
      action: 'edit',
      title: 'Compliments are not demand',
    });
  });

  it('needs every part of a lesson', () => {
    const result = LessonForm.safeParse({ ...lessonToForm(lesson()), limits: ' ', signal: 'ok' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toEqual(['signal', 'limits']);
  });
});

describe('LessonSheet', () => {
  it('saves the edits, then publishes the lesson', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) => {
      const body = sentJson(init) as { action: string };
      return Promise.resolve(
        jsonResponse(
          lesson({
            status: body.action === 'publish' ? 'published' : 'draft',
            title: 'Compliments are not demand',
          }),
        ),
      );
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <LessonSheet
        personaId={IDS.corin}
        shortName="Corin"
        canCurate
        state={{ mode: 'open', lesson: lesson() }}
        onClose={onClose}
      />,
    );
    // A distilled draft asks the reviewer to check it is de-identified.
    expect(screen.getByText('Proposed from conversations')).toBeVisible();
    const title = screen.getByRole('textbox', { name: /Title/ });
    await user.clear(title);
    await user.type(title, 'Compliments are not demand');
    await user.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url, body: sentJson(init) }));
    expect(calls).toEqual([
      {
        url: `/api/v1/lessons/${IDS.lesson}/actions`,
        body: { action: 'edit', title: 'Compliments are not demand' },
      },
      { url: `/api/v1/lessons/${IDS.lesson}/actions`, body: { action: 'publish' } },
    ]);
  });

  it('withdraws only after confirmation', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(lesson({ status: 'withdrawn' })));
    const user = userEvent.setup();
    renderWithProviders(
      <LessonSheet
        personaId={IDS.corin}
        shortName="Corin"
        canCurate
        state={{ mode: 'open', lesson: lesson({ status: 'published', origin: 'authored' }) }}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(screen.getByRole('alertdialog', { name: 'Withdraw this lesson?' })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog', { name: 'Withdraw this lesson?' });
    await user.click(within(confirm).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(sentJson(fetchMock.mock.calls[0]?.[1])).toEqual({ action: 'withdraw' });
  });

  it('is read-only for people who don’t curate the vEIR and for withdrawn lessons', () => {
    const first = renderWithProviders(
      <LessonSheet
        personaId={IDS.corin}
        shortName="Corin"
        canCurate={false}
        state={{ mode: 'open', lesson: lesson({ status: 'published' }) }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.getByText('Ask for a commitment that costs something.')).toBeVisible();

    first.unmount();
    renderWithProviders(
      <LessonSheet
        personaId={IDS.corin}
        shortName="Corin"
        canCurate
        state={{ mode: 'open', lesson: lesson({ status: 'withdrawn' }) }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('creates a new lesson as a draft', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(lesson({ origin: 'authored' }), 201));
    const user = userEvent.setup();
    renderWithProviders(
      <LessonSheet
        personaId={IDS.corin}
        shortName="Corin"
        canCurate
        state={{ mode: 'create' }}
        onClose={vi.fn()}
      />,
    );
    const values = {
      Title: 'Name the buyer early',
      Context: 'B2B pilots on campus.',
      Signal: 'Users love it but nobody pays.',
      'What helps': 'Map who signs the cheque.',
      Outcome: 'The pilot finds a budget owner.',
      Limits: 'Consumer products.',
    };
    for (const [label, value] of Object.entries(values)) {
      await user.type(screen.getByRole('textbox', { name: new RegExp(`^${label}`) }), value);
    }
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/personas/${IDS.corin}/lessons`);
    expect(sentJson(init)).toEqual({
      title: 'Name the buyer early',
      context: 'B2B pilots on campus.',
      signal: 'Users love it but nobody pays.',
      intervention: 'Map who signs the cheque.',
      outcome: 'The pilot finds a budget owner.',
      limits: 'Consumer products.',
    });
  });
});
