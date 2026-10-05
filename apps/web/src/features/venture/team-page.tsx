import { zodResolver } from '@hookform/resolvers/zod';
import { MembershipRole } from '@foundry/contracts';
import { getRouteApi } from '@tanstack/react-router';
import { FlaskConical, KeyRound, ShieldAlert, UserPlus, Users } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
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
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import { useInviteMember, useTeam } from '@/lib/api/hooks/team';
import { hasAnyRole, ROLE_LABELS } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate, formatDateTime, isoString } from '@/lib/format';
import { cn } from '@/lib/utils';

import { applyFieldErrors } from './form-errors';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/team');

type Role = z.infer<typeof MembershipRole>;

export const MEMBERSHIP_ROLE_DESCRIPTIONS: Record<Role, string> = {
  founder: 'Full workspace, including their own founder-only items. Can consent to sharing with humans.',
  team: 'Full workspace for day-to-day work: sessions, memory approvals, documents.',
  advisor: 'Reads venture- and advisor-visible items only. Can’t see founder-only or team items.',
};

const InviteSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter their name.').max(120, 'Keep it under 120 characters.'),
  email: z
    .string()
    .trim()
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email or leave it blank.'),
  title: z.string().trim().max(120, 'Keep it under 120 characters.'),
  role: MembershipRole,
  expiresInDays: z
    .number({ error: 'Enter a number of days.' })
    .int('Use whole days.')
    .min(1, 'At least 1 day.')
    .max(365, 'At most 365 days.'),
});
type InviteInput = z.input<typeof InviteSchema>;
type InviteOutput = z.output<typeof InviteSchema>;

function InviteDialog({
  ventureId,
  open,
  onOpenChange,
}: {
  ventureId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invite = useInviteMember(ventureId);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const roleId = useId();
  const { register, control, handleSubmit, reset, formState, setError } = useForm<
    InviteInput,
    unknown,
    InviteOutput
  >({
    resolver: zodResolver(InviteSchema),
    defaultValues: { displayName: '', email: '', title: '', role: 'team', expiresInDays: 90 },
  });

  useEffect(() => {
    if (open) {
      setFormError(null);
      setCopied(false);
      setConfirmClose(false);
      reset({ displayName: '', email: '', title: '', role: 'team', expiresInDays: 90 });
    }
  }, [open, reset]);

  const issued = invite.data ?? null;

  const close = () => {
    // Drop the one-time code from memory as soon as the dialog closes.
    invite.reset();
    onOpenChange(false);
  };

  const requestClose = (next: boolean) => {
    if (next) return;
    if (issued && !copied) {
      setConfirmClose(true);
      return;
    }
    close();
  };

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    invite.mutate(
      {
        displayName: values.displayName,
        email: values.email || null,
        title: values.title || null,
        role: values.role,
        expiresInDays: values.expiresInDays,
      },
      {
        onSuccess: () => {
          announce('Invitation created. The one-time access code is shown.');
        },
        onError: (error) => {
          if (
            !applyFieldErrors(error, setError, ['displayName', 'email', 'title', 'role', 'expiresInDays'])
          ) {
            setFormError(errorMessage(error));
          }
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="max-w-lg">
        {issued ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Access code for {issued.principal.displayName}</DialogTitle>
              <DialogDescription>
                Share it privately — in person or over an encrypted channel.
              </DialogDescription>
            </DialogHeader>
            <Alert variant="warning" icon={ShieldAlert} title="Shown once">
              Copy this code now. It can’t be shown again; if it’s lost, issue a new one. Never paste it into
              shared documents or chats.
            </Alert>
            <div className="flex items-center gap-2 rounded-lg border border-border-strong bg-muted px-3 py-3">
              <KeyRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <code
                className="min-w-0 flex-1 font-mono text-[15px] tracking-wider break-all select-all"
                aria-label="One-time access code"
                data-private
              >
                {issued.accessCode}
              </code>
              <CopyButton
                value={issued.accessCode}
                label="Copy code"
                showLabel
                variant="secondary"
                onCopied={() => {
                  setCopied(true);
                  setConfirmClose(false);
                }}
              />
            </div>
            <p className="text-[13px] text-muted-foreground">
              {issued.expiresAt ? `Expires ${formatDateTime(issued.expiresAt)}.` : 'Does not expire.'} They
              sign in with it at the Foundry Ascent sign-in page.
            </p>
            {confirmClose ? (
              <Alert
                variant="destructive"
                live="alert"
                title="You haven’t copied the code"
                action={
                  <Button size="sm" variant="destructive-outline" onClick={close}>
                    Close anyway
                  </Button>
                }
              >
                Once closed, it can’t be shown again.
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                onClick={() => {
                  requestClose(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Invite to venture</DialogTitle>
              <DialogDescription>
                Creates their account and a one-time access code. Use synthetic identities only in this
                environment.
              </DialogDescription>
            </DialogHeader>
            {formError ? (
              <Alert variant="destructive" live="alert">
                {formError}
              </Alert>
            ) : null}
            <Field label="Name" required error={formState.errors.displayName?.message}>
              <Input {...register('displayName')} maxLength={120} autoComplete="off" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email (optional)" error={formState.errors.email?.message}>
                <Input type="email" {...register('email')} autoComplete="off" />
              </Field>
              <Field label="Title (optional)" error={formState.errors.title?.message}>
                <Input {...register('title')} maxLength={120} autoComplete="off" />
              </Field>
            </div>
            <fieldset className="grid gap-2">
              <legend id={roleId} className="mb-2 text-sm font-medium">
                Role
              </legend>
              <Controller
                control={control}
                name="role"
                render={({ field }) => (
                  <RadioGroup
                    aria-labelledby={roleId}
                    value={field.value}
                    onValueChange={field.onChange}
                    className="gap-2"
                  >
                    {MembershipRole.options.map((role) => {
                      const itemId = `${roleId}-${role}`;
                      return (
                        <label
                          key={role}
                          htmlFor={itemId}
                          className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-accent/50',
                            field.value === role ? 'border-foreground/60' : 'border-border',
                          )}
                        >
                          <RadioGroupItem id={itemId} value={role} className="mt-0.5" />
                          <span className="grid gap-0.5">
                            <span className="text-sm font-medium">{ROLE_LABELS[role]}</span>
                            <span className="text-[13px] text-muted-foreground">
                              {MEMBERSHIP_ROLE_DESCRIPTIONS[role]}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </RadioGroup>
                )}
              />
            </fieldset>
            <Field
              label="Access lasts (days)"
              description="Membership and the code expire after this many days."
              error={formState.errors.expiresInDays?.message}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                className="w-32"
                {...register('expiresInDays', { valueAsNumber: true })}
              />
            </Field>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  close();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={invite.isPending} loadingText="Creating…">
                <UserPlus aria-hidden />
                Create invitation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TeamPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  const team = useTeam(ventureId);
  const canInvite = hasAnyRole(me, ['program_lead', 'platform_admin']);
  const [inviting, setInviting] = useState(false);

  const members = [...(team.data ?? [])].sort(
    (a, b) =>
      MembershipRole.options.indexOf(a.role) - MembershipRole.options.indexOf(b.role) ||
      a.principal.displayName.localeCompare(b.principal.displayName),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Team"
        description="People with access to this venture’s workspace, and what each role can see."
        actions={
          canInvite ? (
            <Button
              onClick={() => {
                setInviting(true);
              }}
            >
              <UserPlus aria-hidden />
              Invite
            </Button>
          ) : null
        }
      />

      {team.isError ? (
        <ErrorState error={team.error} onRetry={() => void team.refetch()} />
      ) : team.isPending ? (
        <div aria-busy="true" className="overflow-hidden rounded-xl border border-border bg-card">
          <span className="sr-only" role="status">
            Loading team…
          </span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members yet"
          description={
            canInvite ? 'Invite the founders first.' : 'A program lead adds members to the venture.'
          }
        />
      ) : (
        <Table aria-label="Team members">
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead>Access until</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.principal.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar name={member.principal.displayName} decorative />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {member.principal.displayName}
                        {member.principal.id === me.principal.id ? (
                          <span className="text-xs font-normal text-muted-foreground">(you)</span>
                        ) : null}
                        {member.principal.synthetic ? (
                          <Badge variant="outline" className="gap-1 border-dashed">
                            <FlaskConical aria-hidden />
                            Synthetic
                          </Badge>
                        ) : null}
                      </p>
                      {member.principal.title ? (
                        <p className="text-xs text-muted-foreground">{member.principal.title}</p>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-medium">{ROLE_LABELS[member.role]}</span>
                  <p className="max-w-xs text-xs text-muted-foreground">
                    {MEMBERSHIP_ROLE_DESCRIPTIONS[member.role]}
                  </p>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={isoString(member.grantedAt)}>{formatDate(member.grantedAt)}</time>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {member.expiresAt ? (
                    <time dateTime={isoString(member.expiresAt)}>{formatDate(member.expiresAt)}</time>
                  ) : (
                    'No expiry'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {canInvite ? <InviteDialog ventureId={ventureId} open={inviting} onOpenChange={setInviting} /> : null}
    </PageContainer>
  );
}
