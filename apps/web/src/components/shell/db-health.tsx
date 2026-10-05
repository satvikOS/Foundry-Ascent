import { StatusBadge } from '@/components/ui/status-badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useHealth } from '@/lib/api/hooks/health';
import { useResumingState } from '@/lib/api/resuming';
import { cn } from '@/lib/utils';

/**
 * Workspace database health for context bars: "Workspace ready" / "Waking up" / "Unavailable".
 * Live resuming state from the API client takes precedence over the (rarely refreshed) /health result.
 */
export function DbHealthIndicator() {
  const { waiting } = useResumingState();
  const health = useHealth();
  const status = waiting > 0 ? 'resuming' : health.data?.db;
  if (!status) return null;
  const label =
    status === 'awake'
      ? 'The database is awake.'
      : status === 'resuming'
        ? 'The database pauses when idle to save cost and is resuming (about 15 seconds).'
        : 'The database can’t be reached right now. Try again shortly.';
  return (
    <SimpleTooltip content={label}>
      <span
        tabIndex={0}
        className={cn(
          'rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          // The normal state is quiet on small screens; problems are always shown.
          status === 'awake' && 'hidden lg:inline-flex',
        )}
      >
        <StatusBadge kind="db" status={status} />
        <span className="sr-only">. {label}</span>
      </span>
    </SimpleTooltip>
  );
}
