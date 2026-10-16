import type { PersonaView } from '@foundry/contracts';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { SelectField } from '@/components/ui/select-field';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { type ProgramVenture } from '@/lib/api/hooks/program';
import { type EirProfile, useAssignPersona } from '@/lib/api/hooks/veir-pools';

import { assignmentRequest, isAssignable, isCurrentAssignment } from './assignment';

const NOBODY = 'none';

interface AssignDialogProps {
  venture: ProgramVenture | null;
  personas: readonly PersonaView[];
  eirProfiles: readonly EirProfile[];
  onClose: () => void;
}

/** Choose a venture's vEIR (and, for the program guide, who reviews it). One active assignment per venture. */
export function AssignDialog({ venture, personas, eirProfiles, onClose }: AssignDialogProps) {
  return (
    <Dialog
      open={venture !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {venture ? (
          <AssignForm
            key={venture.id}
            venture={venture}
            personas={personas}
            eirProfiles={eirProfiles}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AssignForm({
  venture,
  personas,
  eirProfiles,
  onClose,
}: {
  venture: ProgramVenture;
  personas: readonly PersonaView[];
  eirProfiles: readonly EirProfile[];
  onClose: () => void;
}) {
  const assign = useAssignPersona();
  const options = personas.filter(isAssignable);
  const unavailable = personas.filter((p) => !isAssignable(p) && p.status !== 'retired').length;
  const [personaId, setPersonaId] = useState<string>(
    options.find((p) => p.id === venture.personaId)?.id ?? options[0]?.id ?? '',
  );
  const [eirId, setEirId] = useState<string>(venture.reviewingEir?.id ?? NOBODY);
  const persona = options.find((p) => p.id === personaId) ?? null;
  const request = persona ? assignmentRequest(persona, eirId === NOBODY ? null : eirId) : null;
  const unchanged = request !== null && isCurrentAssignment(venture, request);
  // Any change, the reviewer alone included, starts a new assignment, which ends open conversations.
  const endingWith = request !== null && !unchanged ? venture.personaName : null;
  const reviewers = eirProfiles.filter((e) => e.status === 'active');

  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!request || !persona || unchanged) return;
        assign.mutate(
          { ventureId: venture.id, input: request },
          {
            onSuccess: () => {
              const message = `${persona.name} now coaches ${venture.name}`;
              toast.success(message);
              announce(message);
              onClose();
            },
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>vEIR for {venture.name}</DialogTitle>
        <DialogDescription>
          {endingWith
            ? `Open conversations with ${endingWith} end at their next message.`
            : 'Who coaches this venture, and who reviews it.'}
        </DialogDescription>
      </DialogHeader>

      {options.length === 0 ? (
        <p className="text-small text-muted-foreground">No vEIR is ready: approve a release first.</p>
      ) : (
        <SelectField
          label="vEIR"
          value={personaId}
          onChange={setPersonaId}
          options={options.map((p) => ({ value: p.id, label: p.name }))}
          description={
            unavailable > 0
              ? 'Suspended vEIRs and those without an approved release aren’t listed.'
              : undefined
          }
        />
      )}

      {persona?.kind === 'eir_persona' ? (
        <div className="grid gap-1">
          <p className="text-sm font-medium">Reviewed by</p>
          <p className="text-small text-muted-foreground">
            {persona.eirProfile ? `${persona.eirProfile.displayName}, the EIR it’s built from.` : 'Nobody.'}
          </p>
        </div>
      ) : persona ? (
        <SelectField
          label="Reviewed by"
          value={eirId}
          onChange={setEirId}
          options={[
            { value: NOBODY, label: 'Nobody' },
            ...reviewers.map((e) => ({ value: e.id, label: e.displayName })),
          ]}
          description="The EIR who reviews sampled answers."
        />
      ) : null}

      <MutationErrorAlert error={assign.error} title="Not assigned" />
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={assign.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={assign.isPending}
          loadingText="Assigning…"
          disabled={!request || unchanged}
        >
          Assign
        </Button>
      </DialogFooter>
    </form>
  );
}
