import { CircleAlert, DatabaseZap, Lock, RefreshCw, SearchX, WifiOff, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { errorMessage, isApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

import { Button } from './button';
import { CopyButton } from './copy-button';

interface ErrorStateProps {
  error: unknown;
  /** Override the heading. */
  title?: string;
  /** Retry handler (e.g. `query.refetch`). */
  onRetry?: () => void;
  retrying?: boolean;
  /** Extra actions (e.g. "Back to ventures"). */
  action?: ReactNode;
  className?: string;
  size?: 'default' | 'sm';
  headingLevel?: 1 | 2 | 3;
}

interface Presentation {
  icon: LucideIcon;
  title: string;
  /** Access and existence answers are definitive: calm styling, and retrying cannot change them. */
  definitive: boolean;
}

function presentation(error: unknown): Presentation {
  if (!isApiError(error)) return { icon: CircleAlert, title: 'Something went wrong', definitive: false };
  switch (error.code) {
    case 'network_error':
      return { icon: WifiOff, title: 'You appear to be offline', definitive: false };
    case 'not_found':
      return { icon: SearchX, title: 'Not found', definitive: true };
    case 'forbidden':
    case 'unauthenticated':
      return { icon: Lock, title: 'No access', definitive: true };
    case 'database_resuming':
      return { icon: DatabaseZap, title: 'Your workspace is waking up', definitive: false };
    default:
      return { icon: CircleAlert, title: 'Something went wrong', definitive: false };
  }
}

/**
 * Standard error block: plain-language message, retry, and the request ID (copyable) so support can
 * find the server log line. Never renders raw server bodies.
 */
export function ErrorState({
  error,
  title,
  onRetry,
  retrying = false,
  action,
  className,
  size = 'default',
  headingLevel = 2,
}: ErrorStateProps) {
  const { icon: Icon, title: defaultTitle, definitive } = presentation(error);
  const retry = definitive ? undefined : onRetry;
  const requestId = isApiError(error) ? error.requestId : undefined;
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card text-center',
        size === 'default' ? 'px-6 py-12' : 'px-4 py-6',
        className,
      )}
    >
      <div
        className={cn(
          'flex size-10 items-center justify-center rounded-full border',
          definitive
            ? 'border-border-strong bg-muted text-muted-foreground'
            : 'border-destructive/40 bg-destructive/10 text-destructive',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </div>
      <Heading className="text-base font-semibold tracking-tight">{title ?? defaultTitle}</Heading>
      <p className="max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
      {retry || action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {retry ? (
            <Button variant="secondary" size="sm" onClick={retry} loading={retrying} loadingText="Retrying">
              <RefreshCw aria-hidden />
              Try again
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
      {requestId ? (
        <p className="flex items-center gap-1 text-xs text-subtle-foreground">
          <span>
            Request ID <code className="font-mono">{requestId}</code>
          </span>
          <CopyButton value={requestId} label="Copy request ID" size="icon-xs" />
        </p>
      ) : null}
    </div>
  );
}
