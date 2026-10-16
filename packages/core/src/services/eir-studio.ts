import {
  CreatePersonaReleaseRequest,
  type EirProfileView,
  type ReviewSample,
  SubmitReviewRequest,
  SuspendPersonaRequest,
  type PersonaReleaseView,
  type PersonaView,
} from '@foundry/contracts';
import { eirRepo, personasRepo, principalsRepo, turnsRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { blockedDetailOf } from '../orchestrator/blocked.js';

type ReviewSampleValue = z.infer<typeof ReviewSample>;
type EirProfileViewValue = z.infer<typeof EirProfileView>;

export interface EirStudioService {
  /** Personas of the tenant (EIR, program lead or platform admin). */
  listPersonas(ctx: RequestContext): Promise<PersonaView[]>;
  getPersona(ctx: RequestContext, personaId: string): Promise<PersonaView>;
  /**
   * One release with its full content (doctrine, style, disclosure, modes), e.g. a draft under review.
   * Drafts and withdrawn releases: program lead, platform admin or the EIR linked to the persona;
   * approved and superseded releases: any EIR-studio role (the same people who see the active release).
   */
  getRelease(ctx: RequestContext, releaseId: string): Promise<PersonaReleaseView>;
  /** EIR expertise registry (EIR, program lead or platform admin). */
  listEirProfiles(ctx: RequestContext): Promise<EirProfileViewValue[]>;
  /** New draft release (program lead, or the EIR linked to the persona). */
  createRelease(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof CreatePersonaReleaseRequest>,
  ): Promise<PersonaReleaseView>;
  /**
   * Approves a draft release, superseding the previous approved one (program lead or the linked EIR).
   * EIR personas require a valid consent record covering doctrine. A draft persona becomes active. A draft
   * older than the active release is refused (`release_outdated`): approving it would roll doctrine back.
   */
  approveRelease(ctx: RequestContext, releaseId: string): Promise<PersonaReleaseView>;
  /**
   * Withdraws a superseded release (e.g. a doctrine error found after the fact) or a draft (program lead or
   * the linked EIR). Conversations still on a withdrawn release move to the active one at their next message.
   * The active release is refused (`release_active`): approving a corrected release supersedes it.
   */
  withdrawRelease(ctx: RequestContext, releaseId: string): Promise<PersonaReleaseView>;
  /** Kill switch: blocks new sessions and turns immediately (program lead or the linked EIR). */
  suspendPersona(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof SuspendPersonaRequest>,
  ): Promise<PersonaView>;
  /** Resumes a suspended persona (EIR personas need valid consent). */
  resumePersona(ctx: RequestContext, personaId: string): Promise<PersonaView>;
  /** Sampled turns of ventures where the caller is the assigned EIR (role eir). */
  reviewQueue(ctx: RequestContext): Promise<ReviewSampleValue[]>;
  /** Blind rubric scores for a sampled turn of an assigned venture. */
  submitReview(
    ctx: RequestContext,
    turnId: string,
    input: z.input<typeof SubmitReviewRequest>,
  ): Promise<{ reviewId: string; turnId: string }>;
}

const STUDIO_ROLES = ['eir', 'program_lead', 'platform_admin'] as const;

export function createEirStudioService(kit: Kit): EirStudioService {
  async function loadPersona(scope: RequestScope, personaId: string): Promise<personasRepo.PersonaRecord> {
    const persona = await personasRepo.getPersona(scope.tx, personaId);
    if (persona?.tenantId !== scope.ctx.tenantId) throw fail.notFound('Persona');
    return persona;
  }

  /** Program lead of the tenant, or the EIR whose profile the persona is built from. */
  async function requirePersonaControl(
    scope: RequestScope,
    persona: personasRepo.PersonaRecord,
  ): Promise<'program_lead' | 'linked_eir'> {
    const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
    if (hasAnyRole(roles, ['program_lead'])) return 'program_lead';
    if (persona.eirProfileId !== null) {
      const profile = await eirRepo.getEirProfile(scope.tx, persona.eirProfileId);
      if (profile?.principalId === scope.ctx.principalId) return 'linked_eir';
    }
    scope.deferAudit({
      action: 'authz.denied',
      outcome: 'denied',
      objectType: 'persona',
      objectId: persona.id,
      policyReason: 'requires_program_lead_or_linked_eir',
    });
    throw fail.forbidden('requires_program_lead_or_linked_eir');
  }

  /**
   * An EIR persona runs (its release is approved, it is resumed) only on a consent in force that covers
   * doctrine. The refusal names which of those failed at `consent`, so the studio can say it.
   */
  async function requireConsent(scope: RequestScope, persona: personasRepo.PersonaRecord): Promise<void> {
    if (persona.kind !== 'eir_persona') return;
    const consent = persona.consentId ? await personasRepo.getConsent(scope.tx, persona.consentId) : null;
    const now = kit.now().getTime();
    const problem =
      consent === null
        ? 'No consent is on file. Record one that covers doctrine before this vEIR can coach.'
        : consent.revokedAt !== null
          ? 'Consent was revoked. Record a new consent that covers doctrine before this vEIR can coach again.'
          : consent.expiresAt !== null && Date.parse(consent.expiresAt) <= now
            ? 'Consent has expired. Record a new consent that covers doctrine before this vEIR can coach again.'
            : !consent.assetTypes.includes('doctrine')
              ? 'The consent on file doesn’t cover doctrine. Record one that does before this vEIR can coach.'
              : null;
    if (problem !== null) {
      scope.deferAudit({
        action: 'persona.consent_check',
        outcome: 'denied',
        objectType: 'persona',
        objectId: persona.id,
        policyReason: 'consent_required',
      });
      throw new DomainError('forbidden', 'An EIR persona needs a valid consent record before it can run', {
        reason: 'consent_required',
        errors: [{ path: 'consent', message: problem }],
      });
    }
  }

  /**
   * Adds what the caller may do with each persona (`canCurate`, `canManageConsent`), by the rules the
   * library, lessons and consent endpoints enforce, so the studio never offers an action that is refused.
   */
  async function withAccess(scope: RequestScope, views: readonly PersonaView[]): Promise<PersonaView[]> {
    const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
    const lead = hasAnyRole(roles, ['program_lead']);
    const eir = hasAnyRole(roles, ['eir']);
    const subjects = new Map<string, { principalId: string | null; synthetic: boolean }>();
    for (const view of views) {
      const profileId = view.eirProfile?.id;
      if (profileId === undefined || subjects.has(profileId)) continue;
      const profile = await eirRepo.getEirProfile(scope.tx, profileId);
      const principalId = profile?.principalId ?? null;
      // A program lead may act for a synthetic EIR only (consent stays the subject's own act otherwise).
      const principal =
        lead && principalId !== null && profile?.synthetic === true
          ? await principalsRepo.getPrincipal(scope.tx, principalId)
          : null;
      subjects.set(profileId, { principalId, synthetic: principal?.synthetic === true });
    }
    return views.map((view) => {
      const subject = view.eirProfile ? subjects.get(view.eirProfile.id) : undefined;
      const own = subject?.principalId != null && subject.principalId === scope.ctx.principalId;
      const canCurate = lead || (eir && own);
      const canManageConsent =
        canCurate &&
        view.kind === 'eir_persona' &&
        view.status !== 'retired' &&
        subject?.principalId != null &&
        (own || subject.synthetic);
      return { ...view, canCurate, canManageConsent };
    });
  }

  async function personaView(scope: RequestScope, personaId: string): Promise<PersonaView> {
    const view = await personasRepo.getPersonaView(scope.tx, personaId);
    if (view === null) throw fail.notFound('Persona');
    const [withViewer] = await withAccess(scope, [view]);
    return withViewer ?? view;
  }

  return {
    listPersonas: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, STUDIO_ROLES, { objectType: 'persona' });
        return withAccess(scope, await personasRepo.listPersonaViews(scope.tx, ctx.tenantId));
      }),

    getPersona: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, STUDIO_ROLES, { objectType: 'persona', objectId: personaId });
        await loadPersona(scope, personaId);
        return personaView(scope, personaId);
      });
    },

    getRelease: async (ctx, rawReleaseId) => {
      const releaseId = requireId(rawReleaseId, 'Persona release');
      return await kit.inRequest(ctx, async (scope) => {
        const { roles } = await requireRole(scope, STUDIO_ROLES, {
          objectType: 'persona_release',
          objectId: releaseId,
        });
        const release = await personasRepo.getRelease(scope.tx, releaseId);
        if (release === null) throw fail.notFound('Persona release');
        const persona = await loadPersona(scope, release.personaId);
        const unpublished = release.status === 'draft' || release.status === 'withdrawn';
        if (unpublished && !hasAnyRole(roles, ['platform_admin'])) {
          await requirePersonaControl(scope, persona);
        }
        const { expiresAt: _expiresAt, ...view } = release;
        return view;
      });
    },

    listEirProfiles: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, STUDIO_ROLES, { objectType: 'eir_profile' });
        const profiles = await eirRepo.listEirProfiles(scope.tx, { tenantId: ctx.tenantId });
        return profiles.map(eirRepo.toEirProfileView);
      }),

    createRelease: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(CreatePersonaReleaseRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        const via = await requirePersonaControl(scope, persona);
        if (persona.status === 'retired') throw fail.conflict('Retired personas cannot get new releases');
        const release = await personasRepo.createRelease(scope.tx, {
          personaId,
          doctrine: input.doctrine,
          style: input.style,
          disclosureText: input.disclosureText,
          allowedModes: input.allowedModes,
          createdBy: ctx.principalId,
        });
        await audit(scope, {
          action: 'persona.release_created',
          outcome: 'succeeded',
          objectType: 'persona_release',
          objectId: release.id,
          metadata: { personaId, version: release.version, via },
        });
        const { expiresAt: _expiresAt, ...view } = release;
        return view;
      });
    },

    approveRelease: async (ctx, rawReleaseId) => {
      const releaseId = requireId(rawReleaseId, 'Persona release');
      return await kit.inRequest(ctx, async (scope) => {
        const release = await personasRepo.getRelease(scope.tx, releaseId);
        if (release === null) throw fail.notFound('Persona release');
        const persona = await loadPersona(scope, release.personaId);
        const via = await requirePersonaControl(scope, persona);
        if (release.status !== 'draft')
          throw fail.conflict('Only draft releases can be approved', 'invalid_transition');
        // A draft older than the live release would roll every assigned venture back to stale doctrine.
        const active = await personasRepo.getActiveRelease(scope.tx, persona.id);
        if (active !== null && release.version < active.version) {
          throw fail.conflict(
            `v${String(release.version)} is older than the active v${String(active.version)}`,
            'release_outdated',
          );
        }
        await requireConsent(scope, persona);
        const approved = await personasRepo.approveRelease(scope.tx, {
          releaseId,
          approvedBy: ctx.principalId,
        });
        if (approved === null)
          throw fail.conflict('Only draft releases can be approved', 'invalid_transition');
        if (persona.status === 'draft') {
          await personasRepo.setPersonaStatus(scope.tx, { personaId: persona.id, status: 'active' });
        }
        await audit(scope, {
          action: 'persona.release_approved',
          outcome: 'succeeded',
          objectType: 'persona_release',
          objectId: releaseId,
          metadata: {
            personaId: persona.id,
            version: approved.version,
            via,
            activated: persona.status === 'draft',
          },
        });
        const { expiresAt: _expiresAt, ...view } = approved;
        return view;
      });
    },

    withdrawRelease: async (ctx, rawReleaseId) => {
      const releaseId = requireId(rawReleaseId, 'Persona release');
      return await kit.inRequest(ctx, async (scope) => {
        const release = await personasRepo.getRelease(scope.tx, releaseId);
        if (release === null) throw fail.notFound('Persona release');
        const persona = await loadPersona(scope, release.personaId);
        const via = await requirePersonaControl(scope, persona);
        if (release.status === 'approved') {
          throw fail.conflict(
            'The active release can’t be withdrawn. Approve a corrected release, which replaces it.',
            'release_active',
          );
        }
        if (release.status === 'withdrawn') {
          throw fail.conflict('This release is already withdrawn', 'invalid_transition');
        }
        if (!(await personasRepo.withdrawRelease(scope.tx, releaseId))) {
          throw fail.conflict('This release changed meanwhile. Reload it.', 'invalid_transition');
        }
        await audit(scope, {
          action: 'persona.release_withdrawn',
          outcome: 'succeeded',
          objectType: 'persona_release',
          objectId: releaseId,
          metadata: { personaId: persona.id, version: release.version, from: release.status, via },
        });
        const withdrawn = await personasRepo.getRelease(scope.tx, releaseId);
        if (withdrawn === null) throw fail.notFound('Persona release');
        const { expiresAt: _expiresAt, ...view } = withdrawn;
        return view;
      });
    },

    suspendPersona: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(SuspendPersonaRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        const via = await requirePersonaControl(scope, persona);
        if (persona.status === 'retired') throw fail.conflict('The persona is retired');
        if (persona.status !== 'suspended') {
          await personasRepo.setPersonaStatus(scope.tx, {
            personaId,
            status: 'suspended',
            reason: input.reason,
          });
          await audit(scope, {
            action: 'persona.suspended',
            outcome: 'succeeded',
            objectType: 'persona',
            objectId: personaId,
            policyReason: 'manual_suspension',
            metadata: { from: persona.status, via },
          });
        }
        return personaView(scope, personaId);
      });
    },

    resumePersona: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        const via = await requirePersonaControl(scope, persona);
        if (persona.status !== 'suspended')
          throw fail.conflict('Only suspended personas can be resumed', 'invalid_transition');
        await requireConsent(scope, persona);
        await personasRepo.setPersonaStatus(scope.tx, { personaId, status: 'active' });
        await audit(scope, {
          action: 'persona.resumed',
          outcome: 'succeeded',
          objectType: 'persona',
          objectId: personaId,
          metadata: { via },
        });
        return personaView(scope, personaId);
      });
    },

    reviewQueue: (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['eir'], { objectType: 'review_queue' });
        const rows = await turnsRepo.listReviewQueue(scope.tx, { reviewerId: ctx.principalId });
        const evidence = await turnsRepo.listTurnEvidence(
          scope.tx,
          rows.map((r) => r.turn.id),
        );
        return rows.map((r) => ({
          // Blocked turns are never sampled; the reviewer never sees the founder's escalations.
          turn: turnsRepo.toTurnView(r.turn, evidence.get(r.turn.id) ?? [], blockedDetailOf(r.turn, null)),
          ventureId: r.ventureId,
          ventureName: r.ventureName,
          reviewed: r.reviewed,
        }));
      }),

    submitReview: async (ctx, rawTurnId, rawInput) => {
      const turnId = requireId(rawTurnId, 'Turn');
      const input = parseInput(SubmitReviewRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['eir'], { objectType: 'turn', objectId: turnId });
        const turn = await turnsRepo.getTurn(scope.tx, turnId);
        if (turn === null) throw fail.notFound('Turn');
        await requireVentureAccess(scope, turn.ventureId, 'review', { objectType: 'turn', objectId: turnId });
        if (!turn.sampledForReview || turn.status !== 'completed') {
          throw fail.conflict('Only sampled, completed turns can be reviewed', 'not_sampled');
        }
        const { personaFit, ...rest } = input.scores;
        const reviewId = await turnsRepo.upsertEirReview(scope.tx, {
          turnId,
          ventureId: turn.ventureId,
          reviewerId: ctx.principalId,
          scores: { ...rest, persona_fit: personaFit },
          notes: input.notes,
        });
        await audit(scope, {
          action: 'eir.review_submitted',
          outcome: 'succeeded',
          ventureId: turn.ventureId,
          objectType: 'turn',
          objectId: turnId,
          metadata: { reviewId },
        });
        return { reviewId, turnId };
      });
    },
  };
}
