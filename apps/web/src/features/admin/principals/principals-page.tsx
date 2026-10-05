import { CircleCheck, CircleSlash, KeyRound, Plus, Search, SearchX, Trash2, Users } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import { usePrincipals, useRevokeAccessCode, type AdminPrincipal } from '@/lib/api/hooks/admin';
import { ROLE_LABELS } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate, formatRelative, pluralize } from '@/lib/format';

import { CreatePrincipalDialog } from './create-principal-dialog';
import { IssueAccessCodeDialog, type CodeRecipient } from './issue-access-code-dialog';

type ActiveCode = AdminPrincipal['activeAccessCodes'][number];
type RoleFilter = 'all' | 'platform_admin' | 'program_lead' | 'eir' | 'venture_only';

const ROLE_FILTERS: { value: RoleFilter; label: string }[] = [
  { value: 'all', label: 'All roles' },
  { value: 'platform_admin', label: ROLE_LABELS.platform_admin },
  { value: 'program_lead', label: ROLE_LABELS.program_lead },
  { value: 'eir', label: ROLE_LABELS.eir },
  { value: 'venture_only', label: 'Venture members only' },
];

/** "FA-ABCDE-•••••-•••••-•••••": the public lookup prefix with the secret part masked. */
export function maskedCode(prefix: string): string {
  const group = prefix.replace(/^FA-/i, '').slice(0, 5).toUpperCase();
  return `FA-${group}-•••••-•••••-•••••`;
}

function matchesRole(row: AdminPrincipal, filter: RoleFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'venture_only') return row.roles.length === 0;
  return row.roles.includes(filter);
}

/** Admin → Principals: people, roles, memberships and their active access codes. */
export function PrincipalsPage() {
  const me = useRequiredMe();
  const principals = usePrincipals();
  const revoke = useRevokeAccessCode();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [issueFor, setIssueFor] = useState<CodeRecipient | null>(null);
  const [revoking, setRevoking] = useState<{ code: ActiveCode; owner: string } | null>(null);
  const searchId = useId();

  const all = useMemo(() => principals.data ?? [], [principals.data]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter(
        (row) =>
          matchesRole(row, role) &&
          (!needle ||
            [row.principal.displayName, row.email ?? '', row.principal.title ?? ''].some((text) =>
              text.toLowerCase().includes(needle),
            )),
      )
      .sort((a, b) => a.principal.displayName.localeCompare(b.principal.displayName));
  }, [all, query, role]);

  const activeCodes = all.reduce((sum, row) => sum + row.activeAccessCodes.length, 0);

  const confirmRevoke = () => {
    if (!revoking) return;
    const { code, owner } = revoking;
    revoke.mutate(code.id, {
      onSuccess: () => {
        toast.success(`Revoked ${owner}’s code “${code.label}”`);
        announce('Access code revoked');
      },
      onError: (error) => {
        toast.error(errorMessage(error));
      },
    });
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Principals"
        description="Everyone who can sign in, their roles and access codes. Codes are stored as hashes and shown only once."
        actions={
          <Button
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus aria-hidden />
            Add principal
          </Button>
        }
      >
        <div
          role="search"
          aria-label="Filter principals"
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
        >
          <div className="relative w-full sm:max-w-xs">
            <label htmlFor={searchId} className="sr-only">
              Search principals
            </label>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search name, email or title"
              className="pl-8"
            />
          </div>
          <Select
            value={role}
            onValueChange={(value) => {
              const match = ROLE_FILTERS.find((f) => f.value === value);
              if (match) setRole(match.value);
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Filter by role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[13px] text-muted-foreground sm:ml-auto" aria-live="polite">
            {principals.isSuccess
              ? `${pluralize(rows.length, 'person', 'people')} · ${pluralize(activeCodes, 'active code')}`
              : null}
          </p>
        </div>
      </PageHeader>

      {principals.isPending ? (
        <LoadingRegion label="Loading principals">
          <Skeleton className="h-72 rounded-xl" />
        </LoadingRegion>
      ) : principals.isError ? (
        <ErrorState
          error={principals.error}
          onRetry={() => void principals.refetch()}
          retrying={principals.isRefetching}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={all.length === 0 ? Users : SearchX}
          title={all.length === 0 ? 'No principals yet' : 'No one matches'}
          description={
            all.length === 0 ? 'Add a person, then issue them an access code.' : 'Try another search or role.'
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Person</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Roles</TableHead>
              <TableHead scope="col">Ventures</TableHead>
              <TableHead scope="col">Active access codes</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isMe = row.principal.id === me.principal.id;
              return (
                <TableRow key={row.principal.id} className="align-top">
                  <TableCell className="min-w-64 align-top">
                    <div className="flex items-start gap-2.5">
                      <Avatar name={row.principal.displayName} size="sm" decorative className="mt-0.5" />
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-medium">
                          <span className="whitespace-nowrap">{row.principal.displayName}</span>
                          {isMe ? <Badge variant="outline">You</Badge> : null}
                          {row.principal.synthetic ? <Badge variant="muted">Synthetic</Badge> : null}
                        </p>
                        {row.principal.title ? (
                          <p className="text-[13px] text-muted-foreground">{row.principal.title}</p>
                        ) : null}
                        {row.email ? (
                          <p className="text-[13px] break-all text-muted-foreground">{row.email}</p>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    {row.status === 'active' ? (
                      <Badge variant="outline" className="border-solid">
                        <CircleCheck aria-hidden />
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="muted" className="border-dotted border-border-strong">
                        <CircleSlash aria-hidden />
                        Disabled
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {row.roles.length === 0 ? (
                      <span className="text-[13px] text-muted-foreground">Venture access only</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1" aria-label="Roles">
                        {row.roles.map((r) => (
                          <li key={r}>
                            <Badge variant="secondary">{ROLE_LABELS[r]}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="min-w-44 align-top text-[13px]">
                    {row.memberships.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <ul className="grid gap-0.5">
                        {row.memberships.slice(0, 3).map((m) => (
                          <li key={m.ventureId}>
                            {m.ventureName}{' '}
                            <span className="text-muted-foreground">· {ROLE_LABELS[m.role]}</span>
                          </li>
                        ))}
                        {row.memberships.length > 3 ? (
                          <li className="text-muted-foreground">+{row.memberships.length - 3} more</li>
                        ) : null}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="min-w-72 align-top">
                    {row.activeAccessCodes.length === 0 ? (
                      <span className="text-[13px] text-muted-foreground">No active codes</span>
                    ) : (
                      <ul className="grid gap-2">
                        {row.activeAccessCodes.map((code) => (
                          <li key={code.id} className="flex items-start justify-between gap-2">
                            <div className="min-w-0 text-[13px]">
                              <p>
                                <code className="font-mono text-xs whitespace-nowrap">
                                  {maskedCode(code.prefix)}
                                </code>
                              </p>
                              <p className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">{code.label}</span> ·{' '}
                                {code.expiresAt ? `Expires ${formatDate(code.expiresAt)}` : 'No expiry'} ·{' '}
                                {code.lastUsedAt ? `used ${formatRelative(code.lastUsedAt)}` : 'never used'}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Revoke ${row.principal.displayName}’s code ${code.label}`}
                              onClick={() => {
                                setRevoking({ code, owner: row.principal.displayName });
                              }}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Issue access code to ${row.principal.displayName}`}
                      disabled={row.status !== 'active'}
                      onClick={() => {
                        setIssueFor({ id: row.principal.id, displayName: row.principal.displayName });
                      }}
                    >
                      <KeyRound aria-hidden />
                      Issue code
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreatePrincipalDialog open={createOpen} onOpenChange={setCreateOpen} onIssueCode={setIssueFor} />
      <IssueAccessCodeDialog
        recipient={issueFor}
        onClose={() => {
          setIssueFor(null);
        }}
      />

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this access code?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking ? (
                <>
                  <code className="font-mono">{maskedCode(revoking.code.prefix)}</code> (“
                  {revoking.code.label}”) for {revoking.owner} stops working for new sign-ins immediately.
                  This can’t be undone — issue a new code if they still need access.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction destructive onClick={confirmRevoke}>
              Revoke code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
