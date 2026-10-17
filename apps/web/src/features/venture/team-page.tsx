import { MembershipRole } from '@foundry/contracts';
import { getRouteApi } from '@tanstack/react-router';
import { UserPlus, Users } from 'lucide-react';
import { useState } from 'react';

import { UserAvatar } from '@/components/faces/user-avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { useTeam } from '@/lib/api/hooks/team';
import { canManageAnyTeam, ROLE_LABELS } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate, isoString } from '@/lib/format';
import { MEMBERSHIP_ROLE_ACCESS } from '@/lib/labels';
import { InviteMemberDialog } from '@/features/program/invite-member-dialog';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/team');

/**
 * Team: the people on the venture and what each can see. Program leads and platform admins invite
 * (one invitation flow for the whole product, with the one-time access code revealed once). They open any
 * venture's Team without reading the venture, so its name comes with the team.
 */
export function TeamPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  const team = useTeam(ventureId);
  const canInvite = canManageAnyTeam(me);
  const [inviting, setInviting] = useState(false);

  const members = [...(team.data?.items ?? [])].sort(
    (a, b) =>
      MembershipRole.options.indexOf(a.role) - MembershipRole.options.indexOf(b.role) ||
      a.principal.displayName.localeCompare(b.principal.displayName),
  );
  const name =
    team.data?.venture?.name ?? me.memberships.find((m) => m.ventureId === ventureId)?.ventureName ?? null;

  return (
    <PageContainer className="max-w-4xl">
      <PageHeader
        title="Team"
        info={`People on ${name ?? 'this venture'} and what each can see.`}
        actions={
          canInvite ? (
            <Button
              disabled={name === null}
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
        <ErrorState error={team.error} onRetry={() => void team.refetch()} headingLevel={2} />
      ) : team.isPending ? (
        <HairlineSkeleton rows={3} label="Loading the team…" />
      ) : members.length === 0 ? (
        <EmptyState
          icon={Users}
          headingLevel={2}
          title="No members yet"
          description={
            canInvite ? 'Invite the founders first.' : 'A program lead adds members to the venture.'
          }
        />
      ) : (
        <ul aria-label="Team members" className="divide-y divide-border border-y border-border">
          {members.map((member) => {
            const isMe = member.principal.id === me.principal.id;
            return (
              <li
                key={member.principal.id}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2 py-4 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)]"
              >
                <UserAvatar name={member.principal.displayName} decorative />
                <div className="grid min-w-0 content-start gap-0.5">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-body font-medium">
                    {member.principal.displayName}
                    {isMe ? (
                      <span className="text-caption font-normal text-muted-foreground">You</span>
                    ) : null}
                  </p>
                  {member.principal.title ? (
                    <p className="text-small text-muted-foreground">{member.principal.title}</p>
                  ) : null}
                  <p className="text-caption text-subtle-foreground">
                    Joined <time dateTime={isoString(member.grantedAt)}>{formatDate(member.grantedAt)}</time>
                    {member.expiresAt ? (
                      <>
                        {' · Access until '}
                        <time dateTime={isoString(member.expiresAt)}>{formatDate(member.expiresAt)}</time>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="col-start-2 grid content-start gap-0.5 sm:col-start-3">
                  <p className="text-sm font-medium">{ROLE_LABELS[member.role]}</p>
                  <p className="text-caption text-muted-foreground">{MEMBERSHIP_ROLE_ACCESS[member.role]}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canInvite ? (
        <InviteMemberDialog
          venture={inviting && name !== null ? { id: ventureId, name } : null}
          onClose={() => {
            setInviting(false);
          }}
        />
      ) : null}
    </PageContainer>
  );
}
