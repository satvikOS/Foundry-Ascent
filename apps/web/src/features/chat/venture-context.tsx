import {
  OPEN_ESCALATION_STATUSES,
  type EscalationView,
  type MemoryObjectView,
  type VentureOverview,
} from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  AlarmClock,
  CalendarClock,
  ChevronRight,
  FlaskConical,
  Info,
  Lightbulb,
  Mic,
  Swords,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { AboutVeirDialog } from '@/components/faces/about-veir-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useVentureOverview } from '@/lib/api/hooks/ventures';
import { pluralize } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, STAGE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { VeirName } from '@/lib/veir';
import { actionAttributes, formatIsoDate, milestoneAttributes } from '@/features/memory/typed/attributes';

import { PrivacyChoice, type ConversationPrivacy } from './privacy-choice';
import {
  assumptionPrompt,
  milestonePrompt,
  overduePrompt,
  quickActions,
  type PromptSuggestion,
  type SuggestionIcon,
} from './suggestions';

export type { PromptSuggestion } from './suggestions';

const OPEN_ESCALATION: ReadonlySet<string> = new Set(OPEN_ESCALATION_STATUSES);

const ACTION_ICONS: Record<SuggestionIcon, LucideIcon> = {
  goal: Target,
  idea: Lightbulb,
  challenge: Swords,
  rehearse: Mic,
};

/** The memory row: the choice on New chat, or how the open conversation is kept. */
export type ContextMemory =
  | { kind: 'choice'; value: ConversationPrivacy; onChange: (privacy: ConversationPrivacy) => void }
  | { kind: 'fixed'; privacy: ConversationPrivacy };

interface VentureContextProps {
  tenant: string;
  ventureId: string;
  /** The mentor ("Thomas"), for the About dialog; null while unknown. */
  veir: VeirName | null;
  memory: ContextMemory;
  /** The open conversation (its own help requests are listed first); none on New chat. */
  sessionId?: string | undefined;
  /** Fill the composer with a quick action's words. Without it (or while coaching is unavailable) none show. */
  onPrompt?: ((suggestion: PromptSuggestion) => void) | undefined;
  onAskPerson?: (() => void) | undefined;
}

/**
 * The venture's context beside the conversation (owner, 2026-11-05: "a short panel on the right instead of chips
 * piled in the centre"): the venture's stage and focus, what is due or overdue, what is being tested, open requests
 * for human help, the memory choice, and a few quick actions. Short and calm: each section shows a handful of items
 * and says nothing when it has none. The same content on New chat and in a conversation.
 */
export function VentureContext({
  tenant,
  ventureId,
  veir,
  memory,
  sessionId,
  onPrompt,
  onAskPerson,
}: VentureContextProps) {
  const overview = useVentureOverview(ventureId);
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <div data-slot="venture-context" className="grid gap-6 px-4 pt-4 pb-5">
      {overview.isPending ? (
        <ContextSkeleton />
      ) : overview.isError ? (
        <p className="text-small text-muted-foreground">
          Context unavailable.{' '}
          <button
            type="button"
            className="font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => void overview.refetch()}
          >
            Try again
          </button>
        </p>
      ) : (
        <OverviewSections
          overview={overview.data}
          tenant={tenant}
          ventureId={ventureId}
          sessionId={sessionId}
          onPrompt={onPrompt}
          onAskPerson={onAskPerson}
        />
      )}

      <ContextSection title="Memory">
        {memory.kind === 'choice' ? (
          <PrivacyChoice value={memory.value} onChange={memory.onChange} align="start" />
        ) : (
          <p className="text-small text-muted-foreground">
            {memory.privacy === 'ephemeral' ? 'Private: not kept.' : 'Remembered for next time.'}
          </p>
        )}
        {memory.kind === 'fixed' && memory.privacy === 'ephemeral' ? null : (
          <Link
            to="/$tenant/app/v/$ventureId/knowledge"
            params={{ tenant, ventureId }}
            className={cn(QUIET_LINK, 'mt-2 inline-block')}
          >
            Review or correct memory
          </Link>
        )}
      </ContextSection>

      {veir ? (
        <div className="border-t border-border pt-4">
          <button
            type="button"
            data-slot="about-veir"
            onClick={() => {
              setAboutOpen(true);
            }}
            className={cn(QUIET_LINK, 'inline-flex items-center gap-1.5')}
          >
            <Info aria-hidden className="size-3.5" />
            About {veir.name}
          </button>
          <AboutVeirDialog veir={veir} open={aboutOpen} onOpenChange={setAboutOpen} />
        </div>
      ) : null}
    </div>
  );
}

const QUIET_LINK =
  'rounded-sm text-small text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring';

const ROW =
  'group flex min-h-9 w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-small transition-colors duration-(--dur-hover) hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11';

/** How many items a section lists before "more in Knowledge". */
const MAX_ITEMS = 3;

function ContextSection({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="section-label flex items-center gap-1.5">
        {title}
        {meta ? <span className="tabular">{meta}</span> : null}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function ContextSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only" role="status">
        Loading context…
      </span>
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

interface DueItem {
  item: MemoryObjectView;
  date: string | undefined;
  overdue: boolean;
}

function dueItems(overview: VentureOverview): DueItem[] {
  const overdue = overview.overdueActions.map((item) => ({
    item,
    date: actionAttributes(item).due,
    overdue: true,
  }));
  const upcoming = overview.upcomingMilestones.map((item) => ({
    item,
    date: milestoneAttributes(item).target_date,
    overdue: false,
  }));
  return [...overdue, ...upcoming];
}

function OverviewSections({
  overview,
  tenant,
  ventureId,
  sessionId,
  onPrompt,
  onAskPerson,
}: {
  overview: VentureOverview;
  tenant: string;
  ventureId: string;
  sessionId: string | undefined;
  onPrompt: ((suggestion: PromptSuggestion) => void) | undefined;
  onAskPerson: (() => void) | undefined;
}) {
  const venture = overview.venture;
  const goal =
    [overview.currentGoal, venture.currentGoal].map((g) => g?.trim() ?? '').find((g) => g !== '') ?? null;
  const due = dueItems(overview);
  const testing = overview.openAssumptions;
  const actions = onPrompt ? quickActions(goal) : [];

  return (
    <>
      <div className="grid gap-1.5">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body font-medium">{venture.name}</span>
          <span className="shrink-0 text-caption text-muted-foreground">
            {STAGE_LABELS[venture.stage]} stage
          </span>
        </p>
        <p className="line-clamp-3 text-small text-pretty text-muted-foreground">
          {goal ? (
            <>
              <span className="text-foreground">Focus: </span>
              {goal}
            </>
          ) : (
            'No focus set yet.'
          )}{' '}
          <Link to="/$tenant/app/v/$ventureId/settings" params={{ tenant, ventureId }} className={QUIET_LINK}>
            {goal ? 'Edit' : 'Set one'}
          </Link>
        </p>
      </div>

      <ContextSection title="Due" meta={due.length > 0 ? due.length : undefined}>
        {due.length === 0 ? (
          <p className="text-small text-muted-foreground">Nothing due.</p>
        ) : (
          <ul className="-mx-2 grid gap-px">
            {due.slice(0, MAX_ITEMS).map(({ item, date, overdue }) => {
              const Icon = overdue ? AlarmClock : CalendarClock;
              return (
                <li key={item.id}>
                  <ItemRow
                    tenant={tenant}
                    ventureId={ventureId}
                    item={item}
                    onPrompt={onPrompt}
                    prompt={{
                      id: `due-${item.id}`,
                      icon: 'goal',
                      label: item.title,
                      prompt: overdue ? overduePrompt(item.title) : milestonePrompt(item.title),
                    }}
                  >
                    <Icon
                      aria-hidden
                      className={cn(
                        'mt-0.5 size-4 shrink-0',
                        overdue ? 'text-warning' : 'text-muted-foreground',
                      )}
                    />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="line-clamp-2">{item.title}</span>
                      <span
                        className={cn('text-caption', overdue ? 'text-warning' : 'text-muted-foreground')}
                      >
                        {overdue ? 'Overdue' : 'Due'}
                        {date ? ` · ${formatIsoDate(date, 'short')}` : ''}
                      </span>
                    </span>
                  </ItemRow>
                </li>
              );
            })}
          </ul>
        )}
      </ContextSection>

      {testing.length > 0 ? (
        <ContextSection title="Testing" meta={testing.length}>
          <ul className="-mx-2 grid gap-px">
            {testing.slice(0, 2).map((item) => (
              <li key={item.id}>
                <ItemRow
                  tenant={tenant}
                  ventureId={ventureId}
                  item={item}
                  onPrompt={onPrompt}
                  prompt={{
                    id: `test-${item.id}`,
                    icon: 'challenge',
                    label: item.title,
                    prompt: assumptionPrompt(item.title),
                    mode: 'challenge',
                  }}
                >
                  <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="line-clamp-2 min-w-0 flex-1">{item.title}</span>
                </ItemRow>
              </li>
            ))}
          </ul>
        </ContextSection>
      ) : null}

      <HelpSection
        tenant={tenant}
        ventureId={ventureId}
        openCount={overview.openEscalations}
        sessionId={sessionId}
        onAskPerson={onAskPerson}
      />

      {actions.length > 0 && onPrompt ? (
        <ContextSection title="Start with">
          <ul aria-label="Quick actions" className="-mx-2 grid gap-px">
            {actions.map((action) => {
              const Icon = ACTION_ICONS[action.icon];
              return (
                <li key={action.id}>
                  <button
                    type="button"
                    className={ROW}
                    onClick={() => {
                      onPrompt(action);
                    }}
                  >
                    <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="line-clamp-2 min-w-0 flex-1">{action.label}</span>
                    <ChevronRight
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </ContextSection>
      ) : null}
    </>
  );
}

/**
 * One item of what is due or being tested: where the founder can send a message it starts a conversation about it
 * (the composer fills, ready to edit), and otherwise it opens the item in Knowledge.
 */
function ItemRow({
  tenant,
  ventureId,
  item,
  prompt,
  onPrompt,
  children,
}: {
  tenant: string;
  ventureId: string;
  item: MemoryObjectView;
  prompt: PromptSuggestion;
  onPrompt: ((suggestion: PromptSuggestion) => void) | undefined;
  children: ReactNode;
}) {
  if (onPrompt) {
    return (
      <button
        type="button"
        className={ROW}
        onClick={() => {
          onPrompt(prompt);
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <Link
      to="/$tenant/app/v/$ventureId/knowledge"
      params={{ tenant, ventureId }}
      search={{ m: item.id }}
      className={ROW}
    >
      {children}
    </Link>
  );
}

function HelpSection({
  tenant,
  ventureId,
  openCount,
  sessionId,
  onAskPerson,
}: {
  tenant: string;
  ventureId: string;
  openCount: number;
  sessionId: string | undefined;
  onAskPerson: (() => void) | undefined;
}) {
  // The conversation's own requests (with their status) are read only in a conversation.
  const escalations = useVentureEscalations(ventureId, { enabled: sessionId !== undefined });
  const fromHere: EscalationView[] = sessionId
    ? (escalations.data ?? []).filter((e) => e.sessionId === sessionId)
    : [];
  const otherOpen = sessionId
    ? (escalations.data ?? []).filter((e) => e.sessionId !== sessionId && OPEN_ESCALATION.has(e.status))
        .length
    : openCount;

  return (
    <ContextSection title="Human help">
      {fromHere.length > 0 ? (
        <ul aria-label="Requests from this conversation" className="-mx-2 mb-2 grid gap-px">
          {fromHere.map((e) => (
            <li key={e.id}>
              <Link
                to="/$tenant/app/v/$ventureId/help"
                params={{ tenant, ventureId }}
                search={{ id: e.id }}
                className={cn(ROW, 'items-center justify-between')}
              >
                <span className="truncate">{ESCALATION_CATEGORY_LABELS[e.category]}</span>
                <StatusBadge kind="escalationStatus" status={e.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {otherOpen > 0 ? (
          <Link to="/$tenant/app/v/$ventureId/help" params={{ tenant, ventureId }} className={QUIET_LINK}>
            {pluralize(otherOpen, sessionId ? 'other open request' : 'open request')}
          </Link>
        ) : (
          <p className="text-small text-muted-foreground">No open requests.</p>
        )}
        {onAskPerson ? (
          <Button size="xs" variant="secondary" onClick={onAskPerson}>
            Ask a person
          </Button>
        ) : null}
      </div>
    </ContextSection>
  );
}
