import type {
  ConversationDigest,
  EscalationView,
  MemoryObjectView,
  SessionRecap,
  SessionView,
} from '@foundry/contracts';
import { Printer, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { awaitingDigest, digestDeleted, useDeleteDigest } from '@/lib/api/hooks/sessions';
import { formatDate, pluralize } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { formatIsoDate } from '@/features/memory/typed/attributes';

import { isActionSaved, useAddAction } from './actions';
import { NextStepList } from './next-steps';
import { usePanelState } from './panel-state';
import { ANSWER_PROSE } from './veir-answer';

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="label-mono">{title}</h3>
      {children}
    </section>
  );
}

interface DigestViewProps {
  session: SessionView;
  personaName: string;
  canEdit: boolean;
  memoryItems: MemoryObjectView[] | undefined;
  escalations: EscalationView[] | undefined;
  onAskPerson?: (() => void) | undefined;
}

/**
 * The end of a conversation: the digest (a short summary, commitments and open questions, written by the
 * vEIR after the conversation ends) and the recap (diagnosis, challenge, next steps and any handoff).
 * Both are AI notes, never facts. Printable, with the disclosure on paper.
 */
export function DigestView({
  session,
  personaName,
  canEdit,
  memoryItems,
  escalations,
  onAskPerson,
}: DigestViewProps) {
  const { showTab } = usePanelState();
  const { add, savingKey } = useAddAction(session.ventureId);
  const deleteDigest = useDeleteDigest();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const digest = session.digest;
  const recap = session.recap;
  const writing = awaitingDigest(session);
  const deleted = !digest && digestDeleted(session);

  if (session.privacy === 'ephemeral') {
    return (
      <section
        id="digest"
        aria-labelledby="digest-title"
        className="scroll-mt-24 border-t border-border pt-6"
      >
        <h2 id="digest-title" className="font-serif text-subheading">
          Temporary chat ended
        </h2>
        <p className="mt-1 text-small text-muted-foreground">Nothing from it was kept.</p>
      </section>
    );
  }

  const pendingSuggestions = (recap?.memory_candidate_ids ?? []).filter(
    (id) => memoryItems?.find((m) => m.id === id)?.status === 'proposed',
  ).length;
  const sessionSource = { kind: 'session' as const, id: session.id };

  return (
    <section
      id="digest"
      aria-labelledby="digest-title"
      className="grid scroll-mt-24 gap-6 border-t border-border pt-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="digest-title" className="font-serif text-subheading">
          Summary
        </h2>
        <p className="text-caption text-muted-foreground">
          Written by {personaName} (AI)
          {session.endedAt ? <> · {formatDate(session.endedAt)}</> : null}
        </p>
      </div>

      {digest ? (
        <DigestBody digest={digest} />
      ) : deleted ? (
        <p className="text-small text-muted-foreground">
          You deleted the summary. {personaName} won’t write it again.
        </p>
      ) : writing ? (
        <p className="text-small text-muted-foreground" role="status">
          {personaName} is writing a summary…
        </p>
      ) : null}

      {recap ? (
        <RecapBody
          recap={recap}
          escalations={escalations}
          sessionId={session.id}
          canEdit={canEdit}
          onAskPerson={onAskPerson}
          actionSaved={(action) => isActionSaved(memoryItems, action, sessionSource)}
          savingKey={savingKey}
          onAddAction={(action, index) => {
            void add(action, [{ ...sessionSource, label: 'Conversation recap' }], `recap:${index}`);
          }}
        />
      ) : !digest && !writing && !deleted ? (
        <p className="text-small text-muted-foreground">
          No summary for this conversation. It couldn’t be written.
        </p>
      ) : null}

      {pendingSuggestions > 0 && canEdit ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            data-print="hide"
            onClick={() => {
              showTab('review');
            }}
          >
            Review {pluralize(pendingSuggestions, 'suggestion')} to remember
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1" data-print="hide">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.print();
          }}
        >
          <Printer aria-hidden />
          Print
        </Button>
        {digest && canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2 aria-hidden />
            Delete summary
          </Button>
        ) : null}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this summary?</AlertDialogTitle>
            <AlertDialogDescription>
              {personaName} won’t use it in later conversations or write it again. The transcript stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={deleteDigest.isPending}
              onClick={() => {
                deleteDigest.mutate(session.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    toast.success('Summary deleted');
                  },
                  onError: (error) => {
                    toast.error('Couldn’t delete the summary', { description: errorMessage(error) });
                  },
                });
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function DigestBody({ digest }: { digest: ConversationDigest }) {
  return (
    <div className="grid gap-5">
      <p className={ANSWER_PROSE}>{digest.summary}</p>
      {digest.topics.length > 0 ? (
        <ul aria-label="Topics" className="flex flex-wrap gap-1.5">
          {digest.topics.map((topic) => (
            <li
              key={topic}
              className="rounded-full border border-border px-2.5 py-0.5 text-caption text-muted-foreground"
            >
              {topic}
            </li>
          ))}
        </ul>
      ) : null}
      {digest.commitments.length > 0 ? (
        <Part title="Commitments">
          <ul className="grid gap-1.5 text-small leading-6">
            {digest.commitments.map((commitment) => (
              <li key={commitment.text}>
                {commitment.text}
                {commitment.due ? (
                  <span className="tabular text-muted-foreground"> · by {formatIsoDate(commitment.due)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Part>
      ) : null}
      {digest.openQuestions.length > 0 ? (
        <Part title="Open questions">
          <ul className="grid gap-1.5 text-small leading-6">
            {digest.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </Part>
      ) : null}
    </div>
  );
}

function RecapBody({
  recap,
  escalations,
  sessionId,
  canEdit,
  onAskPerson,
  actionSaved,
  savingKey,
  onAddAction,
}: {
  recap: SessionRecap;
  escalations: EscalationView[] | undefined;
  sessionId: string;
  canEdit: boolean;
  onAskPerson?: (() => void) | undefined;
  actionSaved: (action: SessionRecap['next_actions'][number]) => boolean;
  savingKey: string | null;
  onAddAction: (action: SessionRecap['next_actions'][number], index: number) => void;
}) {
  const requested = escalations?.find((e) => e.sessionId === sessionId) ?? null;
  return (
    <div className="grid gap-5">
      <Part title="Diagnosis">
        <dl className="grid gap-2 text-small leading-6 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-4">
          <dt className="text-muted-foreground">Stage</dt>
          <dd>{recap.diagnosis.stage}</dd>
          <dt className="text-muted-foreground">Immediate constraint</dt>
          <dd>{recap.diagnosis.immediate_constraint}</dd>
          <dt className="text-muted-foreground">Riskiest assumption</dt>
          <dd>{recap.diagnosis.riskiest_assumption}</dd>
        </dl>
      </Part>
      {recap.challenge ? (
        <Part title="Challenge">
          <p className="border-l-2 border-foreground/70 pl-3 font-serif text-[1.0625rem] leading-7">
            {recap.challenge}
          </p>
        </Part>
      ) : null}
      {recap.next_actions.length > 0 ? (
        <Part title="Next steps">
          <NextStepList
            actions={recap.next_actions}
            controls={
              canEdit
                ? {
                    saved: new Set(
                      recap.next_actions.flatMap((action, index) => (actionSaved(action) ? [index] : [])),
                    ),
                    savingIndex: savingKey?.startsWith('recap:')
                      ? Number(savingKey.slice('recap:'.length))
                      : null,
                    onAdd: onAddAction,
                  }
                : null
            }
          />
        </Part>
      ) : null}
      {recap.escalation.required ? (
        <Part title="A person should weigh in">
          <div className="grid gap-2 text-small leading-6">
            <p className="flex flex-wrap items-center gap-2">
              {recap.escalation.priority ? (
                <StatusBadge kind="escalationPriority" status={recap.escalation.priority} />
              ) : null}
              {recap.escalation.category ? (
                <span className="font-medium">{ESCALATION_CATEGORY_LABELS[recap.escalation.category]}</span>
              ) : null}
              {recap.escalation.requested_role ? (
                <span className="text-muted-foreground">
                  {REQUESTED_ROLE_LABELS[recap.escalation.requested_role] ?? recap.escalation.requested_role}
                </span>
              ) : null}
            </p>
            {recap.escalation.reason ? <p>{recap.escalation.reason}</p> : null}
            {requested ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                Requested: <StatusBadge kind="escalationStatus" status={requested.status} />
              </p>
            ) : canEdit && onAskPerson ? (
              <div data-print="hide">
                <Button size="sm" variant="secondary" onClick={onAskPerson}>
                  Ask a person
                </Button>
              </div>
            ) : null}
          </div>
        </Part>
      ) : null}
    </div>
  );
}
