import type { MemoryObjectView, VentureOverview } from '@foundry/contracts';
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
import { useState, type ReactNode } from 'react';

import { AboutVeirDialog } from '@/components/faces/about-veir-dialog';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Skeleton } from '@/components/ui/skeleton';
import { StageChip } from '@/components/ui/stage-chip';
import { useVentureOverview } from '@/lib/api/hooks/ventures';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { VeirName } from '@/lib/veir';
import { actionAttributes, formatIsoDate, milestoneAttributes } from '@/features/memory/typed/attributes';

import {
  CallsSection,
  DocumentsSection,
  DueActions,
  HelpSection,
  ItemLine,
  MAX_ITEMS,
  QUIET_LINK,
  RecentMemory,
  ROW,
} from './venture-context-sections';
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
  /** The open conversation (its own help requests and calls are marked); none on New chat. */
  sessionId?: string | undefined;
  /** Fill the composer with a quick action's words. Without it (or while coaching is unavailable) none show. */
  onPrompt?: ((suggestion: PromptSuggestion) => void) | undefined;
  onAskPerson?: (() => void) | undefined;
}

/**
 * The venture's context beside the conversation, the same on New chat and in a conversation (owner, 2026-11-05: "a
 * short panel on the right instead of chips piled in the centre"; 2026-11-06: "the features that make them useful"):
 * where the venture stands, then sections that each fold away (remembered per browser) and each act on what they
 * show: what is due (Done, Snooze), what is being tested, human help (Ask a person), quick starts, memory (Remember or
 * Private, and the newest memory with Edit), documents (open in the viewer) and calls. Each lists a handful of items
 * and links to its page for the rest; every control is a button or a link in reading order.
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
    <div data-slot="venture-context" className="grid gap-5 px-4 pt-4 pb-5">
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
          onPrompt={onPrompt}
        />
      )}

      <HelpSection tenant={tenant} ventureId={ventureId} sessionId={sessionId} onAskPerson={onAskPerson} />

      {overview.data && onPrompt ? <QuickStarts overview={overview.data} onPrompt={onPrompt} /> : null}

      <CollapsibleSection id="memory" title="Memory">
        <div className="grid gap-3">
          {memory.kind === 'choice' ? (
            <PrivacyChoice value={memory.value} onChange={memory.onChange} align="start" />
          ) : (
            <p className="text-small text-muted-foreground">
              {memory.privacy === 'ephemeral' ? 'Private: not kept.' : 'Remembered for next time.'}
            </p>
          )}
          <RecentMemory
            tenant={tenant}
            ventureId={ventureId}
            showLink={!(memory.kind === 'fixed' && memory.privacy === 'ephemeral')}
          />
        </div>
      </CollapsibleSection>

      <DocumentsSection tenant={tenant} ventureId={ventureId} />
      <CallsSection tenant={tenant} ventureId={ventureId} sessionId={sessionId} />

      {veir ? (
        <div className="border-t border-border pt-4">
          <AboutVeirDialog
            veir={veir}
            open={aboutOpen}
            onOpenChange={setAboutOpen}
            // The dialog's trigger: closing it (Done, Escape) puts focus back here.
            trigger={
              <button
                type="button"
                data-slot="about-veir"
                className={cn(QUIET_LINK, 'inline-flex items-center gap-1.5')}
              >
                <Info aria-hidden className="size-3.5" />
                About {veir.name}
              </button>
            }
          />
        </div>
      ) : null}
    </div>
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

/** One line under the venture's name: what needs attention first, then when they last talked. */
function statusLine(overview: VentureOverview): { text: string; attention: boolean } {
  const overdue = overview.overdueActions.length;
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${String(overdue)} overdue`);
  else if (overview.upcomingMilestones.length > 0) parts.push('On track');
  const last = overview.sinceLastSession.lastSessionAt;
  if (last) parts.push(`last talked ${formatRelative(last)}`);
  return { text: parts.join(' · '), attention: overdue > 0 };
}

function OverviewSections({
  overview,
  tenant,
  ventureId,
  onPrompt,
}: {
  overview: VentureOverview;
  tenant: string;
  ventureId: string;
  onPrompt: ((suggestion: PromptSuggestion) => void) | undefined;
}) {
  const venture = overview.venture;
  const goal =
    [overview.currentGoal, venture.currentGoal].map((g) => g?.trim() ?? '').find((g) => g !== '') ?? null;
  const due = dueItems(overview);
  const testing = overview.openAssumptions;
  const status = statusLine(overview);

  return (
    <>
      <div className="grid gap-1.5" data-slot="venture-status">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-body font-medium">{venture.name}</span>
          <StageChip stage={venture.stage} />
        </div>
        {status.text ? (
          <p className={cn('text-caption', status.attention ? 'text-warning' : 'text-muted-foreground')}>
            {status.text}
          </p>
        ) : null}
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

      <CollapsibleSection id="due" title="Due" meta={due.length > 0 ? due.length : undefined}>
        {due.length === 0 ? (
          <p className="text-small text-muted-foreground">Nothing due.</p>
        ) : (
          <ul aria-label="Due and overdue" className="-mx-2 grid gap-px">
            {due.slice(0, MAX_ITEMS).map(({ item, date, overdue }) => {
              const Icon = overdue ? AlarmClock : CalendarClock;
              return (
                <ItemLine key={item.id} actions={<DueActions ventureId={ventureId} item={item} />}>
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
                </ItemLine>
              );
            })}
          </ul>
        )}
        {due.length > MAX_ITEMS ? (
          <Link
            to="/$tenant/app/v/$ventureId/knowledge"
            params={{ tenant, ventureId }}
            className={cn(QUIET_LINK, 'mt-1.5 inline-block')}
          >
            {`All ${String(due.length)} in Knowledge`}
          </Link>
        ) : null}
      </CollapsibleSection>

      {testing.length > 0 ? (
        <CollapsibleSection id="testing" title="Testing" meta={testing.length}>
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
        </CollapsibleSection>
      ) : null}
    </>
  );
}

/** Ways to start (they fill the composer, ready to edit): only where the founder can send a message. */
function QuickStarts({
  overview,
  onPrompt,
}: {
  overview: VentureOverview;
  onPrompt: (suggestion: PromptSuggestion) => void;
}) {
  const goal =
    [overview.currentGoal, overview.venture.currentGoal].map((g) => g?.trim() ?? '').find((g) => g !== '') ??
    null;
  const actions = quickActions(goal);
  if (actions.length === 0) return null;
  return (
    <CollapsibleSection id="start" title="Start with">
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
    </CollapsibleSection>
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
