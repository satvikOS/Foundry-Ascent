import type { EvidenceItem, TurnView } from '@foundry/contracts';
import {
  CircleHelp,
  FileText,
  Flag,
  ListChecks,
  MessageSquareQuote,
  Siren,
  Sparkles,
  Swords,
  Target,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/ui/markdown';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  ESCALATION_CATEGORY_LABELS,
  MEMORY_TYPE_LABELS,
  MODE_LABELS,
  REQUESTED_ROLE_LABELS,
} from '@/lib/labels';
import { cn } from '@/lib/utils';

function Block({
  title,
  icon: Icon,
  children,
  meta,
}: {
  title: string;
  icon: typeof Flag;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Icon aria-hidden className="size-3.5" />
        {title}
        {meta !== undefined ? <span className="font-medium normal-case">{meta}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function EvidenceKey({ id }: { id: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const target = document.getElementById(`evidence-${id}`);
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target?.focus({ preventScroll: true });
      }}
      className="mx-0.5 inline-flex h-5 items-center rounded-sm border border-border-strong px-1 align-baseline font-mono text-[11px] font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`Show evidence ${id}`}
    >
      {id}
    </button>
  );
}

const UNCERTAINTY_LABEL = { low: 'Low', medium: 'Medium', high: 'High' } as const;

/**
 * Read-only rendering of a turn's structured response for blind calibration review. It shows the
 * founder's message and the coach's full response contract, but never who asked, the session, the
 * model or the cost — reviewers judge the answer, not the context around it.
 */
export function StructuredResponse({ turn }: { turn: TurnView }) {
  const response = turn.response;
  const mode = MODE_LABELS[turn.mode];

  return (
    <div className="grid gap-6">
      <DisclosureBanner variant="inline" />

      <Block title="Founder message" icon={MessageSquareQuote}>
        <blockquote className="rounded-lg border-l-2 border-border-strong bg-muted/50 px-4 py-3 text-sm whitespace-pre-wrap">
          {turn.founderText}
        </blockquote>
      </Block>

      {response === null ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-muted-foreground">
          This turn has no structured response (status: {turn.status}). Score what the founder saw — for a
          blocked turn, that is the safety message and any escalation.
        </p>
      ) : (
        <>
          <Block title="Answer" icon={Sparkles} meta={<Badge variant="outline">{mode.label} mode</Badge>}>
            <div className="rounded-lg border border-border px-4 py-3">
              <Markdown renderCitation={(key) => <EvidenceKey id={key} />}>{response.answer}</Markdown>
            </div>
          </Block>

          {response.claims.length > 0 ? (
            <Block title="Claims" icon={ListChecks} meta={response.claims.length}>
              <ul className="grid gap-2">
                {response.claims.map((claim, i) => (
                  <li
                    key={i}
                    className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 sm:flex-row sm:items-start"
                  >
                    <StatusBadge kind="claim" status={claim.kind} withTitle className="sm:mt-0.5" />
                    <span className="flex-1 text-sm">
                      {claim.text}
                      {claim.evidence_ids.map((id) => (
                        <EvidenceKey key={id} id={id} />
                      ))}
                      {claim.kind === 'fact' && claim.evidence_ids.length === 0 ? (
                        <span className="ml-1 text-xs font-medium text-warning">(no evidence cited)</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}

          {response.challenge ? (
            <Block title="Challenge" icon={Swords}>
              <p className="rounded-lg border border-border px-4 py-3 text-sm">{response.challenge}</p>
            </Block>
          ) : null}

          {response.uncertainty.length > 0 ? (
            <Block title="Uncertainty" icon={CircleHelp}>
              <ul className="grid gap-1.5 text-sm">
                {response.uncertainty.map((u, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Badge variant="outline" className="mt-0.5">
                      {UNCERTAINTY_LABEL[u.level]}
                    </Badge>
                    <span>{u.item}</span>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}

          {response.next_actions.length > 0 ? (
            <Block title="Next actions" icon={Target}>
              <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
                {response.next_actions.map((a, i) => (
                  <li key={i}>
                    {a.action}{' '}
                    <span className="text-muted-foreground">
                      — {a.owner}
                      {a.target_date ? `, by ${a.target_date}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </Block>
          ) : null}

          <Block title="Escalation" icon={Siren}>
            {response.escalation.required ? (
              <div className="grid gap-1.5 rounded-lg border border-border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  {response.escalation.priority ? (
                    <StatusBadge kind="escalationPriority" status={response.escalation.priority} />
                  ) : null}
                  {response.escalation.category ? (
                    <Badge variant="secondary">
                      {ESCALATION_CATEGORY_LABELS[response.escalation.category]}
                    </Badge>
                  ) : null}
                  {response.escalation.requested_role ? (
                    <span className="text-muted-foreground">
                      to{' '}
                      {REQUESTED_ROLE_LABELS[response.escalation.requested_role] ??
                        response.escalation.requested_role}
                    </span>
                  ) : null}
                </div>
                {response.escalation.reason ? <p>{response.escalation.reason}</p> : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No escalation proposed.</p>
            )}
          </Block>

          {response.rehearsal ? (
            <Block title={`Rehearsal · ${response.rehearsal.counterpart}`} icon={Target}>
              <div className="grid gap-2 rounded-lg border border-border px-4 py-3 text-sm">
                <p className="italic">“{response.rehearsal.line}”</p>
                {response.rehearsal.scores.length > 0 ? (
                  <ul className="grid gap-1">
                    {response.rehearsal.scores.map((s, i) => (
                      <li key={i}>
                        <span className="font-medium">{s.criterion}</span>{' '}
                        <span className="tabular">{s.score}</span>
                        <span className="text-muted-foreground"> — {s.note}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-muted-foreground">{response.rehearsal.critique}</p>
              </div>
            </Block>
          ) : null}

          {response.follow_up_questions.length > 0 ? (
            <Block title="Follow-up questions" icon={CircleHelp}>
              <ul className="grid list-disc gap-1 pl-5 text-sm">
                {response.follow_up_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </Block>
          ) : null}

          {response.memory_candidates.length > 0 ? (
            <Block title="Proposed memory" icon={Flag} meta={response.memory_candidates.length}>
              <ul className="grid gap-1.5 text-sm">
                {response.memory_candidates.map((m, i) => (
                  <li key={i} className="rounded-lg border border-dashed border-border-strong px-3 py-2">
                    <span className="font-medium">{m.title}</span>{' '}
                    <Badge variant="muted">{MEMORY_TYPE_LABELS[m.type].label}</Badge>
                    <p className="mt-0.5 text-muted-foreground">{m.content}</p>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
        </>
      )}

      <EvidenceList items={turn.evidence} />
    </div>
  );
}

function EvidenceList({ items }: { items: readonly EvidenceItem[] }) {
  return (
    <Block title="Evidence pack" icon={FileText} meta={items.length}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evidence was retrieved for this turn.</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((item) => (
            <li
              key={item.key}
              id={`evidence-${item.key}`}
              tabIndex={-1}
              className={cn(
                'scroll-mt-24 rounded-lg border border-border px-3 py-2 text-sm outline-none',
                'focus:border-foreground focus:bg-accent/50',
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="rounded-sm border border-border-strong px-1 font-mono text-[11px] font-medium">
                  {item.key}
                </code>
                <span className="font-medium">{item.title}</span>
                <Badge variant="muted">{item.kind}</Badge>
                {item.status ? <span className="text-xs text-muted-foreground">{item.status}</span> : null}
              </div>
              <p className="mt-1 line-clamp-4 text-[13px] text-muted-foreground">{item.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}
