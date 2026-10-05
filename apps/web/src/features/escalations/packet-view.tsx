import type { EscalationPacket } from '@foundry/contracts';
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

function PacketField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm leading-6 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function List({ items, empty }: { items: readonly string[]; empty: string }) {
  if (items.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <ul className="list-disc space-y-0.5 pl-4 marker:text-subtle-foreground">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * The escalation packet a human will receive. It is drafted by Foundry Guide, so it is always shown
 * with an explicit "AI-generated draft" label; the founder reviews it and chooses what to share.
 */
export function EscalationPacketView({
  packet,
  className,
  sharedOnly = false,
}: {
  packet: EscalationPacket;
  className?: string;
  /** Hide the facts list (e.g. when the consent step shows its own selection). */
  sharedOnly?: boolean;
}) {
  return (
    <div className={cn('rounded-xl border border-dashed border-border-strong bg-muted/30', className)}>
      <p className="flex items-center gap-2 border-b border-dashed border-border-strong px-4 py-2 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-sm border border-border-strong bg-background px-1.5 text-[11px] leading-[18px] font-semibold tracking-wide text-foreground uppercase">
          <Bot aria-hidden className="size-3" />
          AI-generated
        </span>
        Drafted by Foundry Guide from your session. Review it before anything is shared.
      </p>
      <dl className="grid gap-4 p-4">
        <PacketField label="Your question">{packet.founderQuestion}</PacketField>
        {packet.desiredDecision ? (
          <PacketField label="Decision you want to make">{packet.desiredDecision}</PacketField>
        ) : null}
        <PacketField label="Why a person is needed">{packet.reason}</PacketField>
        <PacketField label="Urgency">{packet.urgency}</PacketField>
        {packet.sessionSummary ? (
          <PacketField label="Session summary">{packet.sessionSummary}</PacketField>
        ) : null}
        {!sharedOnly ? (
          <PacketField label="Facts proposed for sharing">
            <List
              items={packet.sharedFacts.map((f) => f.text)}
              empty="None yet — you choose them in the consent step."
            />
          </PacketField>
        ) : null}
        <PacketField label="Evidence considered">
          <List
            items={packet.evidenceConsidered.map((e) => `${e.key} · ${e.title}`)}
            empty="No evidence attached."
          />
        </PacketField>
        <PacketField label="Conflicting signals">
          <List items={packet.conflictingSignals} empty="None noted." />
        </PacketField>
        <PacketField label="Unknowns">
          <List items={packet.unknowns} empty="None noted." />
        </PacketField>
        {packet.proposedNextStep ? (
          <PacketField label="Proposed next step">{packet.proposedNextStep}</PacketField>
        ) : null}
      </dl>
    </div>
  );
}
