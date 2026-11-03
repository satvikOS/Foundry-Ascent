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
      // A disclosure needs three relevant items, not ten pages of venture history.
      const [approved, pending] = await Promise.all([
        api.get(path`/ventures/${ventureId}/memory`, MemoryListResponse, {
          signal,
          query: { status: 'confirmed', limit: 3 },
        }),
        api.get(path`/ventures/${ventureId}/memory`, MemoryListResponse, {
          signal,
          query: { status: 'proposed', limit: 1 },
        }),
      ]);
      return {
        context: approved.items.filter((m) => m.visibility !== 'founder_private'),
        pending: pending.items.length > 0,
      };
    },
  });
  const context = memory.data?.context ?? [];
  const pending = memory.data?.pending ?? false;
  if (!venture.data) return null;
  const link =
    'rounded-sm underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <details
      className="group mx-auto mt-6 w-full max-w-xl border-y border-border text-small"
      data-slot="context-brief"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
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
          <p role="status">Loading approved context…</p>
        ) : context.length ? (
          <ul className="grid gap-2" aria-label="Approved context">
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
                <span className="ml-2 text-caption">Approved memory</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No approved context yet. Your coach can propose what to remember as you talk.</p>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/$tenant/app/v/$ventureId/settings" params={{ tenant, ventureId }} className={link}>
            Edit venture focus
          </Link>
          <Link
            to="/$tenant/app/v/$ventureId/knowledge"
            params={{ tenant, ventureId }}
            search={pending ? { status: 'proposed' } : {}}
            className={link}
          >
            {pending ? 'Review memory suggestions' : 'Review or correct memory'}
          </Link>
        </div>
      </div>
    </details>
  );
}
