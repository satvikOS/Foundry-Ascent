import { zodResolver } from '@hookform/resolvers/zod';
import type { ConsentView, PersonaView } from '@foundry/contracts';
import { FileCheck, FilePlus2, FileX } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { applyServerFieldErrors, MutationErrorAlert, todayDateInput } from '@/features/admin/shared/form';
import { formatDate, pluralize } from '@/lib/format';
import { usePersonaConsents, useRecordConsent, useRevokeConsent } from '@/lib/api/hooks/veir-pools';

import {
  assetLabel,
  CONSENT_ASSETS,
  ConsentForm,
  consentStatus,
  consentToForm,
  formToConsent,
  reliedOnConsent,
  type ConsentFormValues,
} from './consent-form';
import { ConsentIndicator } from './consent-indicator';

const STATUS_BADGE = {
  in_force: { label: 'In force', variant: 'success' },
  revoked: { label: 'Revoked', variant: 'muted' },
  expired: { label: 'Expired', variant: 'warning' },
} as const;

function RecordConsentDialog({
  persona,
  eirName,
  current,
  open,
  onOpenChange,
}: {
  persona: PersonaView;
  eirName: string;
  current: ConsentView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const record = useRecordConsent(persona.id);
  const assetsId = useId();
  const { register, control, handleSubmit, formState, setError, reset } = useForm<ConsentFormValues>({
    resolver: zodResolver(ConsentForm),
    defaultValues: consentToForm(current),
  });
  const e = formState.errors;
  const close = () => {
    if (record.isPending) return;
    record.reset();
    reset(consentToForm(current));
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record {eirName}’s consent</DialogTitle>
          <DialogDescription>
            {current
              ? `${persona.name} relies on the new record from now on and drops a voice or portrait it doesn’t cover. The current record stays in force until revoked.`
              : `${persona.name} relies on it from now on.`}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-5"
          onSubmit={(event) =>
            void handleSubmit((values) => {
              record.mutate(formToConsent(values), {
                onSuccess: () => {
                  toast.success('Consent recorded');
                  announce('Consent recorded');
                  record.reset();
                  onOpenChange(false);
                },
                onError: (error) => {
                  applyServerFieldErrors(
                    error,
                    setError,
                    ['assetTypes', 'approvedUses', 'audiences', 'evidenceRef'],
                    (path) => (path === 'expiresAt' ? 'expires' : path),
                  );
                },
              });
            })(event)
          }
        >
          <Controller
            control={control}
            name="assetTypes"
            render={({ field }) => (
              <fieldset
                className="grid gap-2"
                aria-describedby={e.assetTypes ? `${assetsId}-error` : undefined}
              >
                <legend className="mb-1 text-sm font-medium">Covers</legend>
                {CONSENT_ASSETS.map((asset, index) => {
                  const id = `${assetsId}-${asset.value}`;
                  return (
                    <div key={asset.value} className="flex items-start gap-2.5">
                      <Checkbox
                        id={id}
                        className="mt-0.5"
                        ref={index === 0 ? field.ref : undefined}
                        checked={asset.required === true || field.value.includes(asset.value)}
                        disabled={asset.required === true}
                        aria-describedby={`${id}-desc`}
                        onCheckedChange={(checked) => {
                          field.onChange(
                            checked === true
                              ? [...field.value, asset.value]
                              : field.value.filter((a) => a !== asset.value),
                          );
                        }}
                      />
                      <div className="grid gap-0.5">
                        <Label htmlFor={id}>{asset.label}</Label>
                        <span id={`${id}-desc`} className="text-caption text-muted-foreground">
                          {asset.description}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {e.assetTypes?.message ? (
                  <p id={`${assetsId}-error`} className="text-small text-destructive">
                    {e.assetTypes.message}
                  </p>
                ) : null}
              </fieldset>
            )}
          />
          <Field label="Approved uses" description="Comma-separated." error={e.approvedUses?.message}>
            <Input
              autoComplete="off"
              placeholder="Coaching founders in this program"
              {...register('approvedUses')}
            />
          </Field>
          <Field label="Audiences" description="Comma-separated." error={e.audiences?.message}>
            <Input autoComplete="off" placeholder="Program founders" {...register('audiences')} />
          </Field>
          <Field label="Evidence" description="Where the signed form is kept." error={e.evidenceRef?.message}>
            <Input autoComplete="off" {...register('evidenceRef')} />
          </Field>
          <Field label="Expires" description="Leave empty for no end date." error={e.expires?.message}>
            <Input type="date" min={todayDateInput()} className="w-48" {...register('expires')} />
          </Field>
          <MutationErrorAlert error={record.error} title="Consent wasn’t recorded" />
          <DialogFooter>
            <Button variant="secondary" onClick={close} disabled={record.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={record.isPending} loadingText="Recording…">
              Record consent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConsentItem({
  consent,
  canRevoke,
  onRevoke,
}: {
  consent: ConsentView;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const status = consentStatus(consent);
  const badge = STATUS_BADGE[status];
  const dependents = consent.personas ?? [];
  return (
    <li className="grid gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge variant={badge.variant}>
          {status === 'revoked' && consent.revokedAt
            ? `Revoked ${formatDate(consent.revokedAt)}`
            : badge.label}
        </Badge>
        <span className="text-small text-muted-foreground">
          Granted {formatDate(consent.grantedAt)}
          {consent.expiresAt ? ` · until ${formatDate(consent.expiresAt)}` : ''}
        </span>
        {canRevoke && status === 'in_force' ? (
          <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={onRevoke}>
            Revoke…
          </Button>
        ) : null}
      </div>
      <dl className="grid gap-2 text-small sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Covers</dt>
        <dd className="flex flex-wrap gap-1">
          {consent.assetTypes.map((asset) => (
            <Badge key={asset} variant="secondary">
              {assetLabel(asset)}
            </Badge>
          ))}
        </dd>
        {consent.approvedUses.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Uses</dt>
            <dd>{consent.approvedUses.join(', ')}</dd>
          </>
        ) : null}
        {consent.audiences.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Audiences</dt>
            <dd>{consent.audiences.join(', ')}</dd>
          </>
        ) : null}
        {consent.evidenceRef ? (
          <>
            <dt className="text-muted-foreground">Evidence</dt>
            <dd className="break-words">{consent.evidenceRef}</dd>
          </>
        ) : null}
        {dependents.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Relied on by</dt>
            <dd>{dependents.map((p) => p.name).join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

/**
 * Consent: the EIR's signed consent behind this vEIR. Recording a consent is the subject's own act (a
 * program lead may record it for a synthetic EIR); revoking it suspends every vEIR that relies on it.
 */
export function ConsentTab({ persona }: { persona: PersonaView }) {
  const canSee = persona.canCurate === true;
  const consents = usePersonaConsents(persona.id, { enabled: canSee });
  const revoke = useRevokeConsent(persona.id);
  const [recording, setRecording] = useState(false);
  const [revoking, setRevoking] = useState<ConsentView | null>(null);
  const eirName = persona.eirProfile?.displayName ?? 'the EIR';
  const canManage = persona.canManageConsent === true;

  if (!canSee) {
    return (
      <div className="grid max-w-xl gap-3">
        <ConsentIndicator persona={persona} showDescription />
        <p className="text-small text-muted-foreground">
          Only {eirName} and program leads see consent records.
        </p>
      </div>
    );
  }
  if (consents.isPending) {
    return (
      <LoadingRegion label="Loading consent">
        <Skeleton className="h-48 rounded-xl" />
      </LoadingRegion>
    );
  }
  if (consents.isError) {
    return (
      <ErrorState
        error={consents.error}
        onRetry={() => void consents.refetch()}
        retrying={consents.isRefetching}
      />
    );
  }

  const items = consents.data;
  const relied = reliedOnConsent(persona.id, items);
  // The record a new one starts from: the one in use while it is in force, else any in force.
  const current =
    relied.state === 'in_force' || relied.state === 'no_doctrine'
      ? relied.consent
      : (items.find((c) => consentStatus(c) === 'in_force') ?? null);
  const activeDependents = (revoking?.personas ?? []).filter((p) => p.status === 'active');
  const recordButton = canManage ? (
    <Button
      onClick={() => {
        setRecording(true);
      }}
    >
      <FilePlus2 aria-hidden />
      Record consent
    </Button>
  ) : null;

  return (
    <div className="grid gap-5">
      {items.length === 0 ? (
        <EmptyState
          icon={FileX}
          size="sm"
          headingLevel={2}
          title="No consent recorded"
          description={`${canManage ? '' : `Only ${eirName} can record it. `}${persona.name} can’t be approved or speak without it.`}
          action={recordButton}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <p className="flex items-center gap-2 text-small text-muted-foreground">
                {relied.state === 'in_force' ? (
                  <FileCheck aria-hidden className="size-4 text-foreground" />
                ) : (
                  <FileX aria-hidden className="size-4 text-warning" />
                )}
                {relied.state === 'in_force'
                  ? `${eirName}’s consent is in force.`
                  : relied.state === 'no_doctrine'
                    ? `The consent in use doesn’t cover doctrine, so ${persona.name} can’t be approved or resumed.`
                    : `No consent in force. ${persona.name} can’t run without one.`}
              </p>
              {canManage ? null : (
                <p className="text-small text-muted-foreground">Only {eirName} can record or revoke it.</p>
              )}
            </div>
            {recordButton}
          </div>
          <ul
            aria-label="Consent records"
            className="divide-y divide-border rounded-xl border border-border bg-card"
          >
            {items.map((consent) => (
              <ConsentItem
                key={consent.id}
                consent={consent}
                canRevoke={canManage}
                onRevoke={() => {
                  setRevoking(consent);
                }}
              />
            ))}
          </ul>
        </>
      )}

      {canManage ? (
        <RecordConsentDialog
          key={current?.id ?? 'none'}
          persona={persona}
          eirName={eirName}
          current={current}
          open={recording}
          onOpenChange={setRecording}
        />
      ) : null}

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) {
            setRevoking(null);
            revoke.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this consent?</AlertDialogTitle>
            <AlertDialogDescription>
              {activeDependents.length > 0
                ? `${activeDependents.map((p) => p.name).join(', ')} ${activeDependents.length === 1 ? 'is' : 'are'} suspended at once${
                    activeDependents.some((p) => p.id === persona.id)
                      ? `, pausing coaching for ${pluralize(persona.assignedVentureCount, 'venture')}`
                      : ''
                  }. A new consent and a resume bring ${activeDependents.length === 1 ? 'it' : 'them'} back.`
                : 'No active vEIR relies on it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <MutationErrorAlert error={revoke.error} title="Consent wasn’t revoked" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Keep consent</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={revoke.isPending}
              loadingText="Revoking…"
              onClick={() => {
                if (!revoking) return;
                revoke.mutate(revoking.id, {
                  onSuccess: (result) => {
                    const message =
                      result.suspendedPersonaIds.length > 0
                        ? `Consent revoked · ${pluralize(result.suspendedPersonaIds.length, 'vEIR')} suspended`
                        : 'Consent revoked';
                    toast.success(message);
                    announce(message, 'assertive');
                    setRevoking(null);
                  },
                });
              }}
            >
              Revoke consent
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
