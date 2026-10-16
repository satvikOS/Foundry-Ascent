import type { PersonaView } from '@foundry/contracts';
import { CircleMinus, FileCheck, FileX } from 'lucide-react';

import { cn } from '@/lib/utils';

import { CONSENT_NEEDED, consentState } from './persona-labels';

const CONSENT = {
  not_required: {
    label: 'Not required',
    icon: CircleMinus,
    className: 'text-muted-foreground',
    description: 'Not a real person — no consent needed.',
  },
  on_file: {
    label: 'Consent on file',
    icon: FileCheck,
    className: 'text-foreground',
    description: 'A signed consent covers this persona’s doctrine.',
  },
  missing: {
    label: 'No consent record',
    icon: FileX,
    className: 'text-warning',
    description: CONSENT_NEEDED,
  },
} as const;

/** Icon + text consent status (never colour alone). */
export function ConsentIndicator({
  persona,
  showDescription = false,
  className,
}: {
  persona: Pick<PersonaView, 'kind' | 'hasConsent'>;
  showDescription?: boolean;
  className?: string;
}) {
  const def = CONSENT[consentState(persona)];
  const Icon = def.icon;
  return (
    <span
      className={cn('inline-flex flex-col gap-0.5', className)}
      title={showDescription ? undefined : def.description}
    >
      <span className={cn('inline-flex items-center gap-1 text-[13px] font-medium', def.className)}>
        <Icon aria-hidden className="size-3.5" />
        {def.label}
      </span>
      {showDescription ? <span className="text-xs text-muted-foreground">{def.description}</span> : null}
    </span>
  );
}
