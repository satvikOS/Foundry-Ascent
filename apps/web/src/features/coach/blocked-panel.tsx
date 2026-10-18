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
  /** Server reason code (`crisis_support`, `policy`, `identity`, …); decides the explanation. */
  reason: string | null;
  /** Escalation created automatically for this turn, if any. */
  escalationId: string | null;
  /** The vEIR's name ("Corin’s vEIR", lib/veir). */
  personaName: string;
  onRequestSupport?: (() => void) | undefined;
}

const SAFETY_REASON = /safety|wellbeing|crisis|harm/i;

/** What the vEIR says when it did not answer, by reason (never blaming the founder). */
function explanation(reason: string | null, personaName: string): { title: string; body: string } {
  switch (reason) {
    case 'crisis_support':
      return {
        title: 'You deserve support from a person',
        body: 'Let’s get you to people who can help right now.',
      };
    // `policy` is what founders and teams receive for a privacy check (the specific reason stays with
    // program staff, so a held-back answer never confirms anything about other ventures).
    case 'policy':
    case 'cross_venture':
      return {
        title: 'This answer was held back',
        body: 'It failed a privacy and safety check. Ask about your own venture, or ask a person.',
      };
    case 'identity':
      return {
        title: 'This answer was held back',
        body: `${personaName} is an AI and can’t speak as a real person, so it stopped this answer. Ask again, or ask a person.`,
      };
    case 'invalid_schema':
      return {
        title: 'This answer was held back',
        body: 'No reliable answer this time. Ask again, or rephrase.',
      };
    default:
      return {
        title: 'This is one for a person',
        body: 'This needs a person with the right expertise. Asking was the right call.',
      };
  }
}

/**
 * Shown when the vEIR declines to answer and hands over to people (`turn.blocked`, live or after a
 * reload). Respectful and calm: it never blames the founder, shows the server's support message (crisis
 * resources) in full, explains what happens next and offers a direct route to a human.
 */
export function BlockedPanel({
  tenant,
  ventureId,
  supportMessage,
  reason,
  escalationId,
  personaName,
  onRequestSupport,
}: BlockedPanelProps) {
  const safety = reason !== null && SAFETY_REASON.test(reason);
  const titleId = useId();
  const { title, body } = explanation(reason, personaName);
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-border-strong bg-card p-5"
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
                  to="/$tenant/app/v/$ventureId/help"
                  params={{ tenant, ventureId }}
                  search={{ id: escalationId }}
                  // Short on screen; the name keeps what the request is for, starting with the words shown.
                  aria-label="View your request for support"
                >
                  View your request
                </Link>
              </Button>
            ) : onRequestSupport ? (
              <Button size="sm" onClick={onRequestSupport}>
                <HandHeart aria-hidden />
                Ask a person
              </Button>
            ) : null}
          </div>
          {escalationId ? (
            <p className="text-xs text-muted-foreground">
              A request was drafted. Nothing is shared until you consent.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
