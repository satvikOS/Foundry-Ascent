import { createFileRoute } from '@tanstack/react-router';

import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { PortfolioDashboard } from '@/features/program/portfolio-dashboard';
import { portfolioQueryOptions, usePortfolio } from '@/lib/api/hooks/program';

export const Route = createFileRoute('/$tenant/app/program/portfolio')({
  loader: ({ context }) => {
    context.queryClient.query(portfolioQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Portfolio' }] }),
  component: PortfolioPage,
});

function PortfolioPage() {
  const { tenant } = Route.useParams();
  const portfolio = usePortfolio();

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Portfolio"
        description="Privacy-preserving aggregates across the program. Small groups are hidden to protect individual ventures."
      />
      {portfolio.isPending ? (
        <LoadingRegion label="Loading portfolio">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-xl" />
            ))}
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
          </div>
        </LoadingRegion>
      ) : portfolio.isError ? (
        <ErrorState
          error={portfolio.error}
          onRetry={() => void portfolio.refetch()}
          retrying={portfolio.isRefetching}
        />
      ) : (
        <PortfolioDashboard summary={portfolio.data} tenant={tenant} />
      )}
    </PageContainer>
  );
}
