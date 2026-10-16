import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { ProductPreview } from '@/components/landing/product-preview';
import { BrandWordmark } from '@/components/shell/brand';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { sessionHint } from '@/lib/storage';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: 'A venture coach that remembers' }] }),
  component: LandingPage,
});

const LANDING_DISCLOSURE =
  'Every vEIR is an AI, built with consent from an EIR’s approved doctrine and style. It is not the EIR and never speaks for them. Everything in this environment is synthetic.';

const PILLARS: { title: string; body: string; detail: string }[] = [
  {
    title: 'It remembers you',
    body: 'Your vEIR picks up where you left off: the decisions you made, the experiments you ran, the interviews you promised to do.',
    detail:
      'Nothing becomes memory until someone on your team approves it, and every note it keeps is yours to read, correct or delete.',
  },
  {
    title: 'Evidence before eloquence',
    body: 'Substantive answers cite your documents and confirmed memory, and say plainly what is fact, inference or a hunch.',
    detail: 'Unsupported claims are downgraded automatically; thin grounding is flagged, never papered over.',
  },
  {
    title: 'People when it matters',
    body: 'Legal, IP, investment, clinical and wellbeing questions go to people — EIRs, program staff or specialists — with a prepared packet.',
    detail: 'Packets are prioritised and shared only with the founder’s consent.',
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Bring your context',
    body: 'Upload pitch notes, interview summaries and plans. They are indexed privately for your venture only.',
  },
  {
    title: 'Talk it through',
    body: 'Type or call. Your vEIR diagnoses, challenges, teaches or rehearses with you, one sharp question at a time.',
  },
  {
    title: 'Keep what matters',
    body: 'Approve what is worth remembering, correct anything that is off, and see where every item came from.',
  },
  {
    title: 'Bring in a human',
    body: 'When judgment, risk or expertise calls for it, hand off to the right person with the context they need.',
  },
];

const PRINCIPLES: { title: string; body: string }[] = [
  {
    title: 'Amplify, never impersonate',
    body: 'A vEIR speaks in an EIR’s approved style, with consent. It never claims to be them, to be live, or to have their endorsement.',
  },
  {
    title: 'Venture-private by default',
    body: 'Each venture is isolated in the application and in the database. Program views use aggregates only.',
  },
  {
    title: 'Human authority',
    body: 'Program staff can pause a vEIR for one venture, or everywhere, instantly.',
  },
  {
    title: 'Memory you can see',
    body: 'Everything a vEIR remembers is visible, sourced and correctable by the venture team.',
  },
  {
    title: 'Synthetic data only',
    body: 'This environment contains synthetic ventures and identities. No real founder data is used.',
  },
  {
    title: 'Accessible by design',
    body: 'Built to WCAG 2.2 AA: full keyboard use, screen-reader support, visible focus and reduced motion.',
  },
];

function SectionIntro({ label, title, id }: { label: string; title: string; id: string }) {
  return (
    <div className="max-w-2xl">
      <p className="label-mono">{label}</p>
      <h2 id={id} className="mt-4 font-serif text-heading font-normal sm:text-[2.25rem] sm:leading-[1.1]">
        {title}
      </h2>
    </div>
  );
}

function LandingPage() {
  const hasHint = sessionHint.get();
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: hasHint });

  const primaryCta = me ? (
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
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/65">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            to="/"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <BrandWordmark />
          </Link>
          <nav aria-label="Page sections" className="ml-6 hidden items-center gap-1 text-small md:flex">
            {[
              ['#promise', 'Promise'],
              ['#how-it-works', 'How it works'],
              ['#principles', 'Trust & safety'],
            ].map(([href, label]) => (
              <a
                key={href}
                className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                href={href}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {me ? (
              <Button asChild size="sm">
                <Link to="/$tenant/app" params={{ tenant: me.tenant.slug }}>
                  Open workspace
                </Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="secondary">
                <Link to="/sign-in">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        <section aria-labelledby="hero-title" className="relative overflow-hidden">
          <div aria-hidden className="bg-grid mask-radial pointer-events-none absolute inset-0 opacity-70" />
          <div className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-16 px-4 pt-16 pb-24 sm:px-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:pt-28 lg:pb-32">
            <div className="min-w-0">
              <p className="label-mono">Venture coaching for student founders</p>
              <h1
                id="hero-title"
                data-page-title
                tabIndex={-1}
                className="mt-6 font-serif text-display font-normal text-balance outline-none"
              >
                A venture coach that <em className="italic">remembers</em> you, cites its evidence, and knows
                when to call a human.
              </h1>
              <p className="mt-8 max-w-[56ch] text-[1.0625rem] leading-relaxed text-muted-foreground">
                Foundry Ascent gives every venture a <span className="text-foreground">vEIR</span> — an AI
                built from an entrepreneur-in-residence’s approved doctrine and style — grounded in your own
                documents and decisions, with memory you approve and a clear path to the people who can help.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                {primaryCta}
                <Button asChild size="lg" variant="ghost">
                  <a href="#how-it-works">How it works</a>
                </Button>
              </div>
              <DisclosureBanner variant="inline" className="mt-12 max-w-xl" text={LANDING_DISCLOSURE} />
            </div>
            <ProductPreview className="mx-auto w-full max-w-md lg:max-w-none" />
          </div>
        </section>

        <section id="promise" aria-labelledby="promise-title" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
            <SectionIntro
              id="promise-title"
              label="The promise"
              title="Coaching that compounds, not chat that forgets."
            />
            <ul className="mt-16 grid gap-12 md:grid-cols-3 md:gap-10">
              {PILLARS.map((pillar, index) => (
                <li key={pillar.title} className="border-t border-border-strong pt-6">
                  <p className="tabular font-mono text-caption text-muted-foreground">0{index + 1}</p>
                  <h3 className="mt-3 text-subheading font-semibold">{pillar.title}</h3>
                  <p className="mt-3 text-body text-muted-foreground">{pillar.body}</p>
                  <p className="mt-4 text-small text-muted-foreground">{pillar.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="how-it-works"
          aria-labelledby="how-title"
          className="scroll-mt-20 border-t border-border bg-card/40"
        >
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
            <SectionIntro
              id="how-title"
              label="How it works"
              title="From a question to a decision you can defend."
            />
            <ol className="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="tabular font-serif text-[2.5rem] leading-none text-muted-foreground">
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-semibold">{step.title}</h3>
                  <p className="mt-2 text-small text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="principles"
          aria-labelledby="principles-title"
          className="scroll-mt-20 border-t border-border"
        >
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
            <SectionIntro
              id="principles-title"
              label="Trust & safety"
              title="Principles we don’t trade away."
            />
            <ul className="mt-16 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {PRINCIPLES.map((principle) => (
                <li key={principle.title} className="border-t border-border pt-5">
                  <h3 className="font-semibold">{principle.title}</h3>
                  <p className="mt-2 text-small text-muted-foreground">{principle.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="cta-title" className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-4 py-20 sm:px-6 md:flex-row md:items-end">
            <div>
              <h2 id="cta-title" className="font-serif text-heading font-normal">
                Have an access code?
              </h2>
              <p className="mt-2 text-muted-foreground">
                Your program lead issues one per person. It’s shown once.
              </p>
            </div>
            {primaryCta}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-small text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <BrandWordmark className="text-sm text-foreground" />
          <p>All ventures, people and documents in this environment are synthetic.</p>
        </div>
      </footer>
    </div>
  );
}
