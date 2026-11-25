import type { EvidenceItem, PathStepAction, PathStepView, TurnGuidance } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  Ban,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  HandHelping,
  Signpost,
  type LucideIcon,
} from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { addDays, localIsoDay } from '@/features/chat/due-actions';
import { errorMessage } from '@/lib/api/errors';
import { currentStep, pathSteps, useUpdatePathStep, useVenturePath } from '@/lib/api/hooks/path';
import { cn } from '@/lib/utils';

import { dueState, dueWords, longDay } from './due';
import { SourceList } from './sources';
import { StepTemplate } from './template';

/** Where the step sits: its stage's name and number, and what it shows (the criterion it produces evidence for). */
export interface StepPlace {
  readonly stageTitle: string;
  readonly stageNumber: number;
  readonly stageCount: number;
}

interface StepCardProps {
  tenant: string;
  ventureId: string;
  step: PathStepView;
  place?: StepPlace | null;
  /** The titles of the steps after it. */
  then?: readonly string[];
  referral?: TurnGuidance['referral'];
  /** The reply's evidence: a source it quotes shows the passage. */
  evidence?: readonly EvidenceItem[];
  canEdit: boolean;
  /** The reply is still being written: the card shows whole, and its controls wait. */
  busy?: boolean;
  /** Shown whole; folded to one line otherwise (an older reply's), one press from whole. */
  expanded?: boolean;
  /** The card's label ("Next step"); the path page says "Now". */
  label?: string;
  /** A narrow place (the context panel, a call): the sub-steps without their how, no template and no sources. */
  dense?: boolean;
  /** It answers what they asked and is not on their path yet: adding it comes first. */
  offered?: boolean;
  /** The path's own step, still open, when this one answers what they asked instead: one quiet line. */
  pathStep?: PathStepView | null;
  headingLevel?: 2 | 3 | 4;
  onAskPerson?: (() => void) | undefined;
  className?: string;
}

type Panel = 'done' | 'later' | 'changed' | 'blocked' | 'why';

const STATUS: Record<PathStepView['status'], { label: string | null; icon: LucideIcon; tone: string }> = {
  now: { label: null, icon: Signpost, tone: 'text-muted-foreground' },
  next: { label: null, icon: Signpost, tone: 'text-muted-foreground' },
  later: { label: 'Later', icon: CircleDashed, tone: 'text-muted-foreground' },
  done: { label: 'Done', icon: CircleCheck, tone: 'text-success' },
  skipped: { label: 'Changed plan', icon: Ban, tone: 'text-muted-foreground' },
  blocked: { label: 'Blocked', icon: CirclePause, tone: 'text-warning' },
};

/** Whether the founder can still act on it. */
export function isOpenStep(step: Pick<PathStepView, 'status'>): boolean {
  return step.status !== 'done' && step.status !== 'skipped';
}

/** The step as the server makes it by `action` (`useUpdatePathStep`'s answer holds only the steps its path lists). */
function changed(step: PathStepView, action: PathStepAction): PathStepView {
  const version = step.version + 1;
  switch (action.action) {
    case 'tick':
      return {
        ...step,
        version,
        items: step.items.map((each, i) => (i === action.item ? { ...each, done: action.done } : each)),
      };
    case 'complete':
      return {
        ...step,
        version,
        status: 'done',
        evidence: action.evidence,
        completedAt: new Date().toISOString(),
      };
    case 'skip':
      return { ...step, version, status: 'skipped', evidence: action.reason };
    case 'block':
      return { ...step, version, status: 'blocked', evidence: action.reason };
    case 'reschedule':
      return { ...step, version, dueOn: action.dueOn };
    case 'add':
    case 'reopen':
      return { ...step, version, status: 'now', completedAt: null };
  }
}

/** "2 of 3", for the sub-steps ticked; null with none. */
export function tickedLine(step: Pick<PathStepView, 'items'>): string | null {
  if (step.items.length === 0) return null;
  return `${String(step.items.filter((item) => item.done).length)} of ${String(step.items.length)}`;
}

/**
 * The step the path chose, as the founder sees it under a reply, on the path page and beside a call: what to do, when
 * it counts as done and by when, the sub-steps to tick, the template and the sources, and one press for what happened
 * (Done, Not yet, Changed plan) or why this step. An older reply's is one line. Its controls save to the venture's
 * path, so the same step shows the same everywhere.
 */
export function StepCard({
  tenant,
  ventureId,
  step: given,
  place = null,
  then = [],
  referral = null,
  evidence = [],
  canEdit,
  busy = false,
  expanded = true,
  label = 'Next step',
  dense = false,
  offered = false,
  pathStep = null,
  headingLevel = 4,
  onAskPerson,
  className,
}: StepCardProps) {
  const id = useId();
  const path = useVenturePath(ventureId);
  const update = useUpdatePathStep(ventureId);
  const [unfolded, setUnfolded] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  /** What this card's own last change made of the step, kept where the path no longer lists it (a skipped step). */
  const [settled, setSettled] = useState<PathStepView | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  /** Sub-steps ticked just now, by index: they show at once, until the latest change is saved (or refused). */
  const [ticks, setTicks] = useState<Readonly<Record<number, boolean>>>({});
  /** Put on the path from this card just now. */
  const [added, setAdded] = useState(false);

  const listed = path.data ? pathSteps(path.data).some((candidate) => candidate.id === given.id) : false;
  const saved = listed ? currentStep(given, path.data) : (settled ?? given);
  const step =
    Object.keys(ticks).length === 0
      ? saved
      : { ...saved, items: saved.items.map((item, index) => ({ ...item, done: ticks[index] ?? item.done })) };
  const open = isOpenStep(step);
  const adds = offered && !added && !listed && open;
  // Offered, it waits for nothing: it is the next step of what they asked.
  const status = adds && step.status === 'later' ? STATUS.next : STATUS[step.status];
  const due = open ? dueState(step.dueOn) : null;
  const shown = expanded || unfolded;
  const Heading = `h${headingLevel}` as const;
  const detailsId = `${id}-details`;
  const titleId = `${id}-title`;

  const closePanel = () => {
    // "Blocked" is a choice of Not yet.
    const from = panel === 'blocked' ? 'later' : panel;
    setPanel(null);
    if (!from) return;
    requestAnimationFrame(() => {
      actionsRef.current?.querySelector<HTMLElement>(`[data-action="${from}"]`)?.focus();
    });
  };

  /** Saves a change; a form stays open with the founder's words until it is saved. */
  const change = (action: PathStepAction, said?: string) => {
    if (action.action === 'tick') setTicks((current) => ({ ...current, [action.item]: action.done }));
    update.mutate(
      { step: saved, update: action },
      {
        onSettled: () => {
          setTicks({});
        },
        onSuccess: (result) => {
          if (action.action === 'add') setAdded(true);
          if (!('stages' in result)) setSettled(result);
          // A step the path does not list (skipped, or offered and not added) is kept here as the change left it.
          else if (pathSteps(result).some((candidate) => candidate.id === step.id)) setSettled(null);
          else setSettled(changed(saved, action));
          if (!said) return;
          announce(said);
          setPanel(null);
          // The form that had focus is gone: the step's own controls take it.
          requestAnimationFrame(() => {
            if (document.activeElement === document.body)
              actionsRef.current?.querySelector<HTMLElement>('button')?.focus();
          });
        },
        onError: (error) => {
          toast.error('Couldn’t save that', { description: errorMessage(error) });
        },
      },
    );
  };

  const summary = (
    <>
      <status.icon aria-hidden className={cn('size-4 shrink-0', status.tone)} />
      <span className="shrink-0 text-caption text-muted-foreground">{status.label ?? label}</span>
    </>
  );

  if (!shown) {
    return (
      <section aria-labelledby={titleId} data-slot="step-card" data-state="closed" className={className}>
        <button
          type="button"
          aria-expanded={false}
          onClick={() => {
            setUnfolded(true);
          }}
          className="group/step flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        >
          {summary}
          <span id={titleId} className="min-w-0 flex-1 truncate text-small" data-slot="next-step">
            {step.title}
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      data-slot="step-card"
      data-state="open"
      data-status={step.status}
      className={cn(
        'grid gap-3 rounded-2xl border border-border-card bg-card p-4',
        dense && 'p-3.5',
        className,
      )}
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {summary}
          {place && !dense ? (
            <span className="text-caption text-subtle-foreground">
              · {place.stageTitle}
              <span className="sr-only">
                , stage {place.stageNumber} of {place.stageCount}
              </span>
            </span>
          ) : null}
          {due ? (
            <span
              className={cn(
                'tabular ml-auto text-caption font-medium',
                due.overdue ? 'text-warning' : 'text-foreground',
              )}
            >
              {due.text}
            </span>
          ) : null}
        </div>
        <Heading
          id={titleId}
          data-slot="next-step"
          className={cn('font-semibold text-balance', dense ? 'text-body' : 'text-subheading')}
        >
          {step.title}
        </Heading>
        {expanded ? null : (
          <button
            type="button"
            aria-expanded
            aria-controls={detailsId}
            onClick={() => {
              setUnfolded(false);
            }}
            className="justify-self-start rounded-sm text-caption text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Fold
          </button>
        )}
      </div>

      <div id={detailsId} className="grid gap-3">
        {step.items.length > 0 ? (
          <StepItems
            id={id}
            step={step}
            dense={dense}
            disabled={!canEdit || busy || !open}
            onTick={(item, done) => {
              change({ action: 'tick', item, done });
            }}
          />
        ) : null}

        {open ? (
          <p className="text-small text-pretty" data-slot="step-done-when">
            <span className="text-muted-foreground">Done when: </span>
            <span data-slot="next-step">{step.doneWhen}</span>
          </p>
        ) : step.evidence ? (
          <p className="text-small text-pretty" data-slot="step-evidence">
            <span className="text-muted-foreground">
              {step.completedAt ? `${longDay(step.completedAt)}: ` : 'You said: '}
            </span>
            <span data-slot="next-step">{step.evidence}</span>
          </p>
        ) : null}

        {referral ? <Referral referral={referral} onAskPerson={canEdit ? onAskPerson : undefined} /> : null}

        {open && !dense && step.template ? <StepTemplate template={step.template} /> : null}
        {dense ? null : <SourceList citations={step.citations} evidence={evidence} />}

        {panel === 'why' ? (
          <Why
            path={path.data ?? null}
            step={step}
            place={place}
            then={then}
            tenant={tenant}
            ventureId={ventureId}
          />
        ) : null}

        {panel === 'done' ? (
          <LineForm
            label="What happened, in one line"
            placeholder={step.doneWhen}
            submit="Save"
            maxLength={1000}
            pending={update.isPending}
            onCancel={closePanel}
            onSubmit={(line) => {
              change({ action: 'complete', evidence: line }, 'Step done');
            }}
          />
        ) : panel === 'changed' ? (
          <LineForm
            label="What changed"
            submit="Save"
            maxLength={300}
            pending={update.isPending}
            onCancel={closePanel}
            onSubmit={(line) => {
              change({ action: 'skip', reason: line }, 'Plan changed');
            }}
          />
        ) : panel === 'blocked' ? (
          <LineForm
            label="What’s in the way"
            submit="Save"
            maxLength={300}
            pending={update.isPending}
            onCancel={closePanel}
            onSubmit={(line) => {
              change({ action: 'block', reason: line }, 'Step blocked');
            }}
          />
        ) : panel === 'later' ? (
          <Reschedule
            pending={update.isPending}
            onCancel={closePanel}
            onPick={(dueOn) => {
              change({ action: 'reschedule', dueOn }, 'Step moved');
            }}
            onBlocked={() => {
              setPanel('blocked');
            }}
          />
        ) : null}

        {canEdit && (panel === null || panel === 'why') ? (
          <div
            ref={actionsRef}
            role="group"
            aria-label="This step"
            data-print="hide"
            className="flex flex-wrap items-center gap-1.5"
          >
            {open ? (
              <>
                {adds ? (
                  <Button
                    size="sm"
                    className="px-2.5"
                    data-action="add"
                    disabled={busy}
                    loading={update.isPending && update.variables.update.action === 'add'}
                    onClick={() => {
                      change({ action: 'add' }, 'Added');
                    }}
                  >
                    Add to my path
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={adds ? 'secondary' : undefined}
                  className="px-2.5"
                  data-action="done"
                  disabled={busy}
                  onClick={() => {
                    setPanel('done');
                  }}
                >
                  Done
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="px-2.5"
                  data-action="later"
                  disabled={busy}
                  onClick={() => {
                    setPanel('later');
                  }}
                >
                  Not yet
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2"
                  data-action="changed"
                  disabled={busy}
                  onClick={() => {
                    setPanel('changed');
                  }}
                >
                  Changed plan
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                data-action="reopen"
                disabled={busy || update.isPending}
                onClick={() => {
                  change({ action: 'reopen' }, 'Step reopened');
                }}
              >
                Reopen
              </Button>
            )}
            {open ? (
              <Button
                size="sm"
                variant="ghost"
                className="px-2"
                data-action="why"
                aria-expanded={panel === 'why'}
                onClick={() => {
                  setPanel(panel === 'why' ? null : 'why');
                }}
              >
                Why this
              </Button>
            ) : (
              <UpNext path={path.data ?? null} step={step} tenant={tenant} ventureId={ventureId} />
            )}
          </div>
        ) : null}

        {pathStep ? (
          <StillOpen
            path={path.data ?? null}
            pathStep={pathStep}
            step={step}
            tenant={tenant}
            ventureId={ventureId}
            link={!dense}
          />
        ) : null}
      </div>
    </section>
  );
}

/** The path's own step while the card answers what they asked: named once, small, until it is done. */
function StillOpen({
  path,
  pathStep: given,
  step,
  tenant,
  ventureId,
  link,
}: {
  path: ReturnType<typeof useVenturePath>['data'];
  pathStep: PathStepView;
  step: PathStepView;
  tenant: string;
  ventureId: string;
  link: boolean;
}) {
  const pathStep = currentStep(given, path);
  if (!isOpenStep(pathStep) || pathStep.id === step.id) return null;
  const when = dueWords(pathStep.dueOn);
  const title = <span data-slot="next-step">{pathStep.title}</span>;
  return (
    <p data-slot="step-path" className="text-caption text-pretty text-muted-foreground">
      Still open on your path:{' '}
      {link ? (
        <Link
          to="/$tenant/app/v/$ventureId/path"
          params={{ tenant, ventureId }}
          className="rounded-sm underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {title}
        </Link>
      ) : (
        title
      )}
      {when ? `, ${when}` : null}
    </p>
  );
}

/** The sub-steps, numbered, each ticked in one press. */
function StepItems({
  id,
  step,
  dense,
  disabled,
  onTick,
}: {
  id: string;
  step: PathStepView;
  dense: boolean;
  disabled: boolean;
  onTick: (index: number, done: boolean) => void;
}) {
  return (
    <ol aria-label="How" className="grid gap-1.5">
      {step.items.map((item, index) => {
        const inputId = `${id}-item-${String(index)}`;
        const detail = [dense ? null : item.how || null, item.minutes ? `${String(item.minutes)} min` : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={`${String(index)}-${item.do}`} className="flex min-w-0 items-start gap-1.5">
            <CheckboxPrimitive.Root
              id={inputId}
              checked={item.done}
              disabled={disabled}
              data-touch-target
              onCheckedChange={(checked) => {
                onTick(index, checked === true);
              }}
              // The box is 16 px, its target 24 (44 on touch).
              className="group/tick relative -ml-1 flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed"
            >
              <span
                aria-hidden
                className="flex size-4 items-center justify-center rounded-[4px] border border-input transition-colors group-disabled/tick:opacity-60 group-data-[state=checked]/tick:border-primary group-data-[state=checked]/tick:bg-primary group-data-[state=checked]/tick:text-primary-foreground"
              >
                <CheckboxPrimitive.Indicator>
                  <Check className="size-3.5" strokeWidth={3} />
                </CheckboxPrimitive.Indicator>
              </span>
            </CheckboxPrimitive.Root>
            <label
              htmlFor={inputId}
              className={cn('min-w-0 flex-1 pt-0.5 text-small', !disabled && 'cursor-pointer')}
            >
              <span
                data-slot="next-step"
                className={cn('text-small', item.done && 'text-muted-foreground line-through')}
              >
                <span className="tabular">{index + 1}. </span>
                {item.do}
              </span>
              {detail ? (
                <span data-slot="next-step" className="block text-caption text-pretty text-muted-foreground">
                  {detail}
                </span>
              ) : null}
            </label>
          </li>
        );
      })}
    </ol>
  );
}

/** Who to see when a qualified person must decide, and what to bring. */
function Referral({
  referral,
  onAskPerson,
}: {
  referral: NonNullable<TurnGuidance['referral']>;
  onAskPerson: (() => void) | undefined;
}) {
  return (
    <div
      data-slot="step-referral"
      className="flex items-start gap-2.5 rounded-lg border border-border-strong p-3"
    >
      <HandHelping aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1 gap-1 text-small text-pretty">
        <p>
          <span className="text-muted-foreground">See: </span>
          <span data-slot="next-step">{referral.who}</span>
        </p>
        {referral.bring ? (
          <p>
            <span className="text-muted-foreground">Bring: </span>
            <span data-slot="next-step">{referral.bring}</span>
          </p>
        ) : null}
        {onAskPerson ? (
          <Button size="sm" variant="secondary" className="mt-1 justify-self-start" onClick={onAskPerson}>
            Ask a person
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Why this step: the stage it belongs to, the evidence it produces, and what it leads to. */
function Why({
  path,
  step,
  place,
  then,
  tenant,
  ventureId,
}: {
  path: ReturnType<typeof useVenturePath>['data'];
  step: PathStepView;
  place: StepPlace | null;
  then: readonly string[];
  tenant: string;
  ventureId: string;
}) {
  const stage = path?.stages.find((candidate) =>
    step.criterionId
      ? candidate.criteria.some((criterion) => criterion.id === step.criterionId)
      : candidate.status === 'current',
  );
  const criterion = stage?.criteria.find((candidate) => candidate.id === step.criterionId);
  const row = (term: string, text: ReactNode) => (
    <div className="grid gap-x-3 sm:grid-cols-[5rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="text-pretty" data-slot="next-step">
        {text}
      </dd>
    </div>
  );
  return (
    <div data-slot="step-why" className="grid gap-2 border-l border-border pl-3 text-small">
      <dl className="grid gap-1.5">
        {stage || place
          ? row('Stage', stage ? `${stage.title}: ${stage.goal}` : (place?.stageTitle ?? ''))
          : null}
        {criterion ? row('It shows', `${criterion.title}. ${criterion.evidence}`) : null}
        {then.length > 0 ? row('Then', then.join('; ')) : null}
      </dl>
      <Link
        to="/$tenant/app/v/$ventureId/path"
        params={{ tenant, ventureId }}
        className="justify-self-start rounded-sm text-caption text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        Your path
      </Link>
    </div>
  );
}

/** Once it is done: the step the path is on now. */
function UpNext({
  path,
  step,
  tenant,
  ventureId,
}: {
  path: ReturnType<typeof useVenturePath>['data'];
  step: PathStepView;
  tenant: string;
  ventureId: string;
}) {
  const now = path?.now;
  if (!now || now.id === step.id) return null;
  return (
    <Link
      to="/$tenant/app/v/$ventureId/path"
      params={{ tenant, ventureId }}
      className="min-w-0 truncate rounded-sm text-small underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="text-muted-foreground">Now: </span>
      <span data-slot="next-step">{now.title}</span>
    </Link>
  );
}

/** One line of the founder's own words, and nothing else to fill in. */
function LineForm({
  label,
  placeholder,
  submit,
  maxLength,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder?: string;
  submit: string;
  maxLength: number;
  pending: boolean;
  onSubmit: (line: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [line, setLine] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const ready = line.trim().length >= 3;
  return (
    <form
      data-slot="step-form"
      data-print="hide"
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) onSubmit(line.trim());
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label htmlFor={id} className="text-small font-medium">
        {label}
      </label>
      <Input
        id={id}
        ref={inputRef}
        value={line}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => {
          setLine(event.target.value);
        }}
      />
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={!ready} loading={pending} loadingText="Saving…">
          {submit}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Not yet: a new date, one press for the usual ones. */
function Reschedule({
  pending,
  onPick,
  onBlocked,
  onCancel,
}: {
  pending: boolean;
  onPick: (dueOn: string) => void;
  onBlocked: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const today = localIsoDay();
  const [date, setDate] = useState('');
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-label="New date"
      data-slot="step-form"
      data-print="hide"
      className="flex flex-wrap items-center gap-1.5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Button
        ref={first}
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          onPick(addDays(today, 2));
        }}
      >
        2 days
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          onPick(addDays(today, 7));
        }}
      >
        1 week
      </Button>
      <label htmlFor={id} className="sr-only">
        Another date
      </label>
      <Input
        id={id}
        type="date"
        min={today}
        value={date}
        className="h-8 w-auto"
        onChange={(event) => {
          setDate(event.target.value);
        }}
      />
      <Button
        size="sm"
        disabled={pending || date < today}
        onClick={() => {
          onPick(date);
        }}
      >
        Move
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onBlocked}>
        Blocked
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

interface TurnStepCardProps {
  guidance: TurnGuidance;
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  /** The conversation's latest reply: only its card shows whole. */
  latest: boolean;
  busy?: boolean;
  evidence?: readonly EvidenceItem[];
  dense?: boolean;
  onAskPerson?: (() => void) | undefined;
  className?: string;
}

/** The step a turn's guidance holds, as a card; nothing when it holds neither a step nor a person to see. */
export function TurnStepCard({ guidance, latest, className, ...rest }: TurnStepCardProps) {
  if (guidance.step === null) {
    if (!guidance.referral || !latest) return null;
    return (
      <section aria-label="Who to see" data-slot="step-card" className={className}>
        <Referral referral={guidance.referral} onAskPerson={rest.canEdit ? rest.onAskPerson : undefined} />
      </section>
    );
  }
  return (
    <StepCard
      step={guidance.step}
      place={guidance}
      then={guidance.then}
      referral={guidance.referral}
      offered={guidance.offered ?? false}
      pathStep={guidance.pathStep ?? null}
      expanded={latest}
      className={className}
      {...rest}
    />
  );
}
