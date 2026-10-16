import type { SessionView } from '@foundry/contracts';

import { formatDateTime } from './format';

/** Longest title shown for a conversation derived from its first message. */
const TITLE_MAX = 60;

/** A compact one-line title from a message: first line, whitespace collapsed, cut at a word. */
export function titleFromMessage(text: string, max = TITLE_MAX): string {
  const line = (text.split(/\r?\n/).find((part) => part.trim().length > 0) ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/**
 * The name of a conversation everywhere it is listed: its title (from the first message, refined by
 * distillation), else its goal, else the first message when known, else when it started ("Temporary chat ·
 * Oct 16, 2026, 2:05 PM"), so two conversations never read the same.
 */
export function conversationTitle(
  session: Pick<SessionView, 'title' | 'goal' | 'privacy' | 'startedAt'>,
  firstMessage?: string | null,
): string {
  const title = session.title?.trim();
  if (title) return title;
  const goal = session.goal?.trim();
  if (goal) return goal;
  const fromMessage = firstMessage ? titleFromMessage(firstMessage) : '';
  if (fromMessage) return fromMessage;
  return `${session.privacy === 'ephemeral' ? 'Temporary chat' : 'Conversation'} · ${formatDateTime(session.startedAt)}`;
}

/** When a conversation last moved: its latest turn, else when it ended or started. */
export function lastActivity(session: Pick<SessionView, 'lastActivityAt' | 'endedAt' | 'startedAt'>): number {
  return Date.parse(session.lastActivityAt ?? session.endedAt ?? session.startedAt);
}

export type RecencyGroupId = 'today' | 'week' | 'older';

export interface RecencyGroup<T> {
  id: RecencyGroupId;
  label: string;
  items: T[];
}

const GROUP_LABELS: Record<RecencyGroupId, string> = {
  today: 'Today',
  week: 'Previous 7 days',
  older: 'Older',
};

/**
 * Recents for the sidebar: newest first, grouped by the person's local calendar into Today, the
 * previous seven days and older. Empty groups are left out.
 */
export function groupByRecency<T extends Pick<SessionView, 'lastActivityAt' | 'endedAt' | 'startedAt'>>(
  sessions: readonly T[],
  now: Date = new Date(),
): RecencyGroup<T>[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
  const buckets: Record<RecencyGroupId, T[]> = { today: [], week: [], older: [] };
  const sorted = [...sessions].sort((a, b) => lastActivity(b) - lastActivity(a));
  for (const session of sorted) {
    const at = lastActivity(session);
    if (at >= startOfToday) buckets.today.push(session);
    else if (at >= startOfWeek) buckets.week.push(session);
    else buckets.older.push(session);
  }
  return (['today', 'week', 'older'] as const)
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABELS[id], items: buckets[id] }));
}
