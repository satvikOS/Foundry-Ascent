import {
  CreateEirProfileRequest,
  type EirProfileView,
  type PrincipalView,
  UpdateEirProfileRequest,
} from '@foundry/contracts';
import { DbError, eirRepo, principalsRepo, SqlState } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, isDomainError, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';

type EirProfileViewValue = z.infer<typeof EirProfileView>;

/**
 * The EIR registry as program staff keep it: the real people vEIRs may be built from. A profile names the
 * person (display name, title, areas of expertise, a short bio) and is linked to their own account, someone
 * of the tenant holding the EIR role (invited through the usual access-code flow). Creating a profile never
 * records consent: a vEIR built from the person can only be approved once their consent is on file, which they
 * record themselves on the vEIR's Consent tab (a program lead may only do it for a synthetic EIR).
 */
export interface EirProfilesService {
  /** People a new profile can be linked to: the tenant's EIRs without a profile (program lead or admin). */
  listCandidates(ctx: RequestContext): Promise<PrincipalView[]>;
  /** Creates a profile linked to one of {@link listCandidates} (program lead or platform admin). */
  create(ctx: RequestContext, input: z.input<typeof CreateEirProfileRequest>): Promise<EirProfileViewValue>;
  /** Edits the name, title, expertise or bio of a profile of the tenant (program lead or platform admin). */
  update(
    ctx: RequestContext,
    profileId: string,
    input: z.input<typeof UpdateEirProfileRequest>,
  ): Promise<EirProfileViewValue>;
}

const MANAGERS = ['program_lead', 'platform_admin'] as const;

/** Fields an edit can change, in the order the audit lists them. */
const EDITABLE = ['bio', 'displayName', 'expertiseTags', 'title'] as const;

/** One profile per person (`eir_profiles_principal_uq`, migration 0011). */
const PROFILE_PER_PERSON_INDEX = 'eir_profiles_principal_uq';

function alreadyHasProfile(name: string, cause?: unknown): DomainError {
  const message = `${name} already has an EIR profile.`;
  return new DomainError('conflict', message, {
    reason: 'eir_profile_exists',
    errors: [{ path: 'principalId', message }],
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * A second profile for the same person that got past the check (two requests at once) fails on the
 * one-per-person index; it is reported like the check's refusal. The Data API reports no constraint name, so a
 * unique violation without one counts too: creating a profile writes no other unique value.
 */
export function profileConflict(err: unknown, personName: string): unknown {
  const cause = isDomainError(err) ? err.cause : err;
  if (
    cause instanceof DbError &&
    cause.sqlState === SqlState.uniqueViolation &&
    (cause.constraint === null || cause.constraint === PROFILE_PER_PERSON_INDEX)
  ) {
    return alreadyHasProfile(personName, cause);
  }
  return err;
}

function principalProblem(message: string): DomainError {
  return fail.validation(message, [{ path: 'principalId', message }]);
}

export function createEirProfilesService(kit: Kit, directory: DirectoryCache): EirProfilesService {
  async function viewOf(scope: RequestScope, profileId: string): Promise<EirProfileViewValue> {
    const view = await eirRepo.getEirProfileView(scope.tx, profileId);
    if (view === null) throw fail.notFound('EIR profile');
    return view;
  }

  return {
    listCandidates: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, MANAGERS, { objectType: 'eir_profile' });
        return eirRepo.listEirProfileCandidates(scope.tx, ctx.tenantId);
      }),

    create: async (ctx, rawInput) => {
      const input = parseInput(CreateEirProfileRequest, rawInput);
      const principalId = input.principalId.toLowerCase();
      let personName = 'This person';
      try {
        const view = await kit.inRequest(ctx, async (scope) => {
          await requireRole(scope, MANAGERS, { objectType: 'eir_profile' });
          const principal = await principalsRepo.getPrincipal(scope.tx, principalId);
          if (principal?.tenantId !== ctx.tenantId) {
            throw principalProblem('Choose someone from this program.');
          }
          personName = principal.displayName;
          if (principal.status !== 'active') {
            throw principalProblem(`${principal.displayName}’s account is disabled.`);
          }
          const roles = await principalsRepo.listActiveRoles(scope.tx, {
            principalId,
            tenantId: ctx.tenantId,
          });
          if (!hasAnyRole(roles, ['eir'])) {
            throw principalProblem(
              `${principal.displayName} doesn’t have the EIR role. A platform admin gives it under People & access.`,
            );
          }
          if ((await eirRepo.getEirProfileByPrincipal(scope.tx, principalId)) !== null) {
            throw alreadyHasProfile(principal.displayName);
          }
          const created = await eirRepo.createEirProfile(scope.tx, {
            tenantId: ctx.tenantId,
            principalId,
            displayName: input.displayName,
            title: input.title,
            expertiseTags: input.expertiseTags,
            bio: input.bio,
            // A real person's account makes a real EIR, whose consent only they can give.
            synthetic: principal.synthetic,
          });
          await audit(scope, {
            action: 'eir_profile.created',
            outcome: 'succeeded',
            objectType: 'eir_profile',
            objectId: created.id,
            metadata: { principalId, expertiseTags: created.expertiseTags.length, bio: created.bio !== null },
          });
          return viewOf(scope, created.id);
        });
        // The identity guard must know the new name at once (the coach never speaks as an EIR).
        directory.invalidate(ctx.tenantId);
        return view;
      } catch (err) {
        throw profileConflict(err, personName);
      }
    },

    update: async (ctx, rawProfileId, rawInput) => {
      const profileId = requireId(rawProfileId, 'EIR profile');
      const patch = parseInput(UpdateEirProfileRequest, rawInput);
      const view = await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, MANAGERS, { objectType: 'eir_profile', objectId: profileId });
        const profile = await eirRepo.getEirProfile(scope.tx, profileId);
        if (profile?.tenantId !== ctx.tenantId) throw fail.notFound('EIR profile');
        const updated = await eirRepo.updateEirProfile(scope.tx, profileId, {
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.expertiseTags === undefined ? {} : { expertiseTags: patch.expertiseTags }),
          ...(patch.bio === undefined ? {} : { bio: patch.bio }),
        });
        if (updated === null) throw fail.notFound('EIR profile');
        await audit(scope, {
          action: 'eir_profile.updated',
          outcome: 'succeeded',
          objectType: 'eir_profile',
          objectId: profileId,
          metadata: { fields: EDITABLE.filter((field) => patch[field] !== undefined) },
        });
        return viewOf(scope, profileId);
      });
      if (patch.displayName !== undefined) directory.invalidate(ctx.tenantId);
      return view;
    },
  };
}
