import '@/components/landing/landing.css';

import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { SignInForm } from '@/components/auth/sign-in-form';
import { DisclosureBanner, PUBLIC_DISCLOSURE } from '@/components/disclosure-banner';
import { BrandWordmark } from '@/components/shell/brand';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { homePath, safeRedirectPath } from '@/lib/auth/guards';
import { sessionHint } from '@/lib/storage';

interface SignInSearch {
  redirect?: string | undefined;
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    redirect: safeRedirectPath(search.redirect),
  }),
  beforeLoad: async ({ context, search }) => {
    if (!sessionHint.get()) return;
    const me = await context.queryClient
      .query({ ...meQueryOptions(), staleTime: 'static' })
      .catch(() => null);
    if (me) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
      throw redirect({ href: search.redirect ?? homePath(me), replace: true });
    }
  },
  head: () => ({ meta: [{ title: 'Sign in' }] }),
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();

  return (
    <div className="app-ground grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* The landing page's art field (grain over the voice palette), inset like its hero media card. */}
      <aside
        aria-label="About Foundry Ascent"
        className="landing type-platform art art--hero grain m-3 hidden rounded-xl lg:flex lg:flex-col"
      >
        <div className="relative flex flex-1 flex-col justify-between p-10 xl:p-14">
          <Link
            to="/"
            className="w-fit rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <BrandWordmark />
          </Link>
          <div className="max-w-md">
            <p className="text-title font-semibold text-balance">Pick up where you left off.</p>
            <p className="mt-6 text-body text-muted-foreground">
              Your vEIR remembers your decisions, tests and promises. You can read and correct all of it.
            </p>
          </div>
          <DisclosureBanner variant="inline" className="max-w-md bg-background/60" text={PUBLIC_DISCLOSURE} />
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="flex h-16 items-center justify-between px-4 sm:px-6">
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeft aria-hidden />
              Home
            </Link>
          </Button>
          <ThemeToggle />
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="flex flex-1 items-center justify-center px-4 pb-16 outline-none sm:px-6"
        >
          <div className="w-full max-w-[26rem]">
            <div className="mb-8 space-y-3">
              <h1 data-page-title tabIndex={-1} className="text-title font-semibold outline-none">
                Sign in to Foundry Ascent
              </h1>
              <p className="text-small text-muted-foreground">Use the code from your program lead.</p>
            </div>
            <SignInForm
              onSignedIn={(me) => {
                void navigate({ href: search.redirect ?? homePath(me), replace: true });
              }}
            />
            <div className="mt-8 space-y-3 border-t border-border pt-6 text-small text-muted-foreground">
              <p>Lost your code? Ask your program lead for a new one.</p>
              <DisclosureBanner variant="inline" className="lg:hidden" text={PUBLIC_DISCLOSURE} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
