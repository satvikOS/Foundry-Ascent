import type { Claim, CoachResponse, EvidenceItem, ValidatorResults } from '@foundry/contracts';
import {
  ChevronRight,
  CircleDot,
  CircleHelp,
  ScanSearch,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { formatPercent, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';

import { EvidenceChip } from '../coach/response/evidence-chip';

/*
 * What sits behind an answer's prose: the claims with their sources, what is uncertain and the
 * challenge. Collapsed under "Sources & reasoning" in a conversation; read-only and self-contained, so
 * any screen that shows a stored answer (e.g. a calibration review) can render the same block.
 */

const UNCERTAINTY: Record<'low' | 'medium' | 'high', { label: string; icon: LucideIcon; className: string }> =
  {
    high: { label: 'High', icon: TriangleAlert, className: 'text-warning' },
    medium: { label: 'Medium', icon: CircleHelp, className: 'text-foreground' },
    low: { label: 'Low', icon: CircleDot, className: 'text-muted-foreground' },
  };

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h4 className="label-mono">{title}</h4>
      {children}
    </section>
  );
}

function ClaimRow({
  claim,
  evidence,
  onOpenSource,
}: {
  claim: Claim;
  evidence: ReadonlyMap<string, EvidenceItem>;
  onOpenSource?: ((key: string) => void) | undefined;
}) {
  return (
    <li className="grid gap-1.5 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
      <span className="sm:pt-0.5">
        <StatusBadge kind="claim" status={claim.kind} withTitle />
      </span>
      <p className="min-w-0 text-small leading-6">
        {claim.text}
        {claim.evidence_ids.length > 0 ? (
          <span className="ml-1 whitespace-nowrap">
            <span className="sr-only">Sources: </span>
            {claim.evidence_ids.map((key) => (
              <EvidenceChip key={key} evidenceKey={key} item={evidence.get(key)} onOpen={onOpenSource} />
            ))}
          </span>
        ) : claim.kind === 'fact' ? null : (
          <span className="ml-1.5 text-caption text-subtle-foreground">(no source cited)</span>
        )}
      </p>
    </li>
  );
}

/** Claims, uncertainty and challenge of one answer (read-only). */
export function ReasoningDetails({
  response,
  evidence,
  validator,
  onOpenSource,
}: {
  response: Pick<CoachResponse, 'claims' | 'uncertainty' | 'challenge'>;
  evidence: readonly EvidenceItem[];
  validator: ValidatorResults | null;
  /** Opens a cited source; chips are plain keys without it. */
  onOpenSource?: (key: string) => void;
}) {
  const byKey = useMemo(() => new Map(evidence.map((item) => [item.key, item])), [evidence]);
  const adjustments = groundingAdjustments(validator);
  return (
    <div className="grid gap-5">
      {response.claims.length > 0 ? (
        <Block title="Claims">
          <ul className="divide-y divide-border border-y border-border" aria-label="Claims and their sources">
            {response.claims.map((claim, index) => (
              <ClaimRow
                key={`${index}-${claim.text}`}
                claim={claim}
                evidence={byKey}
                onOpenSource={onOpenSource}
              />
            ))}
          </ul>
        </Block>
      ) : null}
      {response.uncertainty.length > 0 ? (
        <Block title="What’s uncertain">
          <ul className="grid gap-1.5">
            {response.uncertainty.map((u, index) => {
              const def = UNCERTAINTY[u.level];
              const Icon = def.icon;
              return (
                <li key={`${index}-${u.item}`} className="flex items-start gap-2 text-small leading-6">
                  <span
                    className={cn(
                      'mt-px inline-flex w-[4.5rem] shrink-0 items-center gap-1 text-caption font-medium',
                      def.className,
                    )}
                  >
                    <Icon aria-hidden className="size-3.5" />
                    {def.label}
                    <span className="sr-only"> uncertainty:</span>
                  </span>
                  <span>{u.item}</span>
                </li>
              );
            })}
          </ul>
        </Block>
      ) : null}
      {response.challenge ? (
        <Block title="Challenge">
          <p className="border-l-2 border-foreground/70 pl-3 font-serif text-[1.0625rem] leading-7">
            {response.challenge}
          </p>
        </Block>
      ) : null}
      {adjustments.length > 0 ? (
        <ul className="grid gap-1 text-caption text-muted-foreground">
          {adjustments.map((note) => (
            <li key={note} className="flex items-center gap-1.5">
              <ScanSearch aria-hidden className="size-3.5 shrink-0" />
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What the deterministic grounding checks changed in an answer (no content, counts only). */
export function groundingAdjustments(validator: ValidatorResults | null): string[] {
  if (!validator) return [];
  const notes: string[] = [];
  if (validator.factsDowngraded > 0) {
    notes.push(
      `Relabelled ${pluralize(validator.factsDowngraded, 'unsupported fact')} as ${
        validator.factsDowngraded === 1 ? 'an inference' : 'inferences'
      }.`,
    );
  }
  if (validator.unknownEvidenceIdsRemoved > 0) notes.push('Removed citations to unknown sources.');
  return notes;
}

/** A quiet line when the answer was narrowed to what the venture's evidence supports. */
export function NarrowedNote({ validator }: { validator: ValidatorResults | null }) {
  if (!validator?.narrowed) return null;
  return (
    <p
      data-testid="narrowed-banner"
      className="mb-3 flex items-start gap-2 text-small text-muted-foreground"
      role="note"
      aria-label="Answer limited to your evidence"
    >
      <ScanSearch aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>
        <span className="font-medium text-foreground">Limited to what your evidence supports.</span>{' '}
        {validator.groundingCoverage !== null
          ? `Grounding ${formatPercent(validator.groundingCoverage)}. `
          : ''}
        Treat the rest as open questions.
      </span>
    </p>
  );
}

/**
 * "Sources & reasoning": a disclosure under an answer that holds its claims, uncertainty and challenge,
 * and opens the panel on its sources.
 */
export function ReasoningDisclosure({
  response,
  evidence,
  validator,
  onOpenSource,
  onShowSources,
}: {
  response: Pick<CoachResponse, 'claims' | 'uncertainty' | 'challenge'>;
  evidence: readonly EvidenceItem[];
  validator: ValidatorResults | null;
  onOpenSource: (key: string) => void;
  onShowSources: () => void;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const hasDetails =
    response.claims.length > 0 || response.uncertainty.length > 0 || response.challenge !== null;
  if (!hasDetails && evidence.length === 0) return null;
  const summary = [
    evidence.length > 0 ? pluralize(evidence.length, 'source') : null,
    response.claims.length > 0 ? pluralize(response.claims.length, 'claim') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const toggleClasses =
    'group inline-flex h-8 items-center gap-1.5 rounded-md pr-1.5 text-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
  const sourcesButton = (label: string) => (
    <button
      type="button"
      onClick={onShowSources}
      className="justify-self-start text-small text-muted-foreground underline decoration-border-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {label}
    </button>
  );
  const sources = pluralize(evidence.length, 'source');

  if (!hasDetails) {
    return evidence.length > 0 ? <div className="mt-4">{sourcesButton(sources)}</div> : null;
  }
  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className={toggleClasses}
      >
        <ChevronRight
          aria-hidden
          className={cn('size-4 transition-transform duration-150', open && 'rotate-90')}
        />
        <span className="font-medium">Sources &amp; reasoning</span>
        {summary ? <span className="tabular text-subtle-foreground">{summary}</span> : null}
      </button>
      {open ? (
        <div id={regionId} className="mt-3 grid gap-4 border-l border-border pl-4">
          <ReasoningDetails
            response={response}
            evidence={evidence}
            validator={validator}
            onOpenSource={onOpenSource}
          />
          {evidence.length > 0 ? sourcesButton(`Open the ${sources}`) : null}
        </div>
      ) : null}
    </div>
  );
}
