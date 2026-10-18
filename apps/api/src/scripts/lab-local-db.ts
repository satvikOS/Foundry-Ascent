/**
 * The conversation lab's scripts write to the lab's own database only (docs/runbooks/conversation-lab.md): a local
 * Postgres the run reset itself, never a deployed one.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Why the lab must not write to this database, or null when it is a local Postgres outside production. */
export function refusal(env: Readonly<Record<string, string | undefined>>): string | null {
  if ((env.APP_ENV ?? '').trim().toLowerCase() === 'production') return 'APP_ENV is production';
  const driver = (env.DB_DRIVER ?? 'pg').trim().toLowerCase();
  if (driver !== 'pg') return 'not a Postgres connection (DB_DRIVER)';
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return 'DATABASE_URL is not set';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'DATABASE_URL is not a URL';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'DATABASE_URL is not postgres';
  // A Unix socket (`?host=/path`) is local too.
  const socket = url.searchParams.get('host');
  const local = LOCAL_HOSTS.has(url.hostname) && (socket === null || socket.startsWith('/'));
  return local ? null : 'DATABASE_URL is not a local database';
}
