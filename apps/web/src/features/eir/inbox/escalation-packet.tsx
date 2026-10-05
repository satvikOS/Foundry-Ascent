import type { EscalationPacket, EscalationView } from '@foundry/contracts';
import { Bot, Brain, CircleHelp, FileText, Lock, Scale, Target } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

function List({ items, empty }: { items: readonly ReactNode[]; empty: string }) {
  if (items.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <ul className="grid list-disc gap-1 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Group({ title, icon: Icon, children }: { title: string; icon: typeof Bot; children: ReactNode }) {
  return (
    <section className="grid gap-3 rounded-lg border border-border px-4 py-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h3>
      <dl className="grid gap-3">{children}</dl>
    </section>
  );
}

/**
 * Escalation packet as shared by the founder. Rendered as plain text (never Markdown/HTML): the
 * packet is AI-drafted from venture content and approved by the founder for this recipient only.
 */
export function EscalationPacketView({ escalation }: { escalation: EscalationView }) {
  const packet: EscalationPacket | null = escalation.packet;
  if (!packet) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-border-strong px-4 py-4 text-sm">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid gap-1">
          <p className="font-medium">Packet not shared</p>
          <p className="text-muted-foreground">
            The founder hasn’t approved sharing the details of this escalation with you yet, so only its
            category, priority and status are visible. You’ll see the packet as soon as they approve.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Badge variant="outline">
          <Bot aria-hidden />
          AI-drafted
        </Badge>
        <span>
          Drafted by Foundry Guide and approved for sharing by the founder
          {escalation.sharingConsentAt ? ` on ${formatDateTime(escalation.sharingConsentAt)}` : ''}. Verify
          before acting.
        </span>
      </p>

      <Group title="The question" icon={CircleHelp}>
        <Item label="Founder’s question">{packet.founderQuestion}</Item>
        {packet.desiredDecision ? <Item label="Decision they need">{packet.desiredDecision}</Item> : null}
        <Item label="Why a human">{packet.reason}</Item>
        <Item label="Urgency">{packet.urgency}</Item>
      </Group>

      <Group title="What’s known" icon={Brain}>
        <Item label="Shared facts">
          <List
            items={packet.sharedFacts.map((fact) => (
              <>
                {fact.text}
                {fact.memoryId ? (
                  <span className="text-xs text-muted-foreground"> (from venture memory)</span>
                ) : null}
              </>
            ))}
            empty="No facts shared."
          />
        </Item>
        <Item label="Evidence considered">
          <List
            items={packet.evidenceConsidered.map((e) => (
              <>
                <code className="mr-1 rounded-sm border border-border-strong px-1 font-mono text-[11px]">
                  {e.key}
                </code>
                {e.title}
              </>
            ))}
            empty="No evidence listed."
          />
        </Item>
      </Group>

      <Group title="What’s uncertain" icon={Scale}>
        <Item label="Conflicting signals">
          <List items={packet.conflictingSignals} empty="None noted." />
        </Item>
        <Item label="Unknowns">
          <List items={packet.unknowns} empty="None noted." />
        </Item>
      </Group>

      {packet.proposedNextStep || packet.sessionSummary ? (
        <Group title="Context" icon={FileText}>
          {packet.proposedNextStep ? (
            <Item label="Proposed next step">
              <span className="inline-flex items-start gap-1.5">
                <Target aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                {packet.proposedNextStep}
              </span>
            </Item>
          ) : null}
          {packet.sessionSummary ? <Item label="Session summary">{packet.sessionSummary}</Item> : null}
        </Group>
      ) : null}
    </div>
  );
}
