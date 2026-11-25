import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  json,
  problem,
  renderWithRouter,
  bodyOf,
  stubFetch,
  testQueryClient,
} from '@/features/knowledge/test-utils';
import { queryKeys } from '@/lib/api/query-keys';

import { addDays, localIsoDay } from '../chat/due-actions';
import { makeEvidence } from '../coach/testing';
import { StepCard, TurnStepCard } from './step-card';
import { makeGuidance, makeOfferedGuidance, makeOfferedStep, makePath, makeStep, PATH_IDS } from './testing';

const V = PATH_IDS.venture;

function clientWith(path = makePath()) {
  const client = testQueryClient();
  client.setQueryData(queryKeys.venture.path(V), path);
  return client;
}

/** What the card sent, oldest first. */
function updates(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => (bodyOf(init) as { update: unknown }).update);
}

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  fetchMock = stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderCard(props: Partial<Parameters<typeof StepCard>[0]> = {}, client = clientWith()) {
  return renderWithRouter(
    <StepCard tenant="ain" ventureId={V} step={makeStep()} canEdit {...props} />,
    client,
  );
}

describe('StepCard', () => {
  it('shows what to do, how, when it counts as done, by when, the template and the sources', async () => {
    await renderCard({ place: makeGuidance() });
    const card = screen.getByRole('region', { name: /^Hear five lab managers/ });
    expect(within(card).getByText('Next step')).toBeInTheDocument();
    expect(card).toHaveTextContent('Done when: Five people described the last time it happened, with dates.');
    expect(card).toHaveTextContent(/By \w+/);
    const how = within(card).getByRole('list', { name: 'How' });
    const items = within(how).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('1. List 20 lab managers you can reach');
    expect(items[0]).toHaveTextContent('Start with your own department. · 30 min');
    expect(within(how).getByRole('checkbox', { name: /List 20/ })).toBeChecked();
    expect(card).toHaveTextContent('Use this template');
    const source = within(card).getByRole('link', { name: /The Mom Test, Chapter 3/ });
    expect(source).toHaveAttribute('href', 'https://www.momtestbook.com/');
    expect(source).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(
      within(card).getByRole('button', { name: /Ain programme: customer discovery, Module 2, unit 4/ }),
    ).toBeInTheDocument();
  });

  it('ticks a sub-step', async () => {
    fetchMock.mockResolvedValue(json(makePath({ now: makeStep({ version: 4 }) })));
    await renderCard();
    await userEvent.setup().click(screen.getByRole('checkbox', { name: /Write to ten of them today/ }));
    await waitFor(() => {
      expect(updates(fetchMock)).toEqual([{ action: 'tick', item: 1, done: true }]);
    });
  });

  it('Done asks for one line of evidence, and only saves with it', async () => {
    const done = makeStep({ status: 'done', evidence: 'Five calls, all ran out in October.', version: 4 });
    fetchMock.mockResolvedValue(
      json(
        makePath({
          now: makeStep({ id: PATH_IDS.next, title: 'Write down the costs' }),
          next: [],
          done: [done],
        }),
      ),
    );
    await renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    const line = screen.getByRole('textbox', { name: 'What happened, in one line' });
    expect(line).toHaveFocus();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(line, 'Five calls, all ran out in October.{Enter}');
    await waitFor(() => {
      expect(updates(fetchMock)).toEqual([
        { action: 'complete', evidence: 'Five calls, all ran out in October.' },
      ]);
    });
    // Done: the founder's words, a way back, and what the path is on now.
    expect(await screen.findByText('Five calls, all ran out in October.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Now:\s*Write down the costs$/ })).toHaveAttribute(
      'href',
      `/ain/app/v/${V}/path`,
    );
    expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull();
  });

  it('keeps the line the founder typed when it could not be saved', async () => {
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(init?.method === 'PATCH' ? problem(503, 'internal') : json(makePath())),
    );
    await renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.type(screen.getByRole('textbox'), 'Talked to five{Enter}');
    await waitFor(() => {
      expect(updates(fetchMock)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
    expect(screen.getByRole('textbox')).toHaveValue('Talked to five');
  });

  it('Not yet moves the date in one press', async () => {
    fetchMock.mockResolvedValue(json(makePath({ now: makeStep({ version: 4 }) })));
    await renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.getByRole('button', { name: '2 days' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '1 week' }));
    await waitFor(() => {
      expect(updates(fetchMock)).toEqual([{ action: 'reschedule', dueOn: addDays(localIsoDay(), 7) }]);
    });
    expect(await screen.findByRole('button', { name: 'Not yet' })).toBeInTheDocument();
  });

  it('Not yet also says what is in the way', async () => {
    fetchMock.mockResolvedValue(json(makePath({ now: makeStep({ version: 4, status: 'blocked' }) })));
    await renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    await user.click(screen.getByRole('button', { name: 'Blocked' }));
    await user.type(screen.getByRole('textbox', { name: 'What’s in the way' }), 'No replies yet{Enter}');
    await waitFor(() => {
      expect(updates(fetchMock)).toEqual([{ action: 'block', reason: 'No replies yet' }]);
    });
  });

  it('Changed plan skips it with the reason, and stays skipped where the path no longer lists it', async () => {
    fetchMock.mockResolvedValue(json(makePath({ now: null, next: [] })));
    await renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Changed plan' }));
    await user.type(screen.getByRole('textbox', { name: 'What changed' }), 'Selling to schools{Enter}');
    await waitFor(() => {
      expect(updates(fetchMock)).toEqual([{ action: 'skip', reason: 'Selling to schools' }]);
    });
    expect(await screen.findByText('Selling to schools')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('Why this says the stage, the evidence it produces and what follows', async () => {
    await renderCard({ place: makeGuidance(), then: ['Write down the three costs they named'] });
    const why = screen.getByRole('button', { name: 'Why this' });
    expect(why).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    const card = screen.getByRole('region', { name: /^Hear five/ });
    expect(card).toHaveTextContent('Discovery: Prove the problem happens often, to people you can reach.');
    expect(card).toHaveTextContent('Five real stories. Five people described the last time it happened.');
    expect(card).toHaveTextContent('Write down the three costs they named');
  });

  it('Escape closes its form and gives focus back to the control that opened it', async () => {
    await renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Changed plan' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Changed plan' })).toHaveFocus();
    });
  });

  it('is read-only for someone who cannot change the venture', async () => {
    await renderCard({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  it('while the reply is written, it shows whole and its controls wait', async () => {
    await renderCard({ busy: true });
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(2);
  });

  it('an older reply’s is one line that unfolds and folds, with the step as it stands now', async () => {
    const done = makeStep({ status: 'done', evidence: 'Five calls.', version: 4 });
    await renderCard({ expanded: false }, clientWith(makePath({ now: null, done: [done] })));
    const line = screen.getByRole('button', { name: /^Done\s*Hear five lab managers/ });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox')).toBeNull();
    const user = userEvent.setup();
    await user.click(line);
    expect(screen.getByText('Five calls.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fold' }));
    expect(screen.queryByText('Five calls.')).toBeNull();
  });

  it('the template opens whole, ready to copy', async () => {
    await renderCard();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Open template: Interview invitation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Interview invitation' });
    expect(dialog).toHaveTextContent('Hi [name], I am studying how labs track reagents.');
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('a source without a page shows its detail on a press, with the passage the reply used', async () => {
    await renderCard({
      evidence: [
        makeEvidence({
          key: 'E3',
          title: 'Ain programme: customer discovery',
          excerpt: 'Ask about last week.',
        }),
      ],
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /Ain programme: customer discovery/ }));
    const detail = await screen.findByRole('dialog', { name: /^Source: Ain programme/ });
    expect(detail).toHaveTextContent('Ask about last week.');
    expect(detail).toHaveTextContent('Module 2, unit 4');
  });

  it('never links a source to anything but https', async () => {
    const step = makeStep({
      citations: [
        { sourceId: 'x', locator: null, title: 'A source', authors: '', url: 'javascript:alert(1)' },
      ],
    });
    await renderCard({ step }, clientWith(makePath({ now: step })));
    expect(screen.queryByRole('link', { name: /A source/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'A source' })).toBeInTheDocument();
  });
});

describe('TurnStepCard', () => {
  const card = (guidance = makeGuidance(), props: Partial<Parameters<typeof TurnStepCard>[0]> = {}) => (
    <TurnStepCard guidance={guidance} tenant="ain" ventureId={V} canEdit latest {...props} />
  );

  it('shows the person to see and what to bring when a qualified person must decide', async () => {
    const ask = vi.fn();
    await renderWithRouter(
      card(
        makeGuidance({
          referral: {
            category: 'legal',
            role: 'specialist',
            who: 'The university’s legal clinic',
            bring: 'The draft agreement',
          },
        }),
        { onAskPerson: ask },
      ),
      clientWith(),
    );
    expect(screen.getByText('The university’s legal clinic')).toBeInTheDocument();
    expect(screen.getByText('The draft agreement')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ask a person' }));
    expect(ask).toHaveBeenCalledOnce();
  });

  it('is nothing on a turn with no step and no referral', async () => {
    const { container } = await renderWithRouter(card(makeGuidance({ step: null })), clientWith());
    expect(container.querySelector('[data-slot="step-card"]')).toBeNull();
  });

  it('folds when a newer reply takes its place', async () => {
    function Transcript() {
      const [latest, setLatest] = useState(true);
      return (
        <>
          {card(makeGuidance(), { latest })}
          <button
            type="button"
            onClick={() => {
              setLatest(false);
            }}
          >
            A newer reply
          </button>
        </>
      );
    }
    await renderWithRouter(<Transcript />, clientWith());
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'A newer reply' }));
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Next step\s*Hear five/ })).toBeInTheDocument();
  });

  describe('a step offered as the answer to what they asked', () => {
    const offered = makeOfferedStep().title;
    const region = () => screen.getByRole('region', { name: offered });

    it('is added to the path in one press, first among its actions', async () => {
      fetchMock.mockResolvedValue(
        json(makePath({ next: [makeOfferedStep({ status: 'next', version: 2 })], version: 8 })),
      );
      await renderWithRouter(card(makeOfferedGuidance()), clientWith());
      const actions = within(region()).getByRole('group', { name: 'This step' });
      expect(
        within(actions)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Add to my path', 'Done', 'Not yet', 'Changed plan', 'Why this']);
      // It answers what they asked: the next step, never "Later".
      expect(within(region()).getByText('Next step')).toBeInTheDocument();
      expect(screen.queryByText('Later')).toBeNull();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Add to my path' }));
      await waitFor(() => {
        expect(updates(fetchMock)).toEqual([{ action: 'add' }]);
      });
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Add to my path' })).toBeNull();
      });
      expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    });

    it('is not offered again once the path lists it', async () => {
      await renderWithRouter(
        card(makeOfferedGuidance()),
        clientWith(makePath({ next: [makeOfferedStep({ status: 'next' })] })),
      );
      expect(screen.queryByRole('button', { name: 'Add to my path' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });

    it('keeps its other actions: a tick stays ticked and Done stays done, on the path or not', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(json(makePath())));
      await renderWithRouter(card(makeOfferedGuidance()), clientWith());
      const user = userEvent.setup();
      const first = screen.getByRole('checkbox', { name: /Write the price/ });
      await user.click(first);
      await waitFor(() => {
        expect(updates(fetchMock)).toEqual([{ action: 'tick', item: 0, done: true }]);
      });
      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: /Write the price/ })).toBeChecked();
      });
      await user.click(screen.getByRole('button', { name: 'Done' }));
      await user.type(screen.getByRole('textbox'), 'Three labs heard 45 dollars.{Enter}');
      expect(await screen.findByText('Three labs heard 45 dollars.')).toBeInTheDocument();
      // Each change is made against the version the one before left.
      const versions = fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => (bodyOf(init) as { expectedVersion: number }).expectedVersion);
      expect(versions).toEqual([1, 2]);
    });

    it('waits while the reply is written, and is nothing to press for someone who only reads', async () => {
      const { unmount } = await renderWithRouter(card(makeOfferedGuidance(), { busy: true }), clientWith());
      expect(screen.getByRole('button', { name: 'Add to my path' })).toBeDisabled();
      unmount();
      await renderWithRouter(card(makeOfferedGuidance(), { canEdit: false }), clientWith());
      expect(screen.queryByRole('button', { name: 'Add to my path' })).toBeNull();
    });
  });

  describe('the path’s own step, still open', () => {
    it('is one quiet line that leads to the path page', async () => {
      const { container } = await renderWithRouter(card(makeOfferedGuidance()), clientWith());
      const line = container.querySelector('[data-slot="step-path"]');
      expect(line).toHaveTextContent(
        /^Still open on your path: Hear five lab managers describe the last time they ran out of a reagent, by \w{3}/,
      );
      expect(within(line as HTMLElement).getByRole('link')).toHaveAttribute('href', `/ain/app/v/${V}/path`);
    });

    it('says when it is overdue, with no link on a call', async () => {
      const { container } = await renderWithRouter(
        card(makeOfferedGuidance({ pathStep: makeStep({ dueOn: '2020-03-02', version: 4 }) }), {
          dense: true,
        }),
        clientWith(makePath({ now: null })),
      );
      const line = container.querySelector('[data-slot="step-path"]');
      expect(line).toHaveTextContent(/, overdue since \w{3}, Mar 2$/);
      expect(within(line as HTMLElement).queryByRole('link')).toBeNull();
    });

    it('goes when the step is done, when there is none, and on an older reply', async () => {
      const done = makeStep({ status: 'done', evidence: 'Five calls.', version: 9 });
      const first = await renderWithRouter(
        card(makeOfferedGuidance()),
        clientWith(makePath({ now: null, done: [done] })),
      );
      expect(first.container.querySelector('[data-slot="step-path"]')).toBeNull();
      first.unmount();
      const second = await renderWithRouter(card(makeGuidance()), clientWith());
      expect(second.container.querySelector('[data-slot="step-path"]')).toBeNull();
      second.unmount();
      const third = await renderWithRouter(card(makeOfferedGuidance(), { latest: false }), clientWith());
      expect(third.container.querySelector('[data-slot="step-path"]')).toBeNull();
    });
  });
});
