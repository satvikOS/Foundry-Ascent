import { MemoryListResponse } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';

import { api, path } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/query-keys';
import { VENTURE_DATA_STALE_MS } from '@/lib/api/venture-refresh';
import { useVenture } from '@/lib/api/hooks/ventures';

/** A compact, editable starting context. Disclosures keep the conversation in focus. */
export function ContextBrief({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  const venture = useVenture(ventureId);
  const [open, setOpen] = useState(false);
  const memory = useQuery({
    queryKey: queryKeys.venture.contextMemory(ventureId),
    enabled: open,
    staleTime: VENTURE_DATA_STALE_MS,
    queryFn: async ({ signal }) => {
      // A disclosure needs three relevant items, not ten pages of venture history. Memory is kept automatically
      // (owner decision 2026-10-16): what the vEIR remembered is shown as it stands, with nothing to approve.
      const remembered = await api.get(path`/ventures/${ventureId}/memory`, MemoryListResponse, {
        signal,
        query: { status: 'confirmed', limit: 3 },
      });
      return { context: remembered.items.filter((m) => m.visibility !== 'founder_private') };
    },
  });
  const context = memory.data?.context ?? [];
  if (!venture.data) return null;
  const link =
    'rounded-sm underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <details
      className="group mx-auto mt-[var(--space-section)] w-full max-w-xl border-y border-border text-small"
      data-slot="context-brief"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-[var(--touch-target)] cursor-pointer list-none items-center justify-between gap-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate">
          <span className="font-medium">{venture.data.name}</span>
          <span className="ml-2 text-muted-foreground">Review context</span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="grid gap-3 pb-4 text-muted-foreground">
        <p>
          <span className="text-foreground">Current focus: </span>
          {venture.data.currentGoal ?? 'Bring one decision, question, or idea to explore.'}
        </p>
        {memory.isError ? (
          <button type="button" className={link} onClick={() => void memory.refetch()}>
            Context unavailable. Try again
          </button>
        ) : memory.isPending ? (
          <p role="status">Loading memory…</p>
        ) : context.length ? (
          <ul className="grid gap-2" aria-label="Remembered context">
            {context.map((item) => (
              <li key={item.id}>
                <Link
                  to="/$tenant/app/v/$ventureId/knowledge"
                  params={{ tenant, ventureId }}
                  search={{ m: item.id }}
                  className={link}
                >
                  {item.title}
                </Link>
                <span className="ml-2 text-caption">Remembered</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing remembered yet. Your coach remembers as you talk.</p>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/$tenant/app/v/$ventureId/settings" params={{ tenant, ventureId }} className={link}>
            Edit venture focus
          </Link>
          <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant, ventureId }} className={link}>
            Review or correct memory
          </Link>
        </div>
      </div>
    </details>
  );
}
