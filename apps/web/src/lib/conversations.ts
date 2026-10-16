import type { SessionView } from '@foundry/contracts';

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

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const dayTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const fullDayTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * When something started, as short as still tells two apart, so the time survives a narrow sidebar: "6:55
 * AM" today, "Mon 6:55 AM" in the past week, "Oct 9, 6:55 AM" this year, "Oct 9, 2025, 6:55 AM" before.
 */
export function startStamp(value: string, now: Date = new Date()): string {
  const at = new Date(value);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= startOfToday) return timeOnly.format(at);
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  if (at >= startOfWeek) return weekdayTime.format(at);
  return at.getFullYear() === now.getFullYear() ? dayTime.format(at) : fullDayTime.format(at);
}

/**
 * The name of a conversation everywhere it is listed: the server's title (from the first message the
 * classifier found ordinary, refined by distillation), else its goal, else when it started ("Conversation ·
 * 2:05 PM"), so two conversations never read the same. The client never titles a conversation from a
 * message itself: it cannot tell a crisis or high-risk message from an ordinary one.
 */
export function conversationTitle(
  session: Pick<SessionView, 'title' | 'goal' | 'privacy' | 'startedAt'>,
  now: Date = new Date(),
): string {
  const title = session.title?.trim();
  if (title) return title;
  const goal = session.goal?.trim();
  if (goal) return goal;
  return `${session.privacy === 'ephemeral' ? 'Temporary chat' : 'Conversation'} · ${startStamp(session.startedAt, now)}`;
}

/**
 * Whether a conversation belongs in the recents. Left out: an ended temporary chat (its content is erased
 * and nothing was kept) and one where nothing was said yet, unless it is the one open now.
 */
export function listedInRecents(
  session: Pick<SessionView, 'id' | 'privacy' | 'status' | 'turnCount'>,
  openId: string | null = null,
): boolean {
  if (session.privacy === 'ephemeral' && session.status === 'ended') return false;
  return session.turnCount > 0 || session.id === openId;
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
