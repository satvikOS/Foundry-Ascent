import { Bot, Check, FileText, Pencil, Send } from 'lucide-react';
import type { ReactNode } from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';

function EvidenceKey({ k }: { k: string }) {
  return (
    <span className="mx-0.5 inline-flex h-[18px] items-center rounded-[4px] border border-border-strong bg-muted px-1 align-[1px] font-mono text-[10px] font-semibold text-foreground">
      {k}
    </span>
  );
}

function FakeButton({ children, primary = false }: { children: ReactNode; primary?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium',
        primary ? 'bg-primary text-primary-foreground' : 'border border-border bg-secondary text-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * CSS-only product illustration for the landing hero: a coaching answer with labelled, cited claims,
 * a memory proposal awaiting founder approval and a suggested human escalation. Purely decorative —
 * exposed to assistive technology as a single described image. All content is synthetic.
 */
export function ProductPreview({ className }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="Illustration: a Foundry Guide answer with fact, inference and hypothesis labels citing evidence E1 and E2, a proposed decision waiting for founder approval, and a suggested P2 escalation to an EIR."
      className={cn('relative', className)}
    >
      <div
        aria-hidden
        className="absolute -inset-6 rounded-[2rem] bg-gradient-to-b from-foreground/[0.06] to-transparent blur-2xl"
      />
      <div
        aria-hidden
        className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-xl select-none motion-safe:animate-rise"
      >
        {/* window bar */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
          </span>
          <span className="ml-2 truncate text-xs font-medium text-muted-foreground">
            Helio Grid (synthetic) · Session · Diagnose
          </span>
          <span className="ml-auto">
            <StatusBadge kind="session" status="active" />
          </span>
        </div>
        <div className="flex items-center gap-2 border-b border-dashed border-border-strong bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-sm border border-border-strong bg-background px-1 text-[10px] font-semibold text-foreground uppercase">
            <Bot className="size-2.5" />
            AI
          </span>
          Foundry Guide is an AI coach, not a person.
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          <div className="ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-secondary px-3 py-2 text-[13px]">
            Should we raise a pre-seed now, or finish the paid pilot first?
          </div>

          <div className="space-y-2.5 text-[13px] leading-relaxed">
            <p>
              <span className="mr-1.5 inline-block align-middle">
                <StatusBadge kind="claim" status="fact" />
              </span>
              Two pilot sites signed letters of intent last month
              <EvidenceKey k="E1" />.
            </p>
            <p>
              <span className="mr-1.5 inline-block align-middle">
                <StatusBadge kind="claim" status="inference" />
              </span>
              Converting one LOI to paid usage would materially de-risk the round
              <EvidenceKey k="E2" />.
            </p>
            <p>
              <span className="mr-1.5 inline-block align-middle">
                <StatusBadge kind="claim" status="hypothesis" />
              </span>
              Operators will pay per site rather than per seat — untested.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { k: 'E1', t: 'Pilot LOI summary', s: 'Document · confirmed' },
              { k: 'E2', t: 'Interview notes — ops leads', s: 'Memory · confirmed' },
            ].map((e) => (
              <div
                key={e.k}
                className="flex items-start gap-2 rounded-lg border border-border bg-background/60 p-2.5"
              >
                <EvidenceKey k={e.k} />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1 text-xs font-medium">
                    <FileText className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{e.t}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">{e.s}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-dashed border-warning/50 bg-warning/[0.06] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Proposed memory · Decision</p>
              <StatusBadge kind="memory" status="proposed" />
            </div>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Finish the paid pilot before opening the pre-seed round.
            </p>
            <div className="mt-2.5 flex gap-1.5">
              <FakeButton primary>
                <Check className="size-3" />
                Approve
              </FakeButton>
              <FakeButton>
                <Pencil className="size-3" />
                Correct
              </FakeButton>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2">
              <StatusBadge kind="escalationPriority" status="P2" />
              <span className="text-xs text-muted-foreground">Valuation question → suggest an EIR</span>
            </div>
            <FakeButton>
              <Send className="size-3" />
              Review packet
            </FakeButton>
          </div>
        </div>
      </div>
    </div>
  );
}
