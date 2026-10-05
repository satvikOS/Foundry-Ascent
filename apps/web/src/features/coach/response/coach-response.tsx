import type {
  Claim,
  CoachResponse,
  EscalationView,
  EvidenceItem,
  MemoryCandidate,
  MemoryObjectView,
  NextAction,
  TurnView,
  ValidatorResults,
} from '@foundry/contracts';
import {
  Bookmark,
  Check,
  CircleHelp,
  CircleDot,
  HandHelping,
  ListChecks,
  MessageCircleQuestion,
  Mic,
  Pencil,
  ScanSearch,
  ShieldAlert,
  Swords,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useMemo, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatPercent } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { ConfidenceMeter, MemoryTypeLabel } from '@/features/memory/memory-meta';
import { formatIsoDate } from '@/features/memory/typed/attributes';

import { EvidenceChip } from './evidence-chip';

/*
 * Presentational renderer for one structured coach response (the CoachResponse contract). It owns no
 * data fetching: the session canvas passes the turn, the related memory/escalation state and
 * callbacks, which keeps it fully testable and lets every section degrade gracefully.
 */

export interface CandidateBinding {
  candidate: MemoryCandidate;
  /** The memory object the candidate was saved as (proposed until someone approves it). */
  memory: MemoryObjectView | null;
}

export interface MemoryCandidateControls {
  /** "loading" while memory is fetched; "ephemeral" when the session keeps no memory. */
  state: 'loading' | 'ready' | 'ephemeral';
  canEdit: boolean;
  pendingId?: string | null;
  onApprove: (memory: MemoryObjectView) => void;
  onReject: (memory: MemoryObjectView) => void;
  onEdit: (memory: MemoryObjectView) => void;
  /** Save a candidate that has no memory object yet. */
  onSave?: (candidate: MemoryCandidate) => void;
  savingTitle?: string | null;
}

export interface NextActionControls {
  /** Indexes of next actions already saved as action memory. */
  saved: ReadonlySet<number>;
  savingIndex: number | null;
  onSave?: (action: NextAction, index: number) => void;
}

export interface EscalationControls {
  /** An escalation already created from this turn. */
  existing: EscalationView | null;
  onRequest?: () => void;
  onView?: (escalation: EscalationView) => void;
}

export interface CoachResponseViewProps {
  turn: TurnView;
  response: CoachResponse;
  onOpenEvidence: (key: string) => void;
  onFollowUp?: (question: string) => void;
  /** Why follow-ups can't be sent right now (shown as a tooltip); null when they can. */
  followUpDisabledReason?: string | null;
  nextActions?: NextActionControls;
  memory?: MemoryCandidateControls;
  candidates?: CandidateBinding[];
  escalation?: EscalationControls;
  /** Feedback controls (rendered last). */
  footer?: ReactNode;
}

function Section({
  title,
  icon: Icon,
  children,
  className,
  meta,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
  meta?: ReactNode;
}) {
  return (
    <section className={cn('mt-5', className)}>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Icon aria-hidden className="size-3.5" />
        {title}
        {meta ? <span className="font-medium normal-case">{meta}</span> : null}
      </h4>
      {children}
    </section>
  );
}

/** Narrowing / downgrade notices from the deterministic validator. */
export function GroundingNotice({ validator }: { validator: ValidatorResults | null }) {
  if (!validator) return null;
  const notes: ReactNode[] = [];
  if (validator.factsDowngraded > 0) {
    notes.push(
      <li key="downgraded">
        {validator.factsDowngraded === 1
          ? '1 statement was relabelled from fact to inference because it had no supporting evidence.'
          : `${validator.factsDowngraded} statements were relabelled from fact to inference because they had no supporting evidence.`}
      </li>,
    );
  }
  if (validator.unknownEvidenceIdsRemoved > 0) {
    notes.push(<li key="removed">Citations to sources that weren’t retrieved were removed.</li>);
  }
  if (!validator.narrowed && notes.length === 0) return null;
  if (validator.narrowed) {
    return (
      <Alert
        variant="warning"
        icon={ScanSearch}
        title="Answer narrowed to what the evidence supports"
        data-testid="narrowed-banner"
        className="mb-4"
      >
        <p>
          Too little of the draft could be tied to your venture’s evidence
          {validator.groundingCoverage !== null
            ? ` (grounding ${formatPercent(validator.groundingCoverage)})`
            : ''}
          , so Foundry Guide limited its answer. Treat anything beyond the cited sources as open questions.
        </p>
        {notes.length > 0 ? <ul className="mt-1 list-disc pl-4">{notes}</ul> : null}
      </Alert>
    );
  }
  return (
    <Alert variant="info" icon={ScanSearch} title="Grounding checks adjusted this answer" className="mb-4">
      <ul className="list-disc pl-4">{notes}</ul>
    </Alert>
  );
}

function ClaimItem({
  claim,
  evidence,
  onOpenEvidence,
}: {
  claim: Claim;
  evidence: ReadonlyMap<string, EvidenceItem>;
  onOpenEvidence: (key: string) => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-start sm:gap-3">
      <span className="shrink-0 sm:mt-0.5 sm:w-[8.5rem]">
        <StatusBadge kind="claim" status={claim.kind} withTitle />
      </span>
      <p className="min-w-0 flex-1 text-sm leading-6">
        {claim.text}
        {claim.evidence_ids.length > 0 ? (
          <span className="ml-1 whitespace-nowrap">
            <span className="sr-only">Sources: </span>
            {claim.evidence_ids.map((key) => (
              <EvidenceChip key={key} evidenceKey={key} item={evidence.get(key)} onOpen={onOpenEvidence} />
            ))}
          </span>
        ) : claim.kind === 'fact' ? null : (
          <span className="ml-1.5 text-xs text-subtle-foreground">(no source cited)</span>
        )}
      </p>
    </li>
  );
}

const UNCERTAINTY: Record<'low' | 'medium' | 'high', { label: string; icon: LucideIcon; className: string }> =
  {
    high: { label: 'High', icon: TriangleAlert, className: 'border-warning/45 text-warning' },
    medium: { label: 'Medium', icon: CircleHelp, className: 'border-border-strong text-foreground' },
    low: { label: 'Low', icon: CircleDot, className: 'border-border text-muted-foreground border-dashed' },
  };

function RehearsalBlock({ rehearsal }: { rehearsal: NonNullable<CoachResponse['rehearsal']> }) {
  const outOf = rehearsal.scores.some((s) => s.score > 5) ? 10 : 5;
  return (
    <Section title="Rehearsal" icon={Mic} meta={`· ${rehearsal.counterpart}`}>
      <figure className="rounded-lg border border-border bg-muted/40 p-3">
        <figcaption className="mb-1 text-xs text-muted-foreground">
          {rehearsal.counterpart}{' '}
          <span className="text-subtle-foreground">(role played by Foundry Guide)</span>
        </figcaption>
        <blockquote className="border-l-2 border-border-strong pl-3 text-[15px] leading-7">
          {rehearsal.line}
        </blockquote>
      </figure>
      {rehearsal.scores.length > 0 ? (
        <ul className="mt-3 grid gap-2" aria-label="Rubric scores">
          {rehearsal.scores.map((score) => {
            const value = Math.max(0, Math.min(outOf, score.score));
            return (
              <li
                key={score.criterion}
                className="grid gap-1 rounded-md border border-border px-3 py-2 sm:grid-cols-[11rem_1fr]"
              >
                <div className="flex items-center justify-between gap-2 sm:block">
                  <p className="text-sm font-medium">{score.criterion}</p>
                  <p className="tabular flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className="flex gap-0.5">
                      {Array.from({ length: 5 }, (_, i) => (
                        <span
                          key={i}
                          className={cn(
                            'h-1.5 w-3 rounded-full',
                            i < Math.round((value / outOf) * 5) ? 'bg-foreground/80' : 'bg-border-strong',
                          )}
                        />
                      ))}
                    </span>
                    <span className="sr-only">{`${score.score} out of ${outOf}`}</span>
                    <span aria-hidden>{`${score.score} / ${outOf}`}</span>
                  </p>
                </div>
                <p className="text-[13px] leading-5 text-muted-foreground">{score.note}</p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {rehearsal.critique ? (
        <div className="mt-3 text-sm leading-6">
          <p className="mb-1 font-medium">Critique</p>
          <Markdown size="sm">{rehearsal.critique}</Markdown>
        </div>
      ) : null}
    </Section>
  );
}

function EscalationCard({
  turnId,
  response,
  validator,
  controls,
}: {
  turnId: string;
  response: CoachResponse;
  validator: ValidatorResults | null;
  controls: EscalationControls | undefined;
}) {
  const proposal = response.escalation;
  const existing = controls?.existing ?? null;
  if (!proposal.required && !existing) return null;
  return (
    <section
      aria-labelledby={`escalation-${turnId}-title`}
      className="mt-5 rounded-lg border border-border-strong bg-card p-4"
      data-testid="escalation-suggestion"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
          <HandHelping aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 id={`escalation-${turnId}-title`} className="text-sm font-semibold">
            A person should weigh in on this
          </h4>
          {proposal.reason ? <p className="mt-1 text-sm text-muted-foreground">{proposal.reason}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {proposal.priority ? <StatusBadge kind="escalationPriority" status={proposal.priority} /> : null}
            {proposal.category ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                {ESCALATION_CATEGORY_LABELS[proposal.category]}
              </span>
            ) : null}
            {proposal.requested_role ? (
              <span className="text-muted-foreground">
                Suggested: {REQUESTED_ROLE_LABELS[proposal.requested_role] ?? proposal.requested_role}
              </span>
            ) : null}
          </div>
          {validator?.escalationForced ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldAlert aria-hidden className="size-3.5" />
              Flagged automatically: this topic needs human expertise.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {existing ? (
              <>
                <StatusBadge kind="escalationStatus" status={existing.status} />
                {controls?.onView ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      controls.onView?.(existing);
                    }}
                  >
                    View handoff
                  </Button>
                ) : null}
              </>
            ) : controls?.onRequest ? (
              <Button size="sm" onClick={controls.onRequest}>
                <HandHelping aria-hidden />
                Request human support
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">A founder or team member can request support.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function CandidateRow({
  binding,
  controls,
}: {
  binding: CandidateBinding;
  controls: MemoryCandidateControls;
}) {
  const { candidate, memory } = binding;
  const busy = memory !== null && controls.pendingId === memory.id;
  let status: ReactNode;
  if (memory) {
    if (memory.status === 'proposed' && controls.canEdit) {
      status = (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            disabled={busy}
            onClick={() => {
              controls.onApprove(memory);
            }}
          >
            <Check aria-hidden />
            Approve
          </Button>
          <Button
            size="xs"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              controls.onReject(memory);
            }}
          >
            <X aria-hidden />
            Reject
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              controls.onEdit(memory);
            }}
          >
            <Pencil aria-hidden />
            Edit
          </Button>
        </div>
      );
    } else {
      status = <StatusBadge kind="memory" status={memory.status} />;
    }
  } else if (controls.state === 'loading') {
    status = <Skeleton className="h-6 w-28" />;
  } else if (controls.state === 'ephemeral') {
    status = <span className="text-xs text-muted-foreground">Not kept (ephemeral session)</span>;
  } else if (controls.canEdit && controls.onSave) {
    status = (
      <Button
        size="xs"
        variant="secondary"
        loading={controls.savingTitle === candidate.title}
        onClick={() => {
          controls.onSave?.(candidate);
        }}
      >
        <Bookmark aria-hidden />
        Save to memory
      </Button>
    );
  } else {
    status = <span className="text-xs text-muted-foreground">Not saved</span>;
  }

  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <MemoryTypeLabel type={memory?.type ?? candidate.type} />
          <ConfidenceMeter value={memory?.confidence ?? candidate.confidence} />
        </div>
        <p className="mt-1 text-sm font-medium [overflow-wrap:anywhere]">
          {memory?.title ?? candidate.title}
        </p>
        <p className="text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {memory?.content ?? candidate.content}
        </p>
      </div>
      <div className="shrink-0">{status}</div>
    </li>
  );
}

export function CoachResponseView({
  turn,
  response,
  onOpenEvidence,
  onFollowUp,
  followUpDisabledReason = null,
  nextActions,
  memory,
  candidates,
  escalation,
  footer,
}: CoachResponseViewProps) {
  const evidence = useMemo(() => new Map(turn.evidence.map((item) => [item.key, item])), [turn.evidence]);
  const renderCitation = useCallback(
    (key: string) => <EvidenceChip evidenceKey={key} item={evidence.get(key)} onOpen={onOpenEvidence} />,
    [evidence, onOpenEvidence],
  );
  const bindings: CandidateBinding[] =
    candidates ?? response.memory_candidates.map((candidate) => ({ candidate, memory: null }));
  const followUpsEnabled = Boolean(onFollowUp) && !followUpDisabledReason;

  return (
    <div data-slot="coach-response">
      <GroundingNotice validator={turn.validator} />

      <Markdown renderCitation={renderCitation}>{response.answer}</Markdown>

      {response.rehearsal ? <RehearsalBlock rehearsal={response.rehearsal} /> : null}

      {response.claims.length > 0 ? (
        <Section title="Claims" icon={ListChecks} meta={`· ${response.claims.length}`}>
          <ul
            className="divide-y divide-border rounded-lg border border-border px-3"
            aria-label="Claims and their sources"
          >
            {response.claims.map((claim, index) => (
              <ClaimItem
                key={`${index}-${claim.text}`}
                claim={claim}
                evidence={evidence}
                onOpenEvidence={onOpenEvidence}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {response.uncertainty.length > 0 ? (
        <Section title="What’s uncertain" icon={CircleHelp}>
          <ul className="grid gap-1.5">
            {response.uncertainty.map((u, index) => {
              const def = UNCERTAINTY[u.level];
              const Icon = def.icon;
              return (
                <li key={`${index}-${u.item}`} className="flex items-start gap-2 text-sm leading-6">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium',
                      def.className,
                    )}
                  >
                    <Icon aria-hidden className="size-3" />
                    {def.label}
                    <span className="sr-only"> uncertainty:</span>
                  </span>
                  <span>{u.item}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {response.challenge ? (
        <section
          className="mt-5 rounded-lg border-l-2 border-foreground/70 bg-muted/50 py-3 pr-4 pl-4"
          aria-label="Challenge"
        >
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <Swords aria-hidden className="size-3.5" />
            Challenge
          </p>
          <p className="text-[15px] leading-7 font-medium">{response.challenge}</p>
        </section>
      ) : null}

      {response.next_actions.length > 0 ? (
        <Section title="Next actions" icon={ListChecks}>
          <ul className="grid gap-2">
            {response.next_actions.map((action, index) => {
              const saved = nextActions?.saved.has(index) ?? false;
              return (
                <li
                  key={`${index}-${action.action}`}
                  className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{action.action}</p>
                    <p className="text-xs text-muted-foreground">
                      {action.owner ? <>Owner: {action.owner}</> : 'No owner yet'}
                      {action.target_date ? <> · Target {formatIsoDate(action.target_date)}</> : null}
                    </p>
                  </div>
                  {saved ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium">
                      <Check aria-hidden className="size-3.5 text-success" />
                      Saved as action
                    </span>
                  ) : nextActions?.onSave ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={nextActions.savingIndex === index}
                      loadingText="Saving…"
                      onClick={() => {
                        nextActions.onSave?.(action, index);
                      }}
                    >
                      <Bookmark aria-hidden />
                      Save as action
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <EscalationCard turnId={turn.id} response={response} validator={turn.validator} controls={escalation} />

      {bindings.length > 0 && memory ? (
        <Section title="Suggested for memory" icon={Bookmark} meta={`· ${bindings.length}`}>
          <p className="mb-1 text-[13px] text-muted-foreground">
            Nothing here is remembered until someone approves it.
          </p>
          <ul className="divide-y divide-border" aria-label="Memory suggestions">
            {bindings.map((binding, index) => (
              <CandidateRow key={`${index}-${binding.candidate.title}`} binding={binding} controls={memory} />
            ))}
          </ul>
        </Section>
      ) : null}

      {response.follow_up_questions.length > 0 ? (
        <Section title="Follow-up questions" icon={MessageCircleQuestion}>
          <ul className="flex flex-wrap gap-2">
            {response.follow_up_questions.map((question) => (
              <li key={question}>
                <SimpleTooltip
                  content={followUpDisabledReason ?? 'Send this question'}
                  disabled={followUpsEnabled}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-auto max-w-full py-1.5 text-left whitespace-normal"
                    aria-disabled={!followUpsEnabled || undefined}
                    onClick={() => {
                      if (followUpsEnabled) onFollowUp?.(question);
                    }}
                  >
                    <MessageCircleQuestion aria-hidden />
                    {question}
                  </Button>
                </SimpleTooltip>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {footer ? <div className="mt-5 border-t border-border pt-3">{footer}</div> : null}
    </div>
  );
}
