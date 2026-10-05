import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { ArrowLeft, Compass, Lock } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/errors';
import { isForbiddenError } from '@/lib/auth/guards';

import { documentTitle } from './route-announcer';

/** Error/404 states have no route `head`; give the tab a meaningful title anyway. */
function useStateTitle(title: string): void {
  useEffect(() => {
    document.title = documentTitle(title);
  }, [title]);
}

/** Default route error component: maps 403/404/resuming/other errors to friendly, recoverable states. */
export function RouteErrorBoundary({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const forbidden = isForbiddenError(error) || (isApiError(error) && error.status === 403);
  const notFound = isApiError(error) && error.status === 404;
  useStateTitle(forbidden ? 'No access' : notFound ? 'Not found' : 'Something went wrong');

  if (forbidden) {
    return (
      <PageContainer size="narrow">
        <EmptyState
          headingLevel={1}
          icon={Lock}
          title="You don’t have access to this area"
          description="Access is based on your role and venture membership. Ask a program lead if you think you should have access."
          action={
            <Button asChild variant="secondary">
              <Link to="/">
                <ArrowLeft aria-hidden />
                Go home
              </Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  if (notFound) return <NotFoundState />;

  return (
    <PageContainer size="narrow">
      <ErrorState
        error={error}
        headingLevel={1}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </PageContainer>
  );
}

export function NotFoundState() {
  useStateTitle('Page not found');
  return (
    <PageContainer size="narrow" className="flex min-h-[70dvh] flex-col justify-center">
      <EmptyState
        headingLevel={1}
        icon={Compass}
        title="We couldn’t find that page"
        description="The link may be out of date, or the item may have been removed or never shared with you."
        action={
          <Button asChild variant="secondary">
            <Link to="/">
              <ArrowLeft aria-hidden />
              Go home
            </Link>
          </Button>
        }
      />
    </PageContainer>
  );
}

/** Route-level pending state (shown after a short delay while loaders run). */
export function RoutePending() {
  return (
    <PageContainer aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="space-y-6" aria-hidden>
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </PageContainer>
  );
}
