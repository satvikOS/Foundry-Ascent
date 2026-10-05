import { Link } from '@tanstack/react-router';
import { HandHeart, Phone } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';

interface BlockedPanelProps {
  tenant: string;
  ventureId: string;
  /**
   * Server-provided support message (Markdown: crisis lines, university support). Comes from the live
   * `turn.blocked` event or, after a reload, from `TurnView.blocked`.
   */
  supportMessage: string | null;
  /** Server reason code (`crisis_support`, `cross_venture`, `identity`, …); decides the explanation. */
  reason: string | null;
  /** Escalation created automatically for this turn, if any. */
  escalationId: string | null;
  onRequestSupport?: () => void;
}

const SAFETY_REASON = /safety|wellbeing|crisis|harm/i;

/** What Foundry Guide says when it did not answer, by reason (never blaming the founder). */
function explanation(reason: string | null): { title: string; body: string } {
  switch (reason) {
    case 'crisis_support':
      return {
        title: 'You deserve support from a person',
        body: 'Foundry Guide paused the coaching so you can reach people who can help right now.',
      };
    case 'cross_venture':
      return {
        title: 'Every venture workspace is private',
        body: 'Foundry Guide can’t share or discuss other ventures, so it held back this answer. Ask about your own venture and it will help.',
      };
    case 'identity':
      return {
        title: 'This answer was held back',
        body: 'Foundry Guide is an AI coach and must never speak as a person or an EIR, so it stopped this answer. You can ask again, or request a human.',
      };
    case 'invalid_schema':
      return {
        title: 'This answer was held back',
        body: 'Foundry Guide couldn’t produce a reliable answer this time. Please ask again, or rephrase your question.',
      };
    default:
      return {
        title: 'This is one for a person',
        body: 'Foundry Guide doesn’t answer questions like this one, because a human with the right expertise should. You haven’t done anything wrong — asking was the right call.',
      };
  }
}

/**
 * Shown when Foundry Guide declines to answer and hands over to people (`turn.blocked`, live or after a
 * reload). Respectful and calm: it never blames the founder, shows the server's support message (crisis
 * resources) in full, explains what happens next and offers a direct route to a human.
 */
export function BlockedPanel({
  tenant,
  ventureId,
  supportMessage,
  reason,
  escalationId,
  onRequestSupport,
}: BlockedPanelProps) {
  const safety = reason !== null && SAFETY_REASON.test(reason);
  const titleId = useId();
  const { title, body } = explanation(reason);
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-border-strong bg-card p-5 shadow-sm"
      data-testid="blocked-panel"
      data-reason={reason ?? undefined}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
          <HandHeart aria-hidden className="size-4.5" />
        </span>
        <div className="min-w-0 space-y-2">
          <h3 id={titleId} className="text-[15px] font-semibold tracking-tight">
            {title}
          </h3>
          {supportMessage ? (
            <Markdown size="sm" className="text-foreground">
              {supportMessage}
            </Markdown>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">{body}</p>
          )}
          {safety && !supportMessage ? (
            <p className="flex items-start gap-2 text-sm leading-6">
              <Phone aria-hidden className="mt-1 size-4 shrink-0" />
              If you or someone else might be in danger right now, contact your local emergency number or
              campus safety immediately.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {escalationId ? (
              <Button asChild size="sm">
                <Link
                  to="/$tenant/app/ventures/$ventureId/escalations"
                  params={{ tenant, ventureId }}
                  search={{ id: escalationId }}
                >
                  View your support request
                </Link>
              </Button>
            ) : onRequestSupport ? (
              <Button size="sm" onClick={onRequestSupport}>
                <HandHeart aria-hidden />
                Request human support
              </Button>
            ) : null}
          </div>
          {escalationId ? (
            <p className="text-xs text-muted-foreground">
              A support request was drafted for you. Nothing is shared until you review it and give consent.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
