import type { ArcEntry } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  CircleCheck,
  FlaskConical,
  Flag,
  Gavel,
  Handshake,
  Lightbulb,
  MessageSquare,
  Milestone,
  Scale,
  Shuffle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { longDay } from './due';
import { ARC_LABELS, story } from './plan';

const ARC_ICONS: Record<ArcEntry['kind'], LucideIcon> = {
  origin: Flag,
  idea: Lightbulb,
  pivot: Shuffle,
  decision: Gavel,
  experiment: FlaskConical,
  result: Scale,
  milestone: Milestone,
  setback: TriangleAlert,
  commitment: Handshake,
  step_done: CircleCheck,
  conversation: MessageSquare,
};

/**
 * The venture's story, oldest first: where it started, its pivots and decisions, what was tried and what came of it.
 * Each line opens what it comes from (the memory, the conversation) for those who can open that.
 */
export function Story({
  arc,
  tenant,
  ventureId,
  canOpenConversations,
}: {
  arc: readonly ArcEntry[];
  tenant: string;
  ventureId: string;
  canOpenConversations: boolean;
}) {
  const [conversations, setConversations] = useState(false);
  const entries = story(arc, { conversations });
  const talks = arc.filter((entry) => entry.kind === 'conversation').length;
  return (
    <div className="grid gap-3">
      {entries.length === 0 ? (
        <p className="text-small text-muted-foreground">It starts with your first conversation.</p>
      ) : (
        <ol aria-label="Your story" data-slot="story" className="grid">
          {entries.map((entry, index) => {
            const Icon = ARC_ICONS[entry.kind];
            return (
              <li
                key={entry.id}
                data-kind={entry.kind}
                className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0"
              >
                {index < entries.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute top-8 bottom-1 left-3.5 w-px -translate-x-1/2 bg-border-strong"
                  />
                ) : null}
                <span
                  aria-hidden
                  className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                  <Icon className="size-3.5" />
                </span>
                <div className="grid min-w-0 gap-0.5 pt-0.5">
                  <p className="tabular text-caption text-muted-foreground">
                    {longDay(entry.on)} · {ARC_LABELS[entry.kind]}
                  </p>
                  <p className="text-small font-medium text-pretty [overflow-wrap:anywhere]">
                    <EntryTitle
                      entry={entry}
                      tenant={tenant}
                      ventureId={ventureId}
                      canOpenConversations={canOpenConversations}
                    />
                  </p>
                  {entry.detail ? (
                    <p className="text-small text-pretty text-muted-foreground [overflow-wrap:anywhere]">
                      {entry.detail}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {talks > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          data-print="hide"
          aria-pressed={conversations}
          className="justify-self-start"
          onClick={() => {
            setConversations((value) => !value);
          }}
        >
          Conversations ({talks})
        </Button>
      ) : null}
    </div>
  );
}

const TITLE_LINK =
  'rounded-sm decoration-border-strong underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring';

function EntryTitle({
  entry,
  tenant,
  ventureId,
  canOpenConversations,
}: {
  entry: ArcEntry;
  tenant: string;
  ventureId: string;
  canOpenConversations: boolean;
}) {
  if (entry.source.kind === 'memory') {
    return (
      <Link
        to="/$tenant/app/v/$ventureId/knowledge"
        params={{ tenant, ventureId }}
        search={{ m: entry.source.id }}
        className={TITLE_LINK}
      >
        {entry.title}
      </Link>
    );
  }
  if (entry.source.kind === 'session' && canOpenConversations) {
    return (
      <Link
        to="/$tenant/app/v/$ventureId/c/$sessionId"
        params={{ tenant, ventureId, sessionId: entry.source.id }}
        className={TITLE_LINK}
      >
        {entry.title}
      </Link>
    );
  }
  return <>{entry.title}</>;
}
