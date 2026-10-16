import type { CoachResponse, EscalationView, NextAction, TurnView } from '@foundry/contracts';
import { HandHelping, ShieldAlert } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { StatusBadge } from '@/components/ui/status-badge';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { EvidenceChip } from '../coach/response/evidence-chip';
import {
  MemorySuggestions,
  type CandidateBinding,
  type MemorySuggestionControls,
} from './memory-suggestions';
import { MessageActions } from './message-actions';
import { NextStepList, type NextActionControls } from './next-steps';
import { NarrowedNote, ReasoningDisclosure } from './reasoning';

/** The vEIR's own words: serif reading face, generous leading, a 60–75 character measure. */
export const ANSWER_PROSE = 'max-w-[68ch] font-serif text-[1.0625rem] leading-[1.7]';

export interface EscalationControls {
  /** A handoff already created from this answer. */
  existing: EscalationView | null;
  onRequest?: () => void;
  onView?: (escalation: EscalationView) => void;
}

export interface VeirAnswerProps {
  turn: TurnView;
  response: CoachResponse;
  personaName: string;
  /** The conversation's latest answer: its actions stay visible. */
  latest: boolean;
  /**
   * The conversation ended with a summary, which holds its next steps and what to remember: the answer is
   * shown without its own next-step and memory rows, so nothing is offered twice.
   */
  summarised?: boolean;
  canEdit: boolean;
  onOpenSource: (key: string) => void;
  onShowSources: () => void;
  nextActions: NextActionControls;
  /** Null for temporary chats (nothing is remembered from them). */
  memory: { bindings: readonly CandidateBinding[]; controls: MemorySuggestionControls } | null;
  escalation: EscalationControls;
}

/**
 * A call turn the founder spoke over: stored as completed with the reply as far as it was written and the
 * validator note `interrupted`. It reads as a normal answer, with a quiet "Interrupted on the call".
 */
export function wasInterrupted(turn: Pick<TurnView, 'channel' | 'validator'>): boolean {
  return (
    turn.channel === 'voice' &&
    (turn.validator?.notes ?? []).some((note) => note.split(':')[0] === 'interrupted')
  );
}

/**
 * One validated answer: prose with inline citations first; everything structured is either collapsed
 * (Sources & reasoning) or a compact row (next steps, memory suggestions). The handoff card is the only
 * block shown in full, because it is about safety.
 */
export function VeirAnswer({
  turn,
  response,
  personaName,
  latest,
  summarised = false,
  canEdit,
  onOpenSource,
  onShowSources,
  nextActions,
  memory,
  escalation,
}: VeirAnswerProps) {
  const evidence = useMemo(() => new Map(turn.evidence.map((item) => [item.key, item])), [turn.evidence]);
  const renderCitation = useCallback(
    (key: string) => <EvidenceChip evidenceKey={key} item={evidence.get(key)} onOpen={onOpenSource} />,
    [evidence, onOpenSource],
  );

  return (
    <div data-slot="veir-answer" className="group/answer">
      <NarrowedNote validator={turn.validator} />
      <Markdown renderCitation={renderCitation} className={ANSWER_PROSE}>
        {response.answer}
      </Markdown>
      {wasInterrupted(turn) ? (
        <p className="mt-2 text-caption text-muted-foreground">Interrupted on the call</p>
      ) : null}

      {response.rehearsal ? <Rehearsal rehearsal={response.rehearsal} personaName={personaName} /> : null}

      <ReasoningDisclosure
        response={response}
        evidence={turn.evidence}
        validator={turn.validator}
        onOpenSource={onOpenSource}
        onShowSources={onShowSources}
      />

      {response.next_actions.length > 0 && !summarised ? (
        <NextSteps actions={response.next_actions} controls={canEdit ? nextActions : null} />
      ) : null}

      <Handoff turnId={turn.id} response={response} validator={turn.validator} controls={escalation} />

      {memory && !summarised ? (
        <MemorySuggestions personaName={personaName} bindings={memory.bindings} controls={memory.controls} />
      ) : null}

      <MessageActions
        turnId={turn.id}
        copyText={response.answer}
        canRate={canEdit}
        pinned={latest}
        myRating={turn.myFeedback?.rating ?? null}
      />
    </div>
  );
}

function NextSteps({
  actions,
  controls,
}: {
  actions: readonly NextAction[];
  controls: NextActionControls | null;
}) {
  return (
    <section aria-label="Suggested next steps" className="mt-5">
      <h4 className="label-mono mb-2">Next steps</h4>
      <NextStepList actions={actions} controls={controls} />
    </section>
  );
}

function Rehearsal({
  rehearsal,
  personaName,
}: {
  rehearsal: NonNullable<CoachResponse['rehearsal']>;
  personaName: string;
}) {
  const outOf = rehearsal.scores.some((s) => s.score > 5) ? 10 : 5;
  return (
    <section aria-label="Rehearsal" className="mt-5 grid gap-3">
      <figure className="border-l-2 border-border-strong pl-4">
        <figcaption className="text-caption text-muted-foreground">
          {rehearsal.counterpart} <span className="text-subtle-foreground">(played by {personaName})</span>
        </figcaption>
        <blockquote className="mt-1 font-serif text-[1.0625rem] leading-7 italic">
          {rehearsal.line}
        </blockquote>
      </figure>
      {rehearsal.scores.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border" aria-label="Rubric scores">
          {rehearsal.scores.map((score) => {
            const value = Math.max(0, Math.min(outOf, score.score));
            return (
              <li key={score.criterion} className="grid gap-1 py-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
                <div className="flex items-center justify-between gap-2 sm:block">
                  <p className="text-small font-medium">{score.criterion}</p>
                  <p className="tabular flex items-center gap-1.5 text-caption text-muted-foreground">
                    <span aria-hidden className="flex gap-0.5">
                      {Array.from({ length: 5 }, (_, i) => (
                        <span
                          key={i}
                          className={cn(
                            'h-1 w-3 rounded-full',
                            i < Math.round((value / outOf) * 5) ? 'bg-foreground/80' : 'bg-border-strong',
                          )}
                        />
                      ))}
                    </span>
                    <span className="sr-only">{`${score.score} out of ${outOf}`}</span>
                    <span aria-hidden>{`${score.score} / ${outOf}`}</span>
                  </p>
                </div>
                <p className="text-small text-muted-foreground">{score.note}</p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {rehearsal.critique ? (
        <div>
          <h4 className="label-mono mb-1.5">Critique</h4>
          <Markdown size="sm">{rehearsal.critique}</Markdown>
        </div>
      ) : null}
    </section>
  );
}

function Handoff({
  turnId,
  response,
  validator,
  controls,
}: {
  turnId: string;
  response: CoachResponse;
  validator: TurnView['validator'];
  controls: EscalationControls;
}) {
  const proposal = response.escalation;
  const existing = controls.existing;
  if (!proposal.required && !existing) return null;
  return (
    <section
      aria-labelledby={`handoff-${turnId}`}
      data-testid="escalation-suggestion"
      className="mt-5 rounded-xl border border-border-strong p-4"
    >
      <div className="flex items-start gap-3">
        <HandHelping aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h4 id={`handoff-${turnId}`} className="text-[0.9375rem] font-semibold">
            A person should weigh in on this
          </h4>
          {proposal.reason ? (
            <p className="mt-1 text-small text-muted-foreground">{proposal.reason}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-caption">
            {proposal.priority ? <StatusBadge kind="escalationPriority" status={proposal.priority} /> : null}
            {proposal.category ? (
              <span className="font-medium">{ESCALATION_CATEGORY_LABELS[proposal.category]}</span>
            ) : null}
            {proposal.requested_role ? (
              <span className="text-muted-foreground">
                Suggested: {REQUESTED_ROLE_LABELS[proposal.requested_role] ?? proposal.requested_role}
              </span>
            ) : null}
          </div>
          {validator?.escalationForced ? (
            <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
              <ShieldAlert aria-hidden className="size-3.5" />
              Needs a person’s expertise.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {existing ? (
              <>
                <StatusBadge kind="escalationStatus" status={existing.status} />
                {controls.onView ? (
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
            ) : controls.onRequest ? (
              <Button size="sm" onClick={controls.onRequest}>
                Ask a person
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
