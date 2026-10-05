import type { Me, VentureDetail } from '@foundry/contracts';
import { Bot, Eye, FlaskConical, UserRound } from 'lucide-react';

import { DbHealthIndicator } from '@/components/shell/db-health';
import { InspectorToggle } from '@/components/shell/inspector';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { StageChip } from '@/components/ui/stage-chip';
import { StatusBadge } from '@/components/ui/status-badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { canWrite, membershipFor, ROLE_LABELS } from '@/lib/auth/roles';

interface VentureContextBarProps {
  venture: VentureDetail;
  me: Me;
}

/**
 * Venture context bar (system-design §9): venture, stage, assigned guide + persona release, assigned
 * EIR, synthetic label, the viewer's role, DB health and the inspector toggle. On small screens the
 * secondary details collapse to keep the canvas visible.
 */
export function VentureContextBar({ venture, me }: VentureContextBarProps) {
  const membership = membershipFor(me, venture.id);
  const readOnly = !canWrite(me, venture.id);
  const persona = venture.persona;

  return (
    <div className="flex items-center gap-3 px-4 pt-3 sm:px-6 lg:px-8">
      <Avatar name={venture.name} shape="square" size="default" decorative />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[15px] leading-tight font-semibold tracking-tight">{venture.name}</p>
          <StageChip stage={venture.stage} className="hidden sm:inline-flex" />
          {venture.status !== 'active' ? <StatusBadge kind="venture" status={venture.status} /> : null}
          {venture.classification === 'synthetic' ? (
            <SimpleTooltip content="This venture and everyone in it are synthetic test data.">
              <Badge variant="outline" tabIndex={0} className="gap-1 border-dashed">
                <FlaskConical aria-hidden />
                Synthetic
              </Badge>
            </SimpleTooltip>
          ) : null}
        </div>
        <dl className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Coach</dt>
            <Bot aria-hidden className="size-3.5 shrink-0" />
            <dd className="flex items-center gap-1.5">
              {persona ? (
                <>
                  <span className="font-medium text-foreground">{persona.name}</span>
                  <span className="tabular">v{persona.version}</span>
                  {persona.status !== 'active' ? (
                    <StatusBadge kind="persona" status={persona.status} />
                  ) : null}
                  <span className="sr-only">(AI coach)</span>
                </>
              ) : (
                <span>No coach assigned</span>
              )}
            </dd>
          </div>
          {venture.assignedEir ? (
            <div className="hidden items-center gap-1.5 md:flex">
              <dt className="sr-only">Assigned EIR</dt>
              <UserRound aria-hidden className="size-3.5 shrink-0" />
              <dd className="flex items-center gap-1.5">
                <span>
                  EIR <span className="font-medium text-foreground">{venture.assignedEir.displayName}</span>
                </span>
                {venture.assignedEir.synthetic ? (
                  <Badge variant="muted" className="h-4 px-1 text-[10px]">
                    Synthetic
                  </Badge>
                ) : null}
              </dd>
            </div>
          ) : null}
          <div className="hidden items-center gap-1.5 sm:flex">
            <dt className="sr-only">Your role</dt>
            {readOnly ? <Eye aria-hidden className="size-3.5 shrink-0" /> : null}
            <dd>
              You: {membership ? ROLE_LABELS[membership.role] : 'Assigned EIR'}
              {readOnly ? ' (read-only)' : ''}
            </dd>
          </div>
        </dl>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <DbHealthIndicator />
        <InspectorToggle />
      </div>
    </div>
  );
}
