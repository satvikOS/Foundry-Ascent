import type { EscalationView } from '@foundry/contracts';
import { Search, ShieldCheck } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useEscalationAction } from '@/lib/api/hooks/escalations';
import { useMemory } from '@/lib/api/hooks/memory';
import { pluralize } from '@/lib/format';
import { REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { MemoryTypeLabel } from '@/features/memory/memory-meta';

const MAX_SHARED = 30;

interface ConsentFormProps {
  escalation: EscalationView;
  /** Called with the updated escalation after consent is recorded. */
  onConsented?: (escalation: EscalationView) => void;
  onCancel?: () => void;
}

/**
 * Founder consent: choose exactly which confirmed facts travel with the packet. Nothing is shared with
 * the human reviewer until this is submitted, and only the selected items are included.
 */
export function ConsentForm({ escalation, onConsented, onCancel }: ConsentFormProps) {
  const confirmed = useMemory(escalation.ventureId, { status: 'confirmed' });
  const action = useEscalationAction();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const suggested = useMemo(
    () =>
      new Set(
        (escalation.packet?.sharedFacts ?? [])
          .map((fact) => fact.memoryId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    [escalation.packet],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suggested));
  const role = REQUESTED_ROLE_LABELS[escalation.requestedRole] ?? 'the requested person';

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Packets are read by the whole team and the assignee, so founder-only items can never be shared
    // (the server rejects them too).
    const rows = (confirmed.data ?? []).filter((m) => m.visibility !== 'founder_private');
    const filtered = needle
      ? rows.filter((m) => m.title.toLowerCase().includes(needle) || m.content.toLowerCase().includes(needle))
      : rows;
    // Suggested items first, then pinned, then the rest.
    return [...filtered].sort(
      (a, b) =>
        Number(suggested.has(b.id)) - Number(suggested.has(a.id)) || Number(b.pinned) - Number(a.pinned),
    );
  }, [confirmed.data, query, suggested]);

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submit = () => {
    setError(null);
    action.mutate(
      { escalationId: escalation.id, action: { action: 'approve_sharing', sharedMemoryIds: [...selected] } },
      {
        onSuccess: (updated) => {
          toast.success(`Shared with ${role}`);
          announce('Consent recorded. Your request was shared.');
          onConsented?.(updated);
        },
        onError: (e) => {
          setError(errorMessage(e));
        },
      },
    );
  };

  const overLimit = selected.size > MAX_SHARED;

  return (
    <div className="grid gap-4">
      <Alert variant="info" icon={ShieldCheck} title="You decide what is shared">
        {role} will see your question, the packet above, and only the facts you tick below. Founder-only items
        are never shared and are not listed.
      </Alert>
      {error ? (
        <Alert variant="destructive" live="alert" title="Couldn’t record consent">
          {error}
        </Alert>
      ) : null}
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search confirmed facts
        </label>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search confirmed memory"
          className="pl-9"
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      </div>
      {confirmed.isPending ? (
        <div aria-busy="true" className="grid gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : confirmed.isError ? (
        <ErrorState
          error={confirmed.error}
          onRetry={() => void confirmed.refetch()}
          size="sm"
          headingLevel={3}
        />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
          {query
            ? 'No confirmed memory matches.'
            : 'No confirmed memory yet. You can share the question on its own.'}
        </p>
      ) : (
        <fieldset className="max-h-72 overflow-y-auto rounded-lg border border-border">
          <legend className="sr-only">Confirmed facts to share</legend>
          <ul className="divide-y divide-border">
            {items.map((memory) => {
              const id = `consent-${escalation.id}-${memory.id}`;
              return (
                <li key={memory.id} className="flex items-start gap-3 px-3 py-2.5">
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={selected.has(memory.id)}
                    onCheckedChange={(checked) => {
                      toggle(memory.id, checked === true);
                    }}
                  />
                  <label htmlFor={id} className="grid min-w-0 cursor-pointer gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <MemoryTypeLabel type={memory.type} />
                      {suggested.has(memory.id) ? (
                        <span className="text-xs text-muted-foreground">Suggested by Foundry Guide</span>
                      ) : null}
                    </span>
                    <span className="text-sm font-medium [overflow-wrap:anywhere]">{memory.title}</span>
                    <span className="line-clamp-2 text-[13px] text-muted-foreground">{memory.content}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-muted-foreground" role="status" aria-live="polite">
          {selected.size === 0
            ? 'Only your question and the packet will be shared.'
            : `${pluralize(selected.size, 'fact')} selected`}
          {overLimit ? ` — choose at most ${MAX_SHARED}.` : ''}
        </p>
        <div className="flex gap-2">
          {onCancel ? (
            <Button variant="secondary" onClick={onCancel}>
              Not now
            </Button>
          ) : null}
          <Button onClick={submit} loading={action.isPending} loadingText="Sharing…" disabled={overLimit}>
            <ShieldCheck aria-hidden />
            Approve sharing
          </Button>
        </div>
      </div>
    </div>
  );
}
