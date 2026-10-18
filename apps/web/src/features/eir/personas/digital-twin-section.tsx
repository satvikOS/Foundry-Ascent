import type {
  DigitalTwinView,
  PersonaView,
  TwinMediaKind,
  TwinMediaView,
  WithdrawableScope,
} from '@foundry/contracts';
import { TwinVendorRef } from '@foundry/contracts';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { useDigitalTwin, useUpdateTwinMedia, useWithdrawScope } from '@/lib/api/hooks/veir-pools';

/** The scopes a vEIR's twin rests on, each withdrawable on its own. */
const SCOPES: readonly {
  value: WithdrawableScope;
  key: keyof DigitalTwinView['scopes'];
  label: string;
  effect: string;
}[] = [
  {
    value: 'likeness',
    key: 'likeness',
    label: 'Likeness',
    effect: 'The face stops at once.',
  },
  {
    value: 'voice',
    key: 'voice',
    label: 'Voice',
    effect: 'A standard voice takes over at once.',
  },
  {
    value: 'first_person',
    key: 'firstPerson',
    label: 'First-person twin',
    effect: 'Shown as the EIR’s vEIR again.',
  },
];

const MEDIA: readonly { kind: TwinMediaKind; label: string; scope: 'likeness' | 'voice'; hint: string }[] = [
  {
    kind: 'face',
    label: 'HeyGen avatar ID',
    scope: 'likeness',
    hint: 'From LiveAvatar, once ready.',
  },
  {
    kind: 'voice',
    label: 'ElevenLabs voice ID',
    scope: 'voice',
    hint: 'From ElevenLabs, once verified.',
  },
];

const STATUS_BADGE = {
  pending: { label: 'Pending', variant: 'warning' },
  ready: { label: 'Ready', variant: 'success' },
  withdrawn: { label: 'Withdrawn', variant: 'muted' },
} as const;

function MediaRow({
  personaId,
  kind,
  label,
  hint,
  current,
  scopeGranted,
  canEdit,
}: {
  personaId: string;
  kind: TwinMediaKind;
  label: string;
  hint: string;
  current: TwinMediaView | null;
  scopeGranted: boolean;
  canEdit: boolean;
}) {
  const update = useUpdateTwinMedia(personaId);
  const savedRef = current && current.status !== 'withdrawn' ? current.vendorRef : '';
  const savedStatus = current?.status === 'pending' ? 'pending' : 'ready';
  const [ref, setRef] = useState(savedRef);
  const [status, setStatus] = useState<'pending' | 'ready'>(savedStatus);
  const trimmed = ref.trim();
  const invalid = trimmed !== '' && !TwinVendorRef.safeParse(trimmed).success;
  const changed = trimmed !== savedRef || (trimmed !== '' && status !== savedStatus);
  const badge = current ? STATUS_BADGE[current.status] : null;

  return (
    <li className="grid gap-3 py-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <Field
          label="ID"
          description={hint}
          error={invalid ? 'Use the ID exactly as shown there.' : undefined}
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            value={ref}
            disabled={!canEdit}
            onChange={(event) => {
              setRef(event.target.value);
              update.reset();
            }}
          />
        </Field>
        <SelectField
          label="Status"
          value={status}
          onChange={setStatus}
          disabled={!canEdit || trimmed === ''}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'ready', label: 'Ready' },
          ]}
        />
      </div>
      {canEdit && status === 'ready' && trimmed !== '' && !scopeGranted ? (
        <p className="text-small text-muted-foreground">Needs this scope in the consent first.</p>
      ) : null}
      <MutationErrorAlert error={update.error} title="Not saved" />
      {canEdit ? (
        <Button
          variant="secondary"
          className="w-fit"
          disabled={!changed || invalid}
          loading={update.isPending}
          loadingText="Saving…"
          onClick={() => {
            update.mutate(
              { kind, vendorRef: trimmed === '' ? null : trimmed, status },
              {
                onSuccess: () => {
                  const message = trimmed === '' ? `${label} removed` : `${label} saved`;
                  toast.success(message);
                  announce(message);
                },
              },
            );
          }}
        >
          Save
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Digital twin (the Consent tab): the scopes the EIR's consent covers for the twin (likeness for the video face,
 * voice for the cloned voice, first person for the name), each withdrawable on its own, and the vendor IDs of
 * the face and the voice. Curators record the IDs; withdrawing is the EIR's own act (a program lead's for a
 * fictional EIR).
 */
export function DigitalTwinSection({ persona }: { persona: PersonaView }) {
  const canSee = persona.canCurate === true;
  const twin = useDigitalTwin(persona.id, { enabled: canSee });
  const withdraw = useWithdrawScope(persona.id);
  const [withdrawing, setWithdrawing] = useState<(typeof SCOPES)[number] | null>(null);
  const canManage = persona.canManageConsent === true;
  const canEdit = canSee && persona.status !== 'retired';

  if (!canSee) return null;
  if (twin.isPending) {
    return (
      <LoadingRegion label="Loading the digital twin">
        <Skeleton className="h-40 rounded-xl" />
      </LoadingRegion>
    );
  }
  if (twin.isError) {
    return <ErrorState error={twin.error} onRetry={() => void twin.refetch()} retrying={twin.isRefetching} />;
  }
  const t = twin.data;

  return (
    <section aria-labelledby="twin-heading" className="grid gap-4" data-testid="digital-twin">
      <div className="grid gap-1">
        <h2 id="twin-heading" className="font-serif text-subheading font-normal">
          Digital twin
        </h2>
        <p className="text-small text-muted-foreground">
          Face and voice on calls, each under its own scope.
          {t.facesEnabled ? '' : ' Faces are off in Settings.'}
          {t.clonedVoiceEnabled ? '' : ' Cloned voices are off in Settings.'}
        </p>
      </div>

      <ul aria-label="Consent scopes" className="divide-y divide-border border-y border-border">
        {SCOPES.map((scope) => {
          const granted = t.scopes[scope.key];
          return (
            <li key={scope.value} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
              <span className="text-sm font-medium">{scope.label}</span>
              <Badge variant={granted ? 'success' : 'muted'}>{granted ? 'Granted' : 'Not granted'}</Badge>
              {granted && canManage && t.consentId !== null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-destructive"
                  onClick={() => {
                    setWithdrawing(scope);
                  }}
                >
                  Withdraw…
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <ul aria-label="Vendor IDs" className="divide-y divide-border border-b border-border">
        {MEDIA.map((media) => (
          <MediaRow
            // A saved change (or a withdrawal elsewhere) restarts the row from what the server holds.
            key={`${media.kind}:${t[media.kind]?.vendorRef ?? ''}:${t[media.kind]?.status ?? 'none'}`}
            personaId={persona.id}
            kind={media.kind}
            label={media.label}
            hint={media.hint}
            current={t[media.kind]}
            scopeGranted={t.scopes[media.scope]}
            canEdit={canEdit}
          />
        ))}
      </ul>

      <AlertDialog
        open={withdrawing !== null}
        onOpenChange={(open) => {
          if (!open && !withdraw.isPending) {
            setWithdrawing(null);
            withdraw.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw {withdrawing?.label.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>{withdrawing?.effect} The rest stays in force.</AlertDialogDescription>
          </AlertDialogHeader>
          <MutationErrorAlert error={withdraw.error} title="Not withdrawn" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdraw.isPending}>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={withdraw.isPending}
              loadingText="Withdrawing…"
              onClick={() => {
                if (!withdrawing || t.consentId === null) return;
                withdraw.mutate(
                  { consentId: t.consentId, assetType: withdrawing.value },
                  {
                    onSuccess: () => {
                      const message = `${withdrawing.label} withdrawn`;
                      toast.success(message);
                      announce(message, 'assertive');
                      setWithdrawing(null);
                    },
                  },
                );
              }}
            >
              Withdraw
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
