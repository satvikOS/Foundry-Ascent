import type { Me } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { BrandWordmark } from '@/components/shell/brand';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

export const SECTION_LINKS = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#for-students', label: 'For students' },
  { href: '#trust', label: 'Trust' },
] as const;

/** Sign in, or the person's workspace when they are signed in. */
export function AccountPill({ me, size = 'sm' }: { me: Me | null | undefined; size?: 'sm' | 'lg' }) {
  const className = size === 'sm' ? 'pill pill--ink pill--sm' : 'pill pill--ink';
  return me ? (
    <Link to="/$tenant/app" params={{ tenant: me.tenant.slug }} className={className}>
      Open workspace
    </Link>
  ) : (
    <Link to="/sign-in" className={className}>
      Sign in
    </Link>
  );
}

/**
 * The landing page's bar: fixed, solid at rest, frosted once the page has scrolled 8 px: the bars' glass, `glass-bar` (one passive
 * scroll listener, read in an animation frame, toggles one class; no React render per scroll). Phones get the brand
 * and a menu button that opens the same links in a sheet.
 */
export function LandingNav({ me }: { me: Me | null | undefined }) {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const bar = ref.current;
    if (!bar) return undefined;
    let frame = 0;
    const read = () => {
      frame = 0;
      bar.classList.toggle('glass-bar', window.scrollY > 8);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header ref={ref} className="l-nav">
      <div className="l-wrap flex h-full items-center gap-6">
        <Link to="/" className="l-focus rounded-md" aria-label="Foundry Ascent, home">
          <BrandWordmark />
        </Link>
        <nav aria-label="Page sections" className="ml-4 hidden items-center gap-7 text-[0.9375rem] md:flex">
          {SECTION_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="l-link text-muted-foreground hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <span className="hidden sm:contents">
            <AccountPill me={me} />
          </span>
          <Sheet open={open} onOpenChange={setOpen}>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open menu"
              onClick={() => {
                setOpen(true);
              }}
            >
              <Menu aria-hidden />
            </Button>
            <SheetContent
              side="right"
              className="top-2 right-2 bottom-auto h-auto rounded-3xl border p-6 pt-14"
            >
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Sections of this page</SheetDescription>
              <nav aria-label="Page sections" className="grid gap-1 text-[1.0625rem]">
                {SECTION_LINKS.map((link) => (
                  <SheetClose asChild key={link.href}>
                    <a href={link.href} className="l-focus flex min-h-11 items-center rounded-lg px-2">
                      {link.label}
                    </a>
                  </SheetClose>
                ))}
              </nav>
              <div className="mt-6 grid">
                <AccountPill me={me} size="lg" />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
