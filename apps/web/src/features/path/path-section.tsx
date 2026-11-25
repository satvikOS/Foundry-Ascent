import type { VenturePath } from '@foundry/contracts';

import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { useVenturePath } from '@/lib/api/hooks/path';

import { stageLine } from './plan';
import { StepCard, tickedLine } from './step-card';

/** The path in the context panel: the stage and the current step, acted on in place. Nothing while there is no path. */
export function PathSection({
  tenant,
  ventureId,
  path,
}: {
  tenant: string;
  ventureId: string;
  path: VenturePath | null;
}) {
  if (!path?.now) return null;
  return (
    <CollapsibleSection
      id="path"
      title="Your path"
      meta={tickedLine(path.now) ?? undefined}
      metaLabel="ticked"
    >
      <p className="mb-2 text-caption text-muted-foreground">{stageLine(path)}</p>
      <StepCard
        key={path.now.id}
        tenant={tenant}
        ventureId={ventureId}
        step={path.now}
        canEdit
        dense
        headingLevel={4}
        className="border-0 bg-transparent p-0"
      />
    </CollapsibleSection>
  );
}

/**
 * A conversation that has just opened, before its first message: the step the opening line asks about, one press from
 * what happened to it (Done, Not yet, Changed plan).
 */
export function OpeningStep({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  const path = useVenturePath(ventureId);
  const now = path.data?.now;
  if (!now) return null;
  return <StepCard key={now.id} tenant={tenant} ventureId={ventureId} step={now} canEdit expanded={false} />;
}
