import '@/components/landing/landing.css';

import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { DisclosureBanner, PUBLIC_DISCLOSURE } from '@/components/disclosure-banner';
import { HeroMedia } from '@/components/landing/hero-media';
import { AccountPill, LandingNav } from '@/components/landing/landing-nav';
import { useNearViewport } from '@/components/landing/use-near-viewport';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { sessionHint } from '@/lib/storage';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: 'Foundry Ascent: think it through with your vEIR' }] }),
  component: LandingPage,
});

// Everything under the hero is its own chunk: first paint carries the bar, the heading and the device frames.
const LandingSections = lazy(() => import('@/components/landing/sections'));

/**
 * The public landing page, in the language of a calm editorial product page: a text-first hero (the heading is
 * the largest paint), the live device ad, then the program, the session loop, ventures, principles, trust and a
 * final call to sign in. The sections below the hero load when the page is idle or when they come near.
 */
function LandingPage() {
  const hasHint = sessionHint.get();
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: hasHint });
  const restRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(restRef, { rootMargin: '600px', idleMs: 1500 });
  // A link to a part of the page (in the bar, or arriving with one) loads the rest at once; it then scrolls there.
  const [linked, setLinked] = useState(() => window.location.hash.length > 1);
  useEffect(() => {
    const onHash = () => {
      setLinked(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const rest = near || linked;

  return (
    <div className="landing flex min-h-dvh flex-col">
      <LandingNav me={me} />
      <main id="main-content" tabIndex={-1} className="flex-1 pt-(--nav-height) outline-none">
        <section aria-labelledby="hero-title" className="l-wrap pt-24 pb-12 text-center sm:pt-32 sm:pb-14">
          <h1
            id="hero-title"
            data-page-title
            tabIndex={-1}
            className="l-hero mx-auto max-w-[19ch] text-balance outline-none"
          >
            Think it through with someone who <em className="italic">remembers</em>.
          </h1>
          <p className="l-lead mx-auto mt-6 max-w-[40rem] text-pretty">
            Your vEIR is the Ain Foundry entrepreneur-in-residence’s AI twin. It diagnoses before it advises,
            tests your claims against evidence, and brings in a person when it matters.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <AccountPill me={me} size="lg" />
            <a href="#see-a-session" className="pill pill--outline">
              See a session
            </a>
          </div>
          <DisclosureBanner
            variant="line"
            veirName="Every vEIR"
            text={PUBLIC_DISCLOSURE}
            className="mx-auto mt-6 max-w-[34rem]"
          />
        </section>
        <HeroMedia />
        <div ref={restRef} className="min-h-px">
          {rest ? (
            <Suspense fallback={null}>
              <LandingSections me={me} />
            </Suspense>
          ) : null}
        </div>
      </main>
    </div>
  );
}
