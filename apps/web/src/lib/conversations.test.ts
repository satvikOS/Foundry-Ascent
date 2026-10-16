import { describe, expect, it } from 'vitest';

import {
  conversationTitle,
  groupByRecency,
  lastActivity,
  listedInRecents,
  startStamp,
  titleFromMessage,
} from './conversations';

describe('titleFromMessage', () => {
  it('keeps a short first line and collapses whitespace', () => {
    expect(titleFromMessage('  Which   assumption first?\nMore detail here')).toBe('Which assumption first?');
  });

  it('cuts long text at a word boundary with an ellipsis', () => {
    const title = titleFromMessage(
      'We need to decide whether to file a provisional patent before demo day or wait for the pilot',
    );
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('We need to decide whether to file a provisional patent…');
  });

  it('skips leading blank lines', () => {
    expect(titleFromMessage('\n\n  Pricing for libraries')).toBe('Pricing for libraries');
  });
});

describe('conversationTitle', () => {
  const base = {
    title: null,
    goal: null,
    privacy: 'standard' as const,
    startedAt: '2026-10-16T14:05:00.000Z',
  };

  it('prefers the title, then the goal, and never derives one from a message', () => {
    expect(conversationTitle({ ...base, title: 'Interview plan', goal: 'Goal' })).toBe('Interview plan');
    expect(conversationTitle({ ...base, goal: 'Find the riskiest assumption' })).toBe(
      'Find the riskiest assumption',
    );
    // Untitled by the server (e.g. a crisis first message): the time it started, never the message.
    expect(conversationTitle(base)).toMatch(/^Conversation · /);
  });

  it('falls back to when it started, so untitled conversations never read the same', () => {
    const morning = conversationTitle(base);
    const evening = conversationTitle({ ...base, startedAt: '2026-10-16T19:40:00.000Z' });
    expect(morning).toMatch(/^Conversation · /);
    expect(morning).not.toBe(evening);
    expect(conversationTitle({ ...base, title: '   ' })).toBe(morning);
    expect(conversationTitle({ ...base, privacy: 'ephemeral' })).toMatch(/^Temporary chat · /);
  });

  it('keeps the fallback short enough that the time survives the sidebar', () => {
    const now = new Date(2026, 9, 16, 15, 0, 0);
    const today = (hour: number, minute: number) => new Date(2026, 9, 16, hour, minute).toISOString();
    const first = conversationTitle({ ...base, privacy: 'ephemeral', startedAt: today(6, 55) }, now);
    const second = conversationTitle({ ...base, privacy: 'ephemeral', startedAt: today(9, 10) }, now);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(26);
    expect(first).toBe(`Temporary chat · ${startStamp(today(6, 55), now)}`);
  });
});

describe('startStamp', () => {
  const now = new Date(2026, 9, 16, 15, 0, 0);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  it('shows only the time today, the weekday this week, the day this year and the year before', () => {
    const today = new Date(2026, 9, 16, 6, 55);
    expect(startStamp(today.toISOString(), now)).toBe(time.format(today));
    const monday = new Date(2026, 9, 12, 6, 55);
    expect(startStamp(monday.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
        monday,
      ),
    );
    const earlier = startStamp(new Date(2026, 8, 3, 6, 55).toISOString(), now);
    expect(earlier).toContain(time.format(new Date(2026, 8, 3, 6, 55)));
    expect(earlier).not.toContain('2026');
    expect(startStamp(new Date(2025, 8, 3, 6, 55).toISOString(), now)).toContain('2025');
  });
});

describe('listedInRecents', () => {
  const said = { id: 'a', privacy: 'standard' as const, status: 'active' as const, turnCount: 2 };

  it('leaves out ended temporary chats, which keep nothing', () => {
    expect(listedInRecents({ ...said, privacy: 'ephemeral', status: 'ended' })).toBe(false);
    expect(listedInRecents({ ...said, privacy: 'ephemeral' })).toBe(true);
    expect(listedInRecents({ ...said, status: 'ended' })).toBe(true);
  });

  it('leaves out a conversation where nothing was said, unless it is open', () => {
    expect(listedInRecents({ ...said, turnCount: 0 })).toBe(false);
    expect(listedInRecents({ ...said, turnCount: 0 }, 'a')).toBe(true);
    expect(listedInRecents({ ...said, turnCount: 0 }, 'b')).toBe(false);
  });
});

describe('groupByRecency', () => {
  const now = new Date(2026, 9, 16, 15, 0, 0);
  const at = (days: number, hour = 9) => new Date(2026, 9, 16 - days, hour, 0, 0).toISOString();
  const session = (id: string, startedAt: string, lastActivityAt: string | null = null) => ({
    id,
    startedAt,
    endedAt: null,
    lastActivityAt,
  });

  it('groups by local calendar day, newest first, and drops empty groups', () => {
    const groups = groupByRecency(
      [
        session('older', at(30)),
        session('today-early', at(0, 8)),
        session('yesterday', at(1)),
        session('today-late', at(3), at(0, 14)),
        session('week-edge', at(7, 10)),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((s) => s.id)])).toEqual([
      ['Today', ['today-late', 'today-early']],
      ['Previous 7 days', ['yesterday', 'week-edge']],
      ['Older', ['older']],
    ]);
  });

  it('returns nothing for no conversations', () => {
    expect(groupByRecency([], now)).toEqual([]);
  });

  it('uses the latest activity, then the end, then the start', () => {
    expect(lastActivity({ startedAt: at(2), endedAt: at(1), lastActivityAt: null })).toBe(Date.parse(at(1)));
    expect(lastActivity({ startedAt: at(2), endedAt: null, lastActivityAt: at(0) })).toBe(Date.parse(at(0)));
  });
});
