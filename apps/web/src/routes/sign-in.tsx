import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Brain, KeyRound, LifeBuoy, ScrollText } from 'lucide-react';

import { SignInForm } from '@/components/auth/sign-in-form';
import { DisclosureBanner } from '@/components/disclosure-banner';
import { BrandMark, BrandWordmark } from '@/components/shell/brand';
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
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside
        aria-label="About Foundry Ascent"
        className="relative hidden overflow-hidden border-r border-border bg-card lg:flex lg:flex-col"
      >
        <div aria-hidden className="bg-grid mask-radial pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex flex-1 flex-col justify-between p-10 xl:p-14">
          <Link
            to="/"
            className="w-fit rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <BrandWordmark />
          </Link>
          <div className="max-w-md space-y-8">
            <p className="text-3xl leading-tight font-semibold tracking-tight text-balance">
              Your venture’s memory, evidence and next steps — in one place.
            </p>
            <ul className="space-y-4 text-sm text-muted-foreground">
              <li className="flex gap-3">
                <Brain aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
                <span>Memory you approve, correct and can trace back to its source.</span>
              </li>
              <li className="flex gap-3">
                <ScrollText aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
                <span>
                  Every substantive answer cites evidence and labels facts, inferences and hypotheses.
                </span>
              </li>
              <li className="flex gap-3">
                <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
                <span>Clear escalation to people — shared only with your consent.</span>
              </li>
            </ul>
          </div>
          <DisclosureBanner variant="inline" className="max-w-md bg-background/60" />
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
          <div className="w-full max-w-[26rem] motion-safe:animate-rise">
            <div className="mb-8 space-y-3">
              <BrandMark className="size-10 lg:hidden" />
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-sm max-lg:hidden">
                <KeyRound aria-hidden className="size-5" />
              </div>
              <h1
                data-page-title
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none"
              >
                Sign in to Foundry Ascent
              </h1>
              <p className="text-sm text-muted-foreground">
                Use the access code from your program lead. It looks like{' '}
                <span className="font-mono whitespace-nowrap text-foreground">
                  FA-XXXXX-XXXXX-XXXXX-XXXXX
                </span>
                .
              </p>
            </div>
            <SignInForm
              onSignedIn={(me) => {
                void navigate({ href: search.redirect ?? homePath(me), replace: true });
              }}
            />
            <div className="mt-8 space-y-3 border-t border-border pt-6 text-[13px] text-muted-foreground">
              <p>
                Lost your code? Ask your program lead to issue a new one. Codes are shown once, can be revoked
                at any time, and are never stored in your browser.
              </p>
              <DisclosureBanner variant="inline" className="lg:hidden" />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
