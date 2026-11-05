import { useMemo, type ReactNode } from 'react';

import { Markdown } from '@/components/ui/markdown';
import { Composer } from '@/features/chat/composer';
import { FounderMessage, VeirMessage } from '@/features/chat/exchange';
import { ANSWER_PROSE, VeirAnswer } from '@/features/chat/veir-answer';
import { MemoryRow } from '@/features/knowledge/memory-section';

import { AD_MEMORY, AD_RESPONSE, AD_SESSION, AD_TURN, AD_VENTURE } from './device-ad/fixtures';

const noop = () => undefined;
const PERSONA = AD_VENTURE.persona?.name ?? '';
const NO_CALLS: ReadonlySet<string> = new Set();

/**
 * A piece of the product, rendered by its real components from the synthetic session and shown as an
 * illustration: inert (nothing in it can be focused or clicked) and hidden from assistive technology, since the
 * card around it says in words what it shows.
 */
function Fragment({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div inert aria-hidden className={className ?? 'l-fragment @container/conv p-6 select-none sm:p-8'}>
      {children}
    </div>
  );
}

/** Diagnose: the student's question, and the one question the vEIR asks back. */
export function DiagnoseFragment() {
  return (
    <Fragment>
      <div className="grid gap-6">
        <FounderMessage text={AD_SESSION.question} author={AD_SESSION.founder} at={null} />
        <VeirMessage personaName={PERSONA}>
          <Markdown className={ANSWER_PROSE}>{AD_SESSION.diagnose.opener}</Markdown>
        </VeirMessage>
      </div>
    </Fragment>
  );
}

/** Coach: an answer citing the student's own evidence, then the challenge. */
export function CoachFragment() {
  const turn = useMemo(
    () => ({
      ...AD_TURN,
      response: {
        ...AD_RESPONSE,
        answer: `${AD_SESSION.coach.answer}\n\n*${AD_SESSION.coach.challenge}*`,
        next_actions: [],
      },
    }),
    [],
  );
  const nextActions = useMemo(() => ({ saved: new Set<number>(), savingIndex: null, onAdd: noop }), []);
  return (
    <Fragment>
      <VeirAnswer
        turn={turn}
        response={turn.response}
        personaName={PERSONA}
        latest={false}
        canEdit={false}
        onOpenSource={noop}
        onShowSources={noop}
        nextActions={nextActions}
        saved={null}
        escalation={{ existing: null }}
      />
    </Fragment>
  );
}

/** Record: what the venture keeps in Knowledge, a decision, an experiment and an action with its due date. */
export function RecordFragment() {
  return (
    <Fragment className="l-fragment select-none">
      <p className="section-label px-5 pt-5">Knowledge</p>
      <ul className="mt-3 divide-y divide-border border-t border-border">
        {AD_MEMORY.map((item) => (
          <li key={item.id}>
            <MemoryRow item={item} withCalls={NO_CALLS} selected={false} onSelect={noop} />
          </li>
        ))}
      </ul>
    </Fragment>
  );
}

const QUESTIONS: Record<string, string> = AD_SESSION.ventures;

/** The composer holding a student's question from the chosen kind of venture. */
export function VentureFragment({ venture }: { venture: string }) {
  return (
    <Fragment className="l-fragment w-full max-w-[32rem] p-4 select-none sm:p-5">
      <Composer
        value={QUESTIONS[venture] ?? ''}
        onChange={noop}
        personaName={PERSONA}
        mode="auto"
        onModeChange={noop}
        counterpart=""
        onCounterpartChange={noop}
        streaming={false}
        disabledReason={null}
        onSend={noop}
        onStop={noop}
      />
    </Fragment>
  );
}
