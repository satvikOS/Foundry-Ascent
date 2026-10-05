import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  ArrowRight,
  BadgeCheck,
  Brain,
  DatabaseZap,
  Eye,
  FileStack,
  Hand,
  LifeBuoy,
  Lock,
  MessagesSquare,
  PersonStanding,
  ScrollText,
  ShieldCheck,
  UserRoundX,
  type LucideIcon,
} from 'lucide-react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { ProductPreview } from '@/components/landing/product-preview';
import { BrandWordmark } from '@/components/shell/brand';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { sessionHint } from '@/lib/storage';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: 'Persistent, evidence-grounded venture coaching' }] }),
  component: LandingPage,
});

const PILLARS: { icon: LucideIcon; title: string; body: string; detail: string }[] = [
  {
    icon: Brain,
    title: 'Persistent memory',
    body: 'Foundry Guide remembers your venture across sessions — decisions, experiments, risks and commitments — so you never start from zero.',
    detail:
      'Nothing becomes memory until a founder approves it. Every item links to its source and can be corrected, pinned or deleted.',
  },
  {
    icon: ScrollText,
    title: 'Evidence before eloquence',
    body: 'Substantive answers cite your documents and confirmed memory, and label each claim as a fact, inference, hypothesis or recommendation.',
    detail:
      'Unsupported “facts” are downgraded automatically, and thin grounding is flagged instead of papered over.',
  },
  {
    icon: LifeBuoy,
    title: 'Human-led escalation',
    body: 'Legal, IP, investment, clinical and wellbeing questions route to people — EIRs, program staff or specialists — with a prepared packet.',
    detail: 'Packets are prioritised P0–P3 and shared only with the founder’s consent.',
  },
];

const STEPS: { title: string; body: string; icon: LucideIcon }[] = [
  {
    icon: FileStack,
    title: 'Bring your context',
    body: 'Upload pitch notes, interview summaries and plans. They are indexed privately for your venture only.',
  },
  {
    icon: MessagesSquare,
    title: 'Work a session',
    body: 'Diagnose, challenge, coach, teach, rehearse or route. Each session ends with a diagnosis, evidence, a challenge and next actions.',
  },
  {
    icon: BadgeCheck,
    title: 'Approve what’s remembered',
    body: 'Review proposed memory, correct anything that’s off, and see the full history of every change.',
  },
  {
    icon: Hand,
    title: 'Bring in a human',
    body: 'When judgment, risk or expertise calls for it, hand off to the right person with the context they need.',
  },
];

const PRINCIPLES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: UserRoundX,
    title: 'Amplify, never impersonate',
    body: 'The coach is a neutral AI guide. It never claims to be, or speak for, a real person.',
  },
  {
    icon: Lock,
    title: 'Venture-private by default',
    body: 'Each venture’s workspace is isolated in the application and in the database. Program views use aggregates only.',
  },
  {
    icon: ShieldCheck,
    title: 'Human authority',
    body: 'Program staff can pause the coach for a venture, or everywhere, instantly — no engineering required.',
  },
  {
    icon: Eye,
    title: 'Memory you can see',
    body: 'Everything the coach remembers is visible, sourced and correctable by the venture team.',
  },
  {
    icon: DatabaseZap,
    title: 'Synthetic data only',
    body: 'This environment contains synthetic ventures and identities. No real founder data is used.',
  },
  {
    icon: PersonStanding,
    title: 'Accessible by design',
    body: 'Built to WCAG 2.2 AA: full keyboard use, screen-reader support, visible focus and reduced motion.',
  },
];

function LandingPage() {
  const hasHint = sessionHint.get();
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: hasHint });
  const workspaceLink = me ? (
    <Button asChild size="sm">
      <Link to="/$tenant/app" params={{ tenant: me.tenant.slug }}>
        Open workspace
        <ArrowRight aria-hidden />
      </Link>
    </Button>
  ) : (
    <Button asChild size="sm">
      <Link to="/sign-in">Sign in</Link>
    </Button>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-transparent bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/65">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            to="/"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <BrandWordmark />
          </Link>
          <nav aria-label="Page sections" className="ml-6 hidden items-center gap-1 text-sm md:flex">
            <a
              className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              href="#promise"
            >
              Promise
            </a>
            <a
              className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              href="#how-it-works"
            >
              How it works
            </a>
            <a
              className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              href="#principles"
            >
              Trust &amp; safety
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {workspaceLink}
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="relative overflow-hidden">
          <div aria-hidden className="bg-grid mask-radial pointer-events-none absolute inset-0" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border-strong to-transparent"
          />
          <div className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-14 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pt-24 lg:pb-28">
            <div className="min-w-0 motion-safe:animate-rise">
              <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
                <span aria-hidden className="size-1.5 rounded-full bg-success" />
                Text-first venture coaching
              </p>
              <h1
                id="hero-title"
                data-page-title
                tabIndex={-1}
                className="text-4xl leading-[1.05] font-semibold tracking-[-0.03em] text-balance outline-none sm:text-5xl lg:text-[3.5rem]"
              >
                A venture coach that remembers, cites its evidence, and knows when to call a human.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
                Foundry Ascent gives every venture a persistent AI coach —{' '}
                <span className="text-foreground">Foundry Guide</span> — grounded in your own documents and
                decisions, with memory you approve and a clear path to the people who can help.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {me ? (
                  <Button asChild size="lg">
                    <Link to="/$tenant/app" params={{ tenant: me.tenant.slug }}>
                      Open your workspace
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                ) : (
                  <Button asChild size="lg">
                    <Link to="/sign-in">
                      Sign in
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                )}
                <Button asChild size="lg" variant="secondary">
                  <a href="#how-it-works">How it works</a>
                </Button>
              </div>
              <DisclosureBanner
                variant="inline"
                className="mt-10 max-w-xl"
                text="Foundry Guide is an AI coach. It is not a person, and no human EIR authored or approved its responses. Everything in this environment is synthetic."
              />
            </div>
            <ProductPreview className="mx-auto w-full max-w-lg lg:max-w-none" />
          </div>
        </section>

        {/* Promise */}
        <section id="promise" aria-labelledby="promise-title" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-muted-foreground">The promise</p>
              <h2 id="promise-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                Coaching that compounds, not chat that forgets.
              </h2>
            </div>
            <ul className="mt-12 grid gap-4 md:grid-cols-3">
              {PILLARS.map((pillar) => (
                <li
                  key={pillar.title}
                  className="group flex flex-col rounded-2xl border border-border bg-card p-6 shadow-sm transition-colors hover:border-border-strong"
                >
                  <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-background">
                    <pillar.icon aria-hidden className="size-5" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold tracking-tight">{pillar.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{pillar.body}</p>
                  <p className="mt-4 border-t border-dashed border-border pt-4 text-[13px] leading-relaxed text-muted-foreground">
                    {pillar.detail}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section
          id="how-it-works"
          aria-labelledby="how-title"
          className="scroll-mt-20 border-t border-border bg-card/40"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-muted-foreground">How it works</p>
              <h2 id="how-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                From a question to a decision you can defend.
              </h2>
            </div>
            <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <li key={step.title} className="relative">
                  <div className="flex items-center gap-3">
                    <span className="tabular flex size-8 items-center justify-center rounded-full border border-border-strong bg-background text-sm font-semibold">
                      {index + 1}
                    </span>
                    <span
                      aria-hidden
                      className="hidden h-px flex-1 bg-gradient-to-r from-border-strong to-transparent lg:block"
                    />
                  </div>
                  <h3 className="mt-5 flex items-center gap-2 font-semibold tracking-tight">
                    <step.icon aria-hidden className="size-4 text-muted-foreground" />
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Principles */}
        <section
          id="principles"
          aria-labelledby="principles-title"
          className="scroll-mt-20 border-t border-border"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-muted-foreground">Trust &amp; safety</p>
              <h2 id="principles-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                Principles we don’t trade away.
              </h2>
            </div>
            <ul className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {PRINCIPLES.map((principle) => (
                <li key={principle.title} className="bg-background p-6">
                  <principle.icon aria-hidden className="size-5 text-muted-foreground" />
                  <h3 className="mt-4 font-semibold tracking-tight">{principle.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{principle.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* CTA */}
        <section aria-labelledby="cta-title" className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center">
            <div>
              <h2 id="cta-title" className="text-2xl font-semibold tracking-tight">
                Have an access code?
              </h2>
              <p className="mt-1 text-muted-foreground">
                Your program lead issues one per person. It’s shown once — keep it safe.
              </p>
            </div>
            <Button asChild size="lg">
              <Link to="/sign-in">
                Sign in
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-[13px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <BrandWordmark className="text-sm text-foreground" />
          <p>All ventures, people and documents in this environment are synthetic.</p>
        </div>
      </footer>
    </div>
  );
}
