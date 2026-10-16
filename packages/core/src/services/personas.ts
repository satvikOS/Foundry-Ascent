import {
  AssignPersonaRequest,
  CoachMode,
  type ConsentView,
  CreateConsentRequest,
  CreateEirPersonaRequest,
  type PersonaEmbodiment,
  type PersonaView,
  type ProgramVentureRow,
  type RevokeConsentResponse,
  UpdateEmbodimentRequest,
} from '@foundry/contracts';
import { assignmentsRepo, eirRepo, personasRepo, principalsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { personaNameClaimsEir } from '../internal/eir-names.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { embodimentView } from './veir.js';
import { isSpeechVoice } from './voices.js';

type ProgramVentureRowValue = z.infer<typeof ProgramVentureRow>;

/**
 * Persona lifecycle for the program and the EIR studio: create an EIR persona (a draft with release v1 to
 * review), record and revoke its consent (revoking suspends every persona relying on it), choose how it is
 * embodied in calls, and assign a vEIR to a venture (one active assignment per venture). An EIR persona can
 * only run with a consent covering its doctrine (database CHECK + release approval), and only speak with a
 * voice its consent covers.
 */
export interface PersonaManagementService {
  /** Creates a draft EIR persona and its draft release v1 (program lead). */
  createEirPersona(ctx: RequestContext, input: z.input<typeof CreateEirPersonaRequest>): Promise<PersonaView>;
  /** Consent records of the persona's EIR (program lead or that EIR). */
  listConsents(ctx: RequestContext, personaId: string): Promise<ConsentView[]>;
  /**
   * Records the consent of the persona's EIR and links it to the persona. The EIR records their own; a
   * program lead may record it only for a synthetic (fictional) EIR, whether or not it can sign in.
   */
  recordConsent(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof CreateConsentRequest>,
  ): Promise<ConsentView>;
  /** Revokes a consent (its subject, or a program lead for a synthetic EIR); dependent personas are suspended. */
  revokeConsent(ctx: RequestContext, consentId: string): Promise<RevokeConsentResponse>;
  /** The persona's embodiment (any EIR-studio role). */
  getEmbodiment(ctx: RequestContext, personaId: string): Promise<PersonaEmbodiment>;
  /** Chooses the call provider and voice (program lead or the persona's EIR); voices need voice consent. */
  updateEmbodiment(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof UpdateEmbodimentRequest>,
  ): Promise<PersonaEmbodiment>;
  /** Assigns an active persona to a venture, ending the previous assignment (program lead). */
  assignVenture(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof AssignPersonaRequest>,
  ): Promise<ProgramVentureRowValue>;
}

const STUDIO_ROLES = ['eir', 'program_lead', 'platform_admin'] as const;

export function createPersonaManagementService(
  kit: Kit,
  directory: DirectoryCache,
): PersonaManagementService {
  async function loadPersona(scope: RequestScope, personaId: string): Promise<personasRepo.PersonaRecord> {
    const persona = await personasRepo.getPersona(scope.tx, personaId);
    if (persona?.tenantId !== scope.ctx.tenantId) throw fail.notFound('Persona');
    return persona;
  }

  /** Program lead of the tenant, or the EIR whose profile the persona is built from. */
  async function requireCurator(
    scope: RequestScope,
    persona: personasRepo.PersonaRecord,
  ): Promise<'program_lead' | 'linked_eir'> {
    const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
    if (hasAnyRole(roles, ['program_lead'])) return 'program_lead';
    if (persona.eirProfileId !== null && hasAnyRole(roles, ['eir'])) {
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

  async function personaView(scope: RequestScope, personaId: string): Promise<PersonaView> {
    const view = await personasRepo.getPersonaView(scope.tx, personaId);
    if (view === null) throw fail.notFound('Persona');
    return view;
  }

  async function embodiment(
    scope: RequestScope,
    persona: personasRepo.PersonaRecord,
  ): Promise<PersonaEmbodiment> {
    return embodimentView(persona, await personasRepo.personaConsentAssets(scope.tx, persona.id));
  }

  return {
    createEirPersona: async (ctx, rawInput) => {
      const input = parseInput(CreateEirPersonaRequest, rawInput);
      const eirProfileId = requireId(input.eirProfileId, 'EIR profile');
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'persona' });
        const profile = await eirRepo.getEirProfile(scope.tx, eirProfileId);
        if (profile?.tenantId !== ctx.tenantId) throw fail.notFound('EIR profile');
        if (profile.status === 'retired') throw fail.conflict('This EIR profile is retired', 'eir_retired');
        if (
          (await personasRepo.findPersonasByName(scope.tx, { tenantId: ctx.tenantId, name: input.name }))
            .length
        ) {
          throw fail.conflict('Another persona already uses this name', 'persona_name_taken');
        }
        const existing = (await personasRepo.listPersonasForEirProfile(scope.tx, eirProfileId)).find(
          (p) => p.kind === 'eir_persona' && p.status !== 'retired',
        );
        if (existing) {
          throw fail.conflict(
            `${profile.displayName} already has a persona (${existing.name})`,
            'persona_exists',
          );
        }
        // A vEIR is never presented as its EIR ("Corin Halvorsen", "Coach Corin"); its name says whose vEIR it
        // is ("Corin's vEIR"). Every call intro and first message would otherwise open with the claim.
        if (
          personaNameClaimsEir(input.name, [
            profile.displayName,
            ...(await directory.get(ctx.tenantId)).eirNames,
          ])
        ) {
          throw fail.validation('A vEIR\'s name says whose vEIR it is, such as "Corin\'s vEIR".', [
            { path: 'name', message: 'Must not present the vEIR as an EIR' },
          ]);
        }
        const persona = await personasRepo.createPersona(scope.tx, {
          tenantId: ctx.tenantId,
          name: input.name,
          kind: 'eir_persona',
          eirProfileId,
          status: 'draft',
        });
        const release = await personasRepo.createRelease(scope.tx, {
          personaId: persona.id,
          doctrine: input.doctrine,
          style: input.style,
          disclosureText: input.disclosureText,
          allowedModes: input.allowedModes ?? CoachMode.options,
          createdBy: ctx.principalId,
        });
        await audit(scope, {
          action: 'persona.created',
          outcome: 'succeeded',
          objectType: 'persona',
          objectId: persona.id,
          metadata: { kind: 'eir_persona', eirProfileId, releaseId: release.id },
        });
        return personaView(scope, persona.id);
      });
    },

    listConsents: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        await requireCurator(scope, persona);
        if (persona.eirProfileId === null) return [];
        const profile = await eirRepo.getEirProfile(scope.tx, persona.eirProfileId);
        if (profile?.principalId == null) return [];
        return (await personasRepo.listConsents(scope.tx, profile.principalId)).map(
          personasRepo.toConsentView,
        );
      });
    },

    recordConsent: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(CreateConsentRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        const via = await requireCurator(scope, persona);
        if (persona.kind !== 'eir_persona' || persona.eirProfileId === null) {
          throw fail.conflict('Only EIR personas carry a consent record', 'not_eir_persona');
        }
        if (persona.status === 'retired') throw fail.conflict('The persona is retired', 'persona_retired');
        const profile = await eirRepo.getEirProfile(scope.tx, persona.eirProfileId);
        const subject = profile?.principalId ?? null;
        if (profile === null || subject === null) {
          throw fail.conflict('This EIR has no account to record consent for', 'eir_without_account');
        }
        if (subject !== ctx.principalId) {
          const principal = await principalsRepo.getPrincipal(scope.tx, subject);
          if (!(profile.synthetic && principal?.synthetic === true)) {
            throw fail.forbidden(
              'consent_by_subject_only',
              `Only ${profile.displayName} can record their own consent`,
            );
          }
        }
        const consent = await personasRepo.createConsent(scope.tx, {
          tenantId: ctx.tenantId,
          subjectPrincipalId: subject,
          assetTypes: input.assetTypes,
          approvedUses: input.approvedUses,
          audiences: input.audiences,
          evidenceRef: input.evidenceRef,
          expiresAt: input.expiresAt,
        });
        // The new consent replaces the persona's link; a voice the new consent no longer covers is dropped.
        const covers = (asset: 'voice' | 'likeness'): boolean => input.assetTypes.includes(asset);
        if (
          (persona.embodiment.voiceId !== null && !covers('voice')) ||
          (persona.embodiment.portraitKey !== null && !covers('likeness'))
        ) {
          await personasRepo.setPersonaEmbodiment(scope.tx, {
            personaId,
            embodiment: {
              ...persona.embodiment,
              voiceId: covers('voice') ? persona.embodiment.voiceId : null,
              portraitKey: covers('likeness') ? persona.embodiment.portraitKey : null,
            },
          });
        }
        await personasRepo.setPersonaConsent(scope.tx, { personaId, consentId: consent.id });
        await audit(scope, {
          action: 'consent.recorded',
          outcome: 'succeeded',
          objectType: 'consent',
          objectId: consent.id,
          metadata: { personaId, assetTypes: input.assetTypes, via },
        });
        return personasRepo.toConsentView(consent);
      });
    },

    revokeConsent: async (ctx, rawConsentId) => {
      const consentId = requireId(rawConsentId, 'Consent');
      return await kit.inRequest(ctx, async (scope) => {
        // RLS shows a consent to its subject and to program leads only.
        const consent = await personasRepo.getConsent(scope.tx, consentId);
        if (consent?.tenantId !== ctx.tenantId) throw fail.notFound('Consent');
        if (consent.subjectPrincipalId !== ctx.principalId) {
          await requireRole(scope, ['program_lead'], { objectType: 'consent', objectId: consentId });
        }
        if (consent.revokedAt !== null)
          throw fail.conflict('This consent is already revoked', 'already_revoked');
        const suspended = await personasRepo.revokeConsent(scope.tx, consentId);
        if (suspended === null) {
          throw fail.forbidden(
            'consent_by_subject_only',
            'Only the person who gave this consent can revoke it',
          );
        }
        await audit(scope, {
          action: 'consent.revoked',
          outcome: 'succeeded',
          objectType: 'consent',
          objectId: consentId,
          metadata: { suspendedPersonas: suspended.length },
        });
        for (const personaId of suspended) {
          await audit(scope, {
            action: 'persona.suspended',
            outcome: 'succeeded',
            objectType: 'persona',
            objectId: personaId,
            policyReason: 'consent_revoked',
            metadata: { consentId },
          });
        }
        const updated = await personasRepo.getConsent(scope.tx, consentId);
        if (updated === null) throw fail.notFound('Consent');
        return { consent: personasRepo.toConsentView(updated), suspendedPersonaIds: suspended };
      });
    },

    getEmbodiment: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, STUDIO_ROLES, { objectType: 'persona', objectId: personaId });
        return embodiment(scope, await loadPersona(scope, personaId));
      });
    },

    updateEmbodiment: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(UpdateEmbodimentRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        const via = await requireCurator(scope, persona);
        if (input.provider !== undefined && input.provider !== 'builtin') {
          throw fail.validation('This avatar provider is not connected yet', [
            { path: 'provider', message: 'Only the built-in provider is available' },
          ]);
        }
        if (input.voiceId != null && !isSpeechVoice(input.voiceId)) {
          throw fail.validation('Choose one of the available voices', [
            { path: 'voiceId', message: 'Unknown voice' },
          ]);
        }
        if (input.voiceId != null && persona.kind === 'eir_persona') {
          const assets = await personasRepo.personaConsentAssets(scope.tx, personaId);
          if (!assets.includes('voice')) {
            throw new DomainError('conflict', 'Record a consent covering voice before choosing a voice', {
              reason: 'voice_consent_required',
            });
          }
        }
        const updated = await personasRepo.setPersonaEmbodiment(scope.tx, {
          personaId,
          embodiment: {
            ...persona.embodiment,
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(input.voiceId === undefined ? {} : { voiceId: input.voiceId }),
          },
        });
        if (updated === null) throw fail.notFound('Persona');
        await audit(scope, {
          action: 'persona.embodiment_updated',
          outcome: 'succeeded',
          objectType: 'persona',
          objectId: personaId,
          metadata: { provider: updated.embodiment.provider, voiceId: updated.embodiment.voiceId, via },
        });
        return embodiment(scope, updated);
      });
    },

    assignVenture: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(AssignPersonaRequest, rawInput);
      const personaId = requireId(input.personaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, ['program_lead'], { objectType: 'assignment', ventureId });
        const venture = await venturesRepo.getVenture(scope.tx, ventureId);
        if (venture?.tenantId !== ctx.tenantId) throw fail.notFound('Venture');
        const persona = await loadPersona(scope, personaId);
        if (persona.status !== 'active') {
          throw fail.conflict('Only an active persona can be assigned', 'persona_not_active');
        }
        const release = await personasRepo.getActiveRelease(scope.tx, personaId);
        if (release === null) {
          throw fail.conflict('The persona has no approved release yet', 'no_approved_release');
        }
        let eirProfileId: string | null;
        if (persona.kind === 'eir_persona') {
          // A vEIR is reviewed by the EIR it is built from.
          if (input.eirProfileId !== null && input.eirProfileId !== persona.eirProfileId) {
            throw fail.validation('A vEIR is assigned with the EIR it is built from', [
              { path: 'eirProfileId', message: 'Must be the persona’s own EIR (or null)' },
            ]);
          }
          eirProfileId = persona.eirProfileId;
        } else if (input.eirProfileId === null) {
          eirProfileId = null;
        } else {
          const profile = await eirRepo.getEirProfile(scope.tx, requireId(input.eirProfileId, 'EIR profile'));
          if (profile?.tenantId !== ctx.tenantId) throw fail.notFound('EIR profile');
          eirProfileId = profile.id;
        }
        const modes = input.allowedModes ?? release.allowedModes;
        const current = (await assignmentsRepo.listAssignments(scope.tx, ventureId)).find(
          (a) => a.status === 'active',
        );
        const unchanged =
          current?.personaId === personaId &&
          current.eirProfileId === eirProfileId &&
          [...current.allowedModes].sort().join() === [...modes].sort().join();
        if (!unchanged) {
          const assignment = await assignmentsRepo.createAssignment(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId,
            personaId,
            eirProfileId,
            allowedModes: modes,
            createdBy: ctx.principalId,
          });
          await audit(scope, {
            action: 'assignment.created',
            outcome: 'succeeded',
            ventureId,
            objectType: 'assignment',
            objectId: assignment.id,
            metadata: { personaId, eirProfileId, previousAssignmentId: current?.id ?? null },
          });
          directory.invalidate(ctx.tenantId);
        }
        const row = (await venturesRepo.listProgramVentures(scope.tx, ctx.tenantId)).find(
          (v) => v.id === ventureId,
        );
        if (!row) throw fail.notFound('Venture');
        return row;
      });
    },
  };
}
