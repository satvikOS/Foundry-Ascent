import type { Me } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bodyOf,
  json,
  renderWithRouter,
  stubFetch,
  testQueryClient,
  urlOf,
} from '@/features/knowledge/test-utils';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { queryKeys } from '@/lib/api/query-keys';

import { PathView } from './path-page';
import { OpeningStep } from './path-section';
import { makeIntake, makePath, PATH_IDS } from './testing';

const V = PATH_IDS.venture;

const ME: Me = {
  principal: {
    id: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
    displayName: 'Maya Example',
    title: null,
    synthetic: true,
  },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: V, ventureName: 'QuietQuad', role: 'founder' }],
  assignedVentureIds: [],
  disclosure: 'Your mentor is an AI.',
  aiEnabled: true,
  notices: [],
};
const EIR: Me = { ...ME, roles: ['eir'], memberships: [], assignedVentureIds: [V] };

async function renderPath(path: ReturnType<typeof makePath> | null = makePath(), me: Me = ME) {
  const client = testQueryClient();
  client.setQueryData(meQueryOptions().queryKey, me);
  client.setQueryData(queryKeys.venture.path(V), path);
  return renderWithRouter(<PathView tenant="ain" ventureId={V} />, client);
}

/** The page on screen (the one-page plan beside it is for paper). */
function onScreen(): HTMLElement {
  const page = document.querySelector<HTMLElement>('[data-slot="page-container"]');
  if (!page) throw new Error('no page');
  return page;
}

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  fetchMock = stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Your path', () => {
  it('says where the venture is, and opens the current stage on what it asks for and what was reported', async () => {
    await renderPath();
    expect(screen.getByRole('heading', { level: 1, name: 'Your path' })).toBeInTheDocument();
    const rail = within(onScreen()).getByRole('list', { name: 'Stages' });
    const stages = within(rail).getAllByRole('button');
    expect(stages).toHaveLength(7);
    expect(stages[1]).toHaveAttribute('aria-expanded', 'true');
    expect(stages[0]).toHaveAttribute('aria-expanded', 'false');
    const asked = within(rail).getByRole('list', { name: 'What Discovery asks for' });
    expect(
      within(asked)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Five real stories · ClaimedFive people described the last time it happened.',
      'What it costs them · OpenA number each of three people gave.',
    ]);
    // A stage that is done opens on the evidence the founder gave.
    await userEvent.setup().click(within(rail).getByRole('button', { name: /Idea$/ }));
    expect(within(rail).getByText(/Dana in the chemistry building/)).toBeInTheDocument();
  });

  it('lists now, next, later and done, and tells the story oldest first', async () => {
    await renderPath();
    const page = within(onScreen());
    expect(
      within(page.getByRole('region', { name: 'Now' })).getByRole('button', { name: 'Done' }),
    ).toBeVisible();
    expect(page.getByRole('region', { name: 'Next' })).toHaveTextContent(
      'Write down the three costs they named',
    );
    expect(page.getByRole('region', { name: 'Later' })).toHaveTextContent('Ask two of them to pay');
    expect(page.getByRole('region', { name: 'Done' })).toHaveTextContent('Name one person with the problem');
    const story = page.getByRole('list', { name: 'Your story' });
    expect(
      within(story)
        .getAllByRole('listitem')
        .map((item) => item.dataset.kind),
    ).toEqual(['origin', 'pivot', 'result']);
    await userEvent.setup().click(page.getByRole('button', { name: 'Conversations (1)' }));
    expect(within(story).getByRole('link', { name: 'Pricing per lab' })).toHaveAttribute(
      'href',
      `/ain/app/v/${V}/c/${PATH_IDS.session}`,
    );
  });

  it('prints the one-page plan (with the AI disclosure) and copies it as text', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await renderPath();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledOnce();
    const sheet = document.querySelector('[data-slot="plan-sheet"]');
    expect(sheet).toHaveTextContent('Stage 2 of 7: Discovery');
    expect(sheet).toHaveTextContent('Your mentor is an AI.');
    expect(onScreen().className).toContain('print:hidden');
    await user.click(screen.getByRole('button', { name: 'Copy text' }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Stage 2 of 7: Discovery'));
    expect(write.mock.calls[0]?.[0]).toContain('Your mentor is an AI.');
  });

  it('an assigned EIR reads it and can change nothing', async () => {
    await renderPath(makePath(), EIR);
    expect(screen.getByRole('heading', { level: 1, name: 'QuietQuad’s path' })).toBeInTheDocument();
    const page = within(onScreen());
    for (const name of ['Done', 'Not yet', 'Changed plan', 'Edit', 'Reopen'])
      expect(page.queryByRole('button', { name })).toBeNull();
    for (const box of page.getAllByRole('checkbox')) expect(box).toBeDisabled();
    // A conversation is the team's: its line in the story is words, not a link.
    await userEvent.setup().click(page.getByRole('button', { name: 'Conversations (1)' }));
    expect(page.queryByRole('link', { name: 'Pricing per lab' })).toBeNull();
    expect(page.getByText('Pricing per lab')).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Print' })).toBeInTheDocument();
  });

  it('a program lead reads its shape: no story, nothing about the founder, nothing to change', async () => {
    fetchMock.mockResolvedValue(
      json({ items: [], venture: { id: V, name: 'QuietQuad' }, invitableRoles: [], canInvite: true }),
    );
    const shape = makePath({ arc: [], intake: null });
    await renderPath(shape, { ...ME, roles: ['program_lead'], memberships: [] });
    const page = within(onScreen());
    expect(page.getByRole('region', { name: 'Stages' })).toBeInTheDocument();
    expect(page.queryByRole('region', { name: /story/i })).toBeNull();
    expect(page.queryByRole('region', { name: /^About/ })).toBeNull();
    expect(page.queryByRole('button', { name: 'Done' })).toBeNull();
    // The venture itself is never asked for.
    expect(fetchMock.mock.calls.every(([url]) => !/\/ventures\/[^/]+$/.test(urlOf(url)))).toBe(true);
  });

  it('shows what the founder said about themselves, and edits all of it', async () => {
    fetchMock.mockResolvedValue(json(makePath({ intake: makeIntake({ hoursPerWeek: 12 }), version: 8 })));
    await renderPath();
    const about = within(screen.getByRole('region', { name: 'About you' }));
    expect(about.getByText('Chemical engineering')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(about.getByRole('button', { name: 'Edit' }));
    const hours = about.getByRole('textbox', { name: 'Hours a week' });
    expect(hours).toHaveValue('8');
    await user.clear(hours);
    await user.type(hours, '12');
    expect(about.getByRole('textbox', { name: 'What’s in the way' })).toBeInTheDocument();
    await user.click(about.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
        expectedVersion: 7,
        intake: { hoursPerWeek: 12, studies: 'Chemical engineering', deadline: { what: 'Pitch night' } },
      });
    });
    expect(await about.findByText('12')).toBeInTheDocument();
  });

  it('says so while there is no path, and where to ask', async () => {
    await renderPath(null);
    expect(screen.getByRole('heading', { name: 'No path yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveAttribute('href', `/ain/app/v/${V}`);
  });
});

describe('an opened conversation, before its first message', () => {
  it('offers the step the opening asks about, one press from what happened to it', async () => {
    const client = testQueryClient();
    client.setQueryData(queryKeys.venture.path(V), makePath());
    await renderWithRouter(<OpeningStep tenant="ain" ventureId={V} />, client);
    const line = screen.getByRole('button', { name: /^Next step\s*Hear five lab managers/ });
    await userEvent.setup().click(line);
    for (const name of ['Done', 'Not yet', 'Changed plan'])
      expect(screen.getByRole('button', { name })).toBeEnabled();
  });

  it('is nothing without a path', async () => {
    const client = testQueryClient();
    client.setQueryData(queryKeys.venture.path(V), null);
    await renderWithRouter(<OpeningStep tenant="ain" ventureId={V} />, client);
    expect(document.querySelector('[data-slot="step-card"]')).toBeNull();
  });
});
