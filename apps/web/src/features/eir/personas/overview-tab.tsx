import type { PersonaView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { formatDate, formatNumber, pluralize } from '@/lib/format';
import { usePersonaLessons, usePersonaLibrary } from '@/lib/api/hooks/veir-pools';

import { ConsentIndicator } from './consent-indicator';
import { needsReview } from './lesson-labels';
import { librarySummary } from './library-labels';
import type { PersonaTab } from './persona-tabs';
import { pendingDrafts } from './release-drafts';

function PoolTile({
  label,
  value,
  detail,
  onOpen,
}: {
  label: string;
  value: ReactNode;
  detail: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group grid content-start gap-1.5 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="label-mono">{label}</span>
        <ArrowRight
          aria-hidden
          className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        />
      </span>
      <span className="tabular text-subheading font-medium">{value}</span>
      <span className="text-caption text-muted-foreground">{detail ?? ' '}</span>
    </button>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-small text-muted-foreground">{term}</dt>
      <dd className="text-small">{children}</dd>
    </div>
  );
}

/** Overview: what the vEIR is, who it is built from, where it coaches, and the state of its common pool. */
export function OverviewTab({
  persona,
  tenant,
  canSeeAssignments,
  onOpenTab,
}: {
  persona: PersonaView;
  tenant: string;
  /** Program leads manage assignments; link them there. */
  canSeeAssignments: boolean;
  onOpenTab: (tab: PersonaTab) => void;
}) {
  const library = usePersonaLibrary(persona.id);
  const lessons = usePersonaLessons(persona.id);
  const active = persona.activeRelease;
  const drafts = pendingDrafts(persona).length;
  const pool = library.data ? librarySummary(library.data) : null;
  const published = lessons.data?.filter((l) => l.status === 'published').length;
  const toReview = lessons.data?.filter(needsReview).length ?? 0;

  return (
    <div className="grid gap-10">
      {active ? (
        <p className="prose-reading">{active.doctrine.summary}</p>
      ) : (
        <p className="text-small text-muted-foreground">No approved release yet, so this vEIR can’t coach.</p>
      )}

      <section aria-labelledby="pool-heading" className="grid gap-3">
        <h2 id="pool-heading" className="font-serif text-subheading font-normal">
          Common pool
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <PoolTile
            label="Knowledge library"
            value={pool ? pluralize(pool.active, 'source') : '—'}
            detail={
              pool && (pool.processing > 0 || pool.failed > 0)
                ? [
                    pool.processing > 0 ? `${formatNumber(pool.processing)} processing` : null,
                    pool.failed > 0 ? `${formatNumber(pool.failed)} failed` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : null
            }
            onOpen={() => {
              onOpenTab('library');
            }}
          />
          <PoolTile
            label="Lessons"
            value={published === undefined ? '—' : `${formatNumber(published)} published`}
            detail={toReview > 0 ? `${formatNumber(toReview)} to review` : null}
            onOpen={() => {
              onOpenTab('lessons');
            }}
          />
          <PoolTile
            label="Releases"
            value={active ? `v${active.version} active` : 'None active'}
            detail={drafts > 0 ? `${pluralize(drafts, 'draft')} to approve` : null}
            onOpen={() => {
              onOpenTab('releases');
            }}
          />
        </div>
      </section>

      <section aria-labelledby="facts-heading" className="grid gap-2">
        <h2 id="facts-heading" className="font-serif text-subheading font-normal">
          Details
        </h2>
        <dl className="divide-y divide-border border-y border-border">
          <Fact term="Built from">
            {persona.eirProfile ? (
              <span className="grid gap-1.5">
                <span className="font-medium">{persona.eirProfile.displayName}</span>
                {persona.eirProfile.expertiseTags.length > 0 ? (
                  <ul aria-label="Expertise" className="flex flex-wrap gap-1">
                    {persona.eirProfile.expertiseTags.map((tag) => (
                      <li key={tag}>
                        <Badge variant="secondary">{tag}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </span>
            ) : (
              'The program’s neutral guide. Not a real person.'
            )}
          </Fact>
          <Fact term="Coaches">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {pluralize(persona.assignedVentureCount, 'venture')}
              {canSeeAssignments ? (
                <Link
                  to="/$tenant/app/program/assignments"
                  params={{ tenant }}
                  className="text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Assignments
                </Link>
              ) : null}
            </span>
          </Fact>
          <Fact term="Active release">
            {active
              ? `v${active.version}${active.approvedAt ? ` · approved ${formatDate(active.approvedAt)}` : ''}${
                  active.approvedBy ? ` by ${active.approvedBy.displayName}` : ''
                }`
              : 'None'}
          </Fact>
          {persona.kind === 'eir_persona' ? (
            <Fact term="Consent">
              <ConsentIndicator persona={persona} />
            </Fact>
          ) : null}
        </dl>
      </section>
    </div>
  );
}
