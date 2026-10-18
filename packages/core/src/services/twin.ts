import {
  type DigitalTwinView,
  TWIN_MEDIA_VENDOR,
  type TwinMediaKind,
  UpdateTwinMediaRequest,
  WithdrawConsentScopeRequest,
  type WithdrawConsentScopeResponse,
} from '@foundry/contracts';
import { eirRepo, personasRepo, principalsRepo, settingsRepo, twinRepo } from '@foundry/db';
import { type z } from 'zod';

import { requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { requirePersonaCurator } from './personas.js';

/**
 * The vEIR's digital twin in the EIR studio (docs/runbooks/avatars.md): the vendor face (a HeyGen LiveAvatar avatar
 * id) and cloned voice (an ElevenLabs voice id) of an EIR persona, each usable only under its own consent scope
 * (`likeness`, `voice`), and withdrawing one scope of a consent without revoking the rest.
 *
 * - The persona's curators (its program leads and its own EIR) record the vendor ids once the vendor shows them
 *   ready. `ready` needs the scope in force (checked here with a plain answer, and by the database).
 * - Withdrawing a scope is the consent subject's own act (a program lead's for a synthetic EIR): the record is
 *   replaced by a copy without that scope, the personas that relied on it move to the copy (none is suspended),
 *   the face or cloned voice it covered is withdrawn, and the old record is revoked. Calls feel it at once: the
 *   face ends at the next heartbeat and takes no more audio, the clone falls back to the platform voice.
 */
export interface TwinService {
  /** The persona's twin (its curators). */
  get(ctx: RequestContext, personaId: string): Promise<DigitalTwinView>;
  /** Records (or, with a null id, withdraws) the persona's face or voice at its vendor. */
  setMedia(
    ctx: RequestContext,
    personaId: string,
    kind: string,
    input: z.input<typeof UpdateTwinMediaRequest>,
  ): Promise<DigitalTwinView>;
  /** Withdraws one scope (`likeness`, `voice`, `first_person`) of a consent in force. */
  withdrawScope(
    ctx: RequestContext,
    consentId: string,
    input: z.input<typeof WithdrawConsentScopeRequest>,
  ): Promise<WithdrawConsentScopeResponse>;
}

const SCOPE_OF: Readonly<Record<TwinMediaKind, 'likeness' | 'voice'>> = { face: 'likeness', voice: 'voice' };

function mediaKind(raw: string): TwinMediaKind {
  if (raw === 'face' || raw === 'voice') return raw;
  throw fail.notFound('Media');
}

export function createTwinService(kit: Kit): TwinService {
  async function loadPersona(scope: RequestScope, personaId: string): Promise<personasRepo.PersonaRecord> {
    const persona = await personasRepo.getPersona(scope.tx, personaId);
    if (persona?.tenantId !== scope.ctx.tenantId) throw fail.notFound('Persona');
    return persona;
  }

  async function view(scope: RequestScope, persona: personasRepo.PersonaRecord): Promise<DigitalTwinView> {
    const assets = await personasRepo.personaConsentAssets(scope.tx, persona.id);
    const media = await twinRepo.listPersonaMedia(scope.tx, persona.id);
    const settings = await settingsRepo.getPlatformSettings(scope.tx);
    const face = media.find((m) => m.kind === 'face');
    const voice = media.find((m) => m.kind === 'voice');
    return {
      personaId: persona.id,
      consentId: assets.length > 0 ? persona.consentId : null,
      scopes: {
        likeness: assets.includes('likeness'),
        voice: assets.includes('voice'),
        firstPerson: assets.includes('first_person'),
      },
      face: face ? twinRepo.toTwinMediaView(face) : null,
      voice: voice ? twinRepo.toTwinMediaView(voice) : null,
      facesEnabled: settings.facesEnabled,
      clonedVoiceEnabled: settings.clonedVoiceEnabled,
    };
  }

  return {
    get: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        await requirePersonaCurator(scope, persona);
        return view(scope, persona);
      });
    },

    setMedia: async (ctx, rawPersonaId, rawKind, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const kind = mediaKind(rawKind);
      const input = parseInput(UpdateTwinMediaRequest, rawInput);
      return kit.inRequest(ctx, async (scope) => {
        const persona = await loadPersona(scope, personaId);
        const via = await requirePersonaCurator(scope, persona);
        if (persona.kind !== 'eir_persona') {
          throw fail.conflict(
            'Only a vEIR built from an EIR has a face or a cloned voice',
            'not_eir_persona',
          );
        }
        if (persona.status === 'retired') throw fail.conflict('The persona is retired', 'persona_retired');
        const scopeNeeded = SCOPE_OF[kind];
        if (input.vendorRef === null) {
          const withdrawn = await twinRepo.withdrawPersonaMedia(scope.tx, {
            personaId,
            kind,
            updatedBy: ctx.principalId,
          });
          if (withdrawn !== null) {
            await audit(scope, {
              action: 'persona.twin_withdrawn',
              outcome: 'succeeded',
              objectType: 'persona',
              objectId: personaId,
              metadata: { kind, vendor: withdrawn.vendor, via },
            });
          }
          return view(scope, persona);
        }
        if (input.status === 'ready') {
          const assets = await personasRepo.personaConsentAssets(scope.tx, personaId);
          if (!assets.includes(scopeNeeded)) {
            throw new DomainError(
              'conflict',
              kind === 'face'
                ? 'Record a consent that covers likeness before turning on the face.'
                : 'Record a consent that covers voice before turning on the cloned voice.',
              { reason: `${scopeNeeded}_consent_required` },
            );
          }
        }
        const saved = await twinRepo.upsertPersonaMedia(scope.tx, {
          personaId,
          tenantId: ctx.tenantId,
          kind,
          vendor: TWIN_MEDIA_VENDOR[kind],
          vendorRef: input.vendorRef,
          status: input.status,
          updatedBy: ctx.principalId,
        });
        await audit(scope, {
          action: 'persona.twin_updated',
          outcome: 'succeeded',
          objectType: 'persona',
          objectId: personaId,
          // The vendor id is an identifier of the EIR's media; the audit keeps the kind and status only.
          metadata: { kind, vendor: saved.vendor, status: saved.status, via },
        });
        return view(scope, persona);
      });
    },

    withdrawScope: async (ctx, rawConsentId, rawInput) => {
      const consentId = requireId(rawConsentId, 'Consent');
      const input = parseInput(WithdrawConsentScopeRequest, rawInput);
      return kit.inRequest(ctx, async (scope) => {
        // RLS shows a consent to its subject and to program leads only.
        const consent = await personasRepo.getConsent(scope.tx, consentId);
        if (consent?.tenantId !== ctx.tenantId) throw fail.notFound('Consent');
        if (consent.subjectPrincipalId !== ctx.principalId) {
          // Consent stays the subject's own act; a program lead acts only for a synthetic (fictional) EIR.
          await requireRole(scope, ['program_lead'], { objectType: 'consent', objectId: consentId });
          const subject = await principalsRepo.getPrincipal(scope.tx, consent.subjectPrincipalId);
          const profile =
            subject === null ? null : await eirRepo.getEirProfileByPrincipal(scope.tx, subject.id);
          if (!(subject?.synthetic === true && profile?.synthetic === true)) {
            throw fail.forbidden(
              'consent_by_subject_only',
              'Only the person who gave this consent can change it',
            );
          }
        }
        if (!personasRepo.consentCovers(consent, input.assetType, kit.now())) {
          throw fail.conflict(
            'This consent does not cover that, or is no longer in force',
            'scope_not_in_force',
          );
        }
        const copy = await personasRepo.createConsent(scope.tx, {
          tenantId: ctx.tenantId,
          subjectPrincipalId: consent.subjectPrincipalId,
          assetTypes: personasRepo
            .toConsentView(consent)
            .assetTypes.filter((asset) => asset !== input.assetType),
          approvedUses: consent.approvedUses,
          audiences: consent.audiences,
          evidenceRef: consent.evidenceRef,
          expiresAt: consent.expiresAt,
        });
        const dependents = await personasRepo.listConsentDependents(scope.tx, [consentId]);
        for (const dependent of dependents) {
          const persona = await personasRepo.getPersona(scope.tx, dependent.id);
          if (persona === null) continue;
          // A voice or portrait the copy no longer covers goes first (the database refuses them otherwise).
          if (
            (input.assetType === 'voice' && persona.embodiment.voiceId !== null) ||
            (input.assetType === 'likeness' && persona.embodiment.portraitKey !== null)
          ) {
            await personasRepo.setPersonaEmbodiment(scope.tx, {
              personaId: persona.id,
              embodiment: {
                ...persona.embodiment,
                ...(input.assetType === 'voice' ? { voiceId: null } : { portraitKey: null }),
              },
            });
          }
          // Moving to the copy withdraws the face or voice it no longer covers (persona_media_follow_consent).
          await personasRepo.setPersonaConsent(scope.tx, { personaId: persona.id, consentId: copy.id });
        }
        // Nobody relies on the old record any more: revoking it suspends no one.
        const suspended = await personasRepo.revokeConsent(scope.tx, consentId);
        if (suspended === null || suspended.length > 0) {
          throw fail.conflict('This consent could not be changed. Try again.', 'consent_changed');
        }
        await audit(scope, {
          action: 'consent.scope_withdrawn',
          outcome: 'succeeded',
          objectType: 'consent',
          objectId: copy.id,
          policyReason: input.assetType,
          metadata: { previousConsentId: consentId, personas: dependents.length },
        });
        return { consent: personasRepo.toConsentView(copy), previousConsentId: consentId };
      });
    },
  };
}
