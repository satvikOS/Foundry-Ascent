import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCall } from '@/features/calls/call-context';
import { useVenture } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { veirDisplay, veirWelcome, type VeirDisplay } from '@/lib/veir';

import { useVeirWelcome } from './welcome';

/**
 * The welcome a person sees the first time they meet their vEIR: one calm screen with its face, two short
 * sentences on what it is (the EIR's digital twin, built with their consent from how they coach; who sees the
 * work) and one button. It is the disclosure, said once: conversations then carry only the vEIR badge.
 */
export function VeirWelcomeDialog({
  veir,
  open,
  onAcknowledge,
}: {
  veir: VeirDisplay;
  open: boolean;
  onAcknowledge: () => void;
}) {
  const welcome = veirWelcome(veir);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Seen is seen: closing it any way (Escape included) counts.
        if (!next) onAcknowledge();
      }}
    >
      <DialogContent
        hideClose
        data-slot="veir-welcome"
        className="max-w-sm justify-items-center gap-0 px-6 pt-8 pb-6 text-center"
      >
        <PersonaAvatar name={veir.name} portraitUrl={veir.portraitUrl} size="xl" decorative />
        <DialogTitle className="mt-5 font-serif text-heading font-normal text-balance">
          {welcome.title}
        </DialogTitle>
        <DialogDescription asChild>
          <div className="mt-3 grid gap-1.5 text-body text-pretty text-muted-foreground">
            {welcome.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </DialogDescription>
        <Button size="lg" className="mt-7 w-full" onClick={onAcknowledge} autoFocus>
          Continue
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shows the welcome over a venture to its founders and team the first time, while they have not read it and the
 * venture's coach is an EIR's vEIR. A call screen opened first says the same in its start screen instead.
 */
export function VeirWelcomeGate({ ventureId }: { ventureId: string }) {
  const me = useRequiredMe();
  const { route } = useCall();
  const writer = canWrite(me, ventureId);
  const venture = useVenture(ventureId);
  const [seen, acknowledge] = useVeirWelcome(me);
  const veir = writer ? veirDisplay(venture.data) : null;
  if (veir?.kind !== 'eir_persona') return null;
  return <VeirWelcomeDialog veir={veir} open={!seen && route?.open !== true} onAcknowledge={acknowledge} />;
}
