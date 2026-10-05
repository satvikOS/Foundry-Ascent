import type { MemoryObjectView } from '@foundry/contracts';
import { FlaskConical } from 'lucide-react';
import { useId } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { announce } from '@/components/a11y/live-announcer';
import { errorMessage } from '@/lib/api/errors';
import { pluralize } from '@/lib/format';
import { displayContent } from '@/lib/api/hooks/memory';

import { useOptimisticMemoryAction } from '../api';
import { EXPERIMENT_STATUSES, experimentAttributes, type ExperimentStatus } from './attributes';
import { TypedCard, TypedField, TypedMemoryPage, type TypedPageContext } from './typed-page';
import { EXPERIMENT_STATUS_DEFS, TypedStatusBadge } from './typed-status';

function MoveSelect({
  memory,
  ctx,
  status,
}: {
  memory: MemoryObjectView;
  ctx: TypedPageContext;
  status: ExperimentStatus;
}) {
  const move = useOptimisticMemoryAction(ctx.ventureId);
  const id = useId();
  if (!ctx.canEdit || memory.status === 'superseded' || memory.status === 'deleted') return null;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Stage
      </label>
      <Select
        value={status}
        onValueChange={(next) => {
          const label = EXPERIMENT_STATUS_DEFS[next as ExperimentStatus].label;
          move.mutate(
            {
              memoryId: memory.id,
              action: {
                action: 'correct',
                patch: { attributes: { ...memory.attributes, status: next } },
                reason: `Moved to ${label}`,
              },
            },
            {
              onSuccess: () => {
                announce(`Moved to ${label}`);
              },
              onError: (error) => {
                toast.error('Couldn’t move the experiment', { description: errorMessage(error) });
              },
            },
          );
        }}
      >
        <SelectTrigger id={id} size="sm" className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXPERIMENT_STATUSES.map((s) => {
            const Icon = EXPERIMENT_STATUS_DEFS[s].icon;
            return (
              <SelectItem key={s} value={s}>
                <Icon aria-hidden className="size-4 text-muted-foreground" />
                {EXPERIMENT_STATUS_DEFS[s].label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function ExperimentCard({ memory, ctx }: { memory: MemoryObjectView; ctx: TypedPageContext }) {
  const a = experimentAttributes(memory);
  const status = a.status ?? 'planned';
  return (
    <TypedCard
      memory={memory}
      ctx={ctx}
      headingLevel={4}
      meta={<MoveSelect memory={memory} ctx={ctx} status={status} />}
    >
      <p className="text-[13px] leading-5 text-muted-foreground">{displayContent(memory)}</p>
      <dl className="grid gap-2.5">
        {a.prediction ? <TypedField label="Prediction">{a.prediction}</TypedField> : null}
        {a.method ? <TypedField label="Method">{a.method}</TypedField> : null}
        {a.success_criteria || a.sample_size !== undefined ? (
          <TypedField label="Success criteria">
            {a.success_criteria ?? '—'}
            {a.sample_size !== undefined ? (
              <span className="block text-xs text-muted-foreground">
                Sample: {pluralize(a.sample_size, 'participant')}
              </span>
            ) : null}
          </TypedField>
        ) : null}
        {a.result ? <TypedField label="Result">{a.result}</TypedField> : null}
        {a.interpretation ? <TypedField label="Interpretation">{a.interpretation}</TypedField> : null}
        {a.decision ? <TypedField label="Resulting decision">{a.decision}</TypedField> : null}
        {status === 'completed' && !a.result ? (
          <p className="text-xs text-muted-foreground">
            Add the result and what it means — that’s what makes it evidence.
          </p>
        ) : null}
      </dl>
    </TypedCard>
  );
}

/** Experiment board: planned → running → completed (abandoned shown when present). */
export function ExperimentsView() {
  return (
    <TypedMemoryPage
      kind="experiment"
      title="Experiments"
      description="Tests of your riskiest assumptions: what you predicted, how you tested it, what happened and what it means."
      icon={FlaskConical}
      emptyTitle="No experiments yet"
      emptyDescription="Turn a risky assumption into a test: write the prediction first, then the method. Results become evidence Foundry Guide can cite."
    >
      {(items, ctx) => {
        const byStatus = new Map<ExperimentStatus, MemoryObjectView[]>(
          EXPERIMENT_STATUSES.map((s) => [s, []]),
        );
        for (const memory of items)
          byStatus.get(experimentAttributes(memory).status ?? 'planned')?.push(memory);
        const columns = EXPERIMENT_STATUSES.filter(
          (s) => s !== 'abandoned' || (byStatus.get(s)?.length ?? 0) > 0,
        );
        return (
          <div
            className={`grid gap-4 md:grid-cols-2 ${columns.length === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}
          >
            {columns.map((status) => {
              const list = byStatus.get(status) ?? [];
              return (
                <section
                  key={status}
                  aria-label={`${EXPERIMENT_STATUS_DEFS[status].label} experiments`}
                  className="grid content-start gap-3 rounded-xl bg-muted/40 p-3"
                >
                  <h2 className="flex items-center justify-between gap-2 px-1">
                    <TypedStatusBadge kind="experiment" status={status} />
                    <span className="tabular text-xs text-muted-foreground">{list.length}</span>
                  </h2>
                  {list.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                      Nothing {EXPERIMENT_STATUS_DEFS[status].label.toLowerCase()}.
                    </p>
                  ) : (
                    <ul className="grid gap-3">
                      {list.map((memory) => (
                        <li key={memory.id}>
                          <ExperimentCard memory={memory} ctx={ctx} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        );
      }}
    </TypedMemoryPage>
  );
}
