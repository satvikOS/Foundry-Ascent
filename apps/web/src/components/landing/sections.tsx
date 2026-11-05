import type { Me } from '@foundry/contracts';
import { ArrowRight, Bot, Check, Lock, PauseCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { BrandMark } from '@/components/shell/brand';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { cn } from '@/lib/utils';

import { VoiceDemo } from './device-ad/voice-demo';
import { CoachFragment, DiagnoseFragment, RecordFragment, VentureFragment } from './fragments';
import { AccountPill } from './landing-nav';
import { useReveals } from './use-reveals';

function Arrow() {
  return <ArrowRight aria-hidden className="size-4" />;
}

/** The program its students are on (the Ain Foundry roadmap): three modules, with EIR sessions in each. */
const PROGRAM = [
  { step: 'Module 1', name: 'Business Model Canvas' },
  { step: 'Module 2', name: 'The Perfect Pitch' },
  { step: 'Module 3', name: 'The Business Plan' },
  { step: 'Every module', name: 'EIR Foundry Sessions' },
] as const;

function ProgramStrip() {
  return (
    <section id="program" aria-labelledby="program-title" className="l-wrap pt-16 pb-4 sm:pt-24">
      <h2 id="program-title" data-reveal className="text-center text-[1.125rem] text-muted-foreground">
        For students on the Ain Foundry path
      </h2>
      <ul className="l-strip mt-8 grid border-y border-border md:grid-cols-4">
        {PROGRAM.map((item, index) => (
          <li
            key={item.name}
            data-reveal
            style={{ '--stagger': index } as CSSProperties}
            className="grid gap-1.5 px-2 py-5 text-center md:px-6 md:py-7"
          >
            <span className="l-eyebrow text-muted-foreground">{item.step}</span>
            <span className="text-[1.0625rem]">{item.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SplitBand() {
  return (
    <section aria-labelledby="voice-title" className="pt-(--section-y)">
      <div className="grid md:min-h-[32.5rem] md:grid-cols-2">
        <div className="art art--moss grain flex flex-col justify-end gap-6 px-(--gutter) py-14 md:px-14 md:py-16">
          <span aria-hidden className="art-grid" />
          <h2
            id="voice-title"
            data-reveal
            className="l-h2 max-w-[12ch] text-[clamp(2.25rem,1.5rem+2.4vw,3.75rem)] leading-none"
          >
            Talk it out loud.
          </h2>
          <p data-reveal className="l-body max-w-[30rem] text-foreground">
            Call your vEIR, interrupt it, think out loud. Your words stay on screen as captions.
          </p>
          <div data-reveal>
            <a href="#see-a-session" className="pill pill--ink">
              See a call
            </a>
          </div>
        </div>
        <div className="art art--voice grain grid min-h-[22rem] place-items-center py-12">
          <VoiceDemo />
        </div>
      </div>
    </section>
  );
}

interface LoopCard {
  eyebrow: string;
  title: string;
  body: string;
  tone: 'ink' | 'black' | 'light';
  fragment: ReactNode;
}

function SessionLoop() {
  const cards: LoopCard[] = [
    {
      eyebrow: 'Diagnose',
      title: 'It asks before it answers.',
      body: 'Your vEIR finds out where the venture stands first, one sharp question at a time.',
      tone: 'ink',
      fragment: <DiagnoseFragment />,
    },
    {
      eyebrow: 'Coach',
      title: 'It argues with your evidence, kindly.',
      body: 'Answers cite your own notes and documents, and say what is fact, inference or hunch.',
      tone: 'black',
      fragment: <CoachFragment />,
    },
    {
      eyebrow: 'Record',
      title: 'It remembers what you decided.',
      body: 'Decisions, experiments and actions carry into the next session. Read, correct or delete any of it.',
      tone: 'light',
      fragment: <RecordFragment />,
    },
  ];
  return (
    <section id="how-it-works" aria-labelledby="loop-title" className="l-section bg-(--band-warm)">
      <div className="l-wrap">
        <h2 id="loop-title" data-reveal className="l-h2 max-w-[18ch]">
          How a session works
        </h2>
        <ol className="mt-12 grid gap-6 md:mt-16 md:gap-10">
          {cards.map((card, index) => (
            <li
              key={card.eyebrow}
              style={{ '--i': index } as CSSProperties}
              className={cn(
                'l-stack-card grid gap-10 p-6 md:grid-cols-[5fr_6fr] md:items-center md:p-14',
                `l-card--${card.tone}`,
                card.tone === 'light' ? 'l-scheme-light' : 'l-scheme-dark',
              )}
            >
              <div className="grid content-start gap-5">
                <p className="l-eyebrow opacity-80">{card.eyebrow}</p>
                <h3 className="l-h2">{card.title}</h3>
                <p className="l-body max-w-[30rem] opacity-85">{card.body}</p>
              </div>
              <div className="min-w-0">{card.fragment}</div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const VENTURES = [
  {
    id: 'software',
    name: 'Software',
    lead: 'Tests demand before you build.',
    points: ['Cites your interview notes', 'Flags claims with thin evidence'],
  },
  {
    id: 'services',
    name: 'Services',
    lead: 'Tracks what you promised.',
    points: ['Actions with due dates', 'Decisions you can correct'],
  },
  {
    id: 'marketplaces',
    name: 'Marketplaces',
    lead: 'Both sides, one question at a time.',
    points: ['Says what is fact, inference or hunch', 'Remembers your experiments'],
  },
  {
    id: 'spinouts',
    name: 'University spinouts',
    lead: 'Knows when you need a person.',
    points: ['Routes IP and licensing questions to people', 'Shares only with your consent'],
  },
  {
    id: 'regulated',
    name: 'Regulated products',
    lead: 'Careful with claims that need proof.',
    points: ['Routes regulatory and clinical questions to people', 'Private to your venture'],
  },
] as const;

type VentureId = (typeof VENTURES)[number]['id'];

function Ventures() {
  const [open, setOpen] = useState<VentureId>('software');
  const base = useId();
  return (
    <section id="for-students" aria-labelledby="ventures-title" className="l-section">
      <div className="l-wrap">
        <h2 id="ventures-title" data-reveal className="l-h2 text-center">
          For every kind of venture
        </h2>
        <div className="mt-12 grid gap-10 md:mt-16 lg:grid-cols-[minmax(0,40rem)_minmax(0,1fr)] lg:gap-20">
          <div
            data-reveal
            className="l-venture-card art relative grid min-h-[24rem] place-items-center overflow-hidden p-6 sm:p-12"
          >
            <span aria-hidden className="art-grid" />
            <VentureFragment venture={open} />
          </div>
          <div className="self-center">
            {VENTURES.map((venture) => {
              const expanded = venture.id === open;
              return (
                <div key={venture.id} className="l-acc-item" data-open={expanded}>
                  <h3>
                    <button
                      type="button"
                      id={`${base}-${venture.id}`}
                      aria-expanded={expanded}
                      aria-controls={`${base}-${venture.id}-panel`}
                      onClick={() => {
                        setOpen(venture.id);
                      }}
                      className="l-focus l-h3 flex min-h-16 w-full items-center py-4 text-left"
                    >
                      {venture.name}
                    </button>
                  </h3>
                  <div
                    id={`${base}-${venture.id}-panel`}
                    role="region"
                    aria-labelledby={`${base}-${venture.id}`}
                    className="l-acc-panel"
                    inert={!expanded}
                  >
                    <div>
                      <p className="l-body text-muted-foreground">{venture.lead}</p>
                      <ul className="mt-4 mb-6 grid gap-2.5">
                        {venture.points.map((point) => (
                          <li key={point} className="flex items-start gap-2.5 text-[0.9375rem]">
                            <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
                            {point}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

const PRINCIPLES = [
  {
    title: 'Memory you can read, correct and delete',
    body: 'Nothing it keeps is hidden from you.',
    href: '#how-it-works',
  },
  {
    title: 'Evidence before eloquence',
    body: 'Thin grounding is flagged, not dressed up.',
    href: '#how-it-works',
  },
  {
    title: 'People when it matters',
    body: 'Handoffs carry your context, with your consent.',
    href: '#trust',
  },
] as const;

function Principles() {
  return (
    <section id="principles" aria-labelledby="principles-title" className="l-section pt-0">
      <div className="l-wrap">
        <h2 id="principles-title" data-reveal className="l-h2 max-w-[16ch]">
          Principles we don’t trade away
        </h2>
        <ul className="mt-12 grid gap-6 md:mt-16 md:grid-cols-3">
          {PRINCIPLES.map((item, index) => (
            <li
              key={item.title}
              data-reveal
              style={{ '--stagger': index } as CSSProperties}
              className="relative"
            >
              <div className="l-notch grid min-h-[17rem] content-start gap-4 rounded-[1.25rem] bg-(--surface-2) p-7 pb-24">
                <h3 className="l-h3">{item.title}</h3>
                <p className="l-body text-muted-foreground">{item.body}</p>
              </div>
              <a
                href={item.href}
                aria-label={`${item.title}: read more`}
                className="pill pill--outline absolute right-0 bottom-0 size-14 p-0"
              >
                <Arrow />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const TRUST = [
  { icon: Lock, label: 'Private to your venture' },
  { icon: Bot, label: 'AI, and says so when asked' },
  { icon: PauseCircle, label: 'Staff can pause a vEIR at once' },
  { icon: ShieldCheck, label: 'Built to WCAG 2.2 AA' },
] as const;

function TrustBand() {
  return (
    <section
      id="trust"
      aria-labelledby="trust-title"
      className="l-section l-scheme-dark bg-(--band-ink) text-[#f4f4f2]"
    >
      <div className="l-wrap text-center">
        <h2 id="trust-title" data-reveal className="l-h2 mx-auto max-w-[20ch]">
          Built to be trusted with early ideas
        </h2>
        <p data-reveal className="l-lead mx-auto mt-5 max-w-[40rem]">
          Each venture is isolated. Program views use aggregates only.
        </p>
        <ul className="mx-auto mt-14 grid max-w-5xl gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {TRUST.map((item, index) => (
            <li
              key={item.label}
              data-reveal
              style={{ '--stagger': index } as CSSProperties}
              className="grid justify-items-center gap-3"
            >
              <item.icon aria-hidden className="size-6 opacity-80" strokeWidth={1.5} />
              <span className="max-w-[18ch] text-[0.9375rem]">{item.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinalCta({ me }: { me: Me | null | undefined }) {
  return (
    <section
      aria-labelledby="cta-title"
      className="art art--cta grain grid min-h-[35rem] place-items-center px-(--gutter) py-20 text-center"
    >
      <div className="grid justify-items-center gap-8">
        <h2 id="cta-title" data-reveal className="l-cta-display max-w-[14ch]">
          Bring your next decision.
        </h2>
        <div data-reveal>
          <AccountPill me={me} size="lg" />
        </div>
        <p data-reveal className="text-small text-foreground">
          No access code? Ask your Ain Foundry program lead.
        </p>
      </div>
    </section>
  );
}

const FOOTER = [
  {
    label: 'Product',
    links: [
      { href: '#see-a-session', text: 'See a session' },
      { href: '#how-it-works', text: 'How it works' },
      { href: '/sign-in', text: 'Sign in' },
    ],
  },
  {
    label: 'Program',
    links: [
      { href: '#program', text: 'Ain Foundry path' },
      { href: '#for-students', text: 'For students' },
    ],
  },
  {
    label: 'Trust',
    links: [
      { href: '#principles', text: 'Principles' },
      { href: '#trust', text: 'Privacy' },
    ],
  },
] as const;

function Footer() {
  return (
    <footer className="l-scheme-dark bg-(--band-ink) text-[#f4f4f2]">
      <div className="l-wrap grid gap-14 pt-20 pb-10 md:grid-cols-[1fr_auto]">
        <BrandMark className="size-12" label="Foundry Ascent" />
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-10 sm:grid-cols-3 md:gap-x-20">
          {FOOTER.map((group) => (
            <div key={group.label}>
              <h2 className="text-[0.75rem] font-medium text-[#a6a6a3]">{group.label}</h2>
              <ul className="mt-4 grid gap-3">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} className="l-link text-[0.9375rem]">
                      {link.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/10 pt-6 text-small text-[#a6a6a3] md:col-span-2">
          <p>All data shown is synthetic.</p>
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </div>
      </div>
    </footer>
  );
}

/**
 * Everything under the landing page's hero (its own chunk). One observer reveals each part once as it arrives;
 * a link to a part of the page that was not loaded yet is followed once it is.
 */
export default function LandingSections({ me }: { me: Me | null | undefined }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useReveals(ref, true);
  useEffect(() => {
    const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    if (target && target.getBoundingClientRect().top > window.innerHeight)
      target.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <div ref={ref}>
      <ProgramStrip />
      <SplitBand />
      <SessionLoop />
      <Ventures />
      <Principles />
      <TrustBand />
      <FinalCta me={me} />
      <Footer />
    </div>
  );
}
