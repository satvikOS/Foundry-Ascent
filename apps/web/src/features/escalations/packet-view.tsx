import type { EscalationView } from '@foundry/contracts';
import { Bot, Lock, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * What a request's packet says once the conversation it was drawn from was deleted and the founder never
 * shared it: the request is withdrawn and its words are erased (migration 0005, deleting a conversation).
 */
export const DELETED_CONVERSATION = '[deleted conversation]';

/** A packet whose content was erased with the conversation it came from. */
export function isErasedPacket(packet: { founderQuestion: string } | null | undefined): boolean {
  return packet?.founderQuestion === DELETED_CONVERSATION;
}

/** Who reads the brief: the founder who asked (before and after consent) or the person it went to. */
export type PacketAudience = 'founder' | 'assignee';

const LABELS: Record<PacketAudience, { question: string; decision: string; facts: string }> = {
  founder: { question: 'Your question', decision: 'Decision you want to make', facts: 'Facts you shared' },
  assignee: { question: 'Founder’s question', decision: 'Decision they need', facts: 'Shared facts' },
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="label-mono">{label}</dt>
      <dd className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Items({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="grid list-disc gap-0.5 pl-4 marker:text-subtle-foreground">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * The packet that goes with a request for a person's help. It is assembled from the request and the
 * vEIR's answer, so it is always labelled AI-drafted, and it renders as plain text (never Markdown or
 * HTML): it carries venture content to someone outside the team. Empty fields are left out.
 */
export function PacketView({
  escalation,
  audience,
  className,
}: {
  escalation: EscalationView;
  audience: PacketAudience;
  className?: string;
}) {
  const packet = escalation.packet;
  if (!packet) {
    return (
      <p className={cn('flex items-center gap-2 text-small text-muted-foreground', className)}>
        <Lock aria-hidden className="size-4 shrink-0" />
        {audience === 'assignee' ? 'Waiting for the founder to share details.' : 'Packet unavailable.'}
      </p>
    );
  }
  if (isErasedPacket(packet)) {
    return (
      <p className={cn('flex items-start gap-2 text-small text-muted-foreground', className)}>
        <Trash2 aria-hidden className="mt-0.5 size-4 shrink-0" />
        Its conversation was deleted, so its details were removed. Nothing was shared.
      </p>
    );
  }
  const labels = LABELS[audience];
  const shared = escalation.sharingConsentAt;
  // Before consent the founder picks the facts in the consent step, not here.
  const facts = shared ? packet.sharedFacts : [];

  return (
    <div className={cn('grid gap-4', className)}>
      <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-sm border border-border-strong px-1.5 leading-[18px] font-medium text-foreground">
          <Bot aria-hidden className="size-3" />
          AI-drafted
        </span>
        {shared
          ? `${audience === 'assignee' ? 'Shared by the founder' : 'Shared'} ${formatDateTime(shared)}.${audience === 'assignee' ? ' Verify before acting.' : ''}`
          : 'Review before sharing.'}
      </p>
      <dl className="grid gap-4">
        <Field label={labels.question}>{packet.founderQuestion}</Field>
        {packet.desiredDecision ? <Field label={labels.decision}>{packet.desiredDecision}</Field> : null}
        <Field label="Why a person">{packet.reason}</Field>
        <Field label="Urgency">{packet.urgency}</Field>
        {packet.sessionSummary ? <Field label="Conversation summary">{packet.sessionSummary}</Field> : null}
        {facts.length > 0 ? (
          <Field label={labels.facts}>
            <Items
              items={facts.map((fact) =>
                audience === 'assignee' && fact.memoryId ? (
                  <>
                    {fact.text}{' '}
                    <span className="text-caption text-muted-foreground">(from venture memory)</span>
                  </>
                ) : (
                  fact.text
                ),
              )}
            />
          </Field>
        ) : null}
        {packet.evidenceConsidered.length > 0 ? (
          <Field label="Evidence considered">
            <Items items={packet.evidenceConsidered.map((e) => `${e.key} · ${e.title}`)} />
          </Field>
        ) : null}
        {packet.unknowns.length > 0 ? (
          <Field label="Unknowns">
            <Items items={packet.unknowns} />
          </Field>
        ) : null}
        {packet.proposedNextStep ? <Field label="Proposed next step">{packet.proposedNextStep}</Field> : null}
      </dl>
    </div>
  );
}
