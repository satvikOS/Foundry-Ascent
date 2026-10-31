import {
  type AvatarSessionRequest,
  type AvatarSessionResponse,
  type CallConfigResponse,
  type PersonaEmbodiment,
  type VeirIdentity,
} from '@foundry/contracts';
import { assignmentsRepo, personasRepo, principalsRepo, settingsRepo, type SqlExecutor } from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { veirEirName } from '../internal/eir-names.js';
import { requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { warmTurnEngine } from '../orchestrator/warm-up.js';
import { callSecondsToday, remainingDailyMinutes } from './call-usage.js';
import {
  type FaceService,
  MIN_FACE_SECONDS,
  faceForAdminsOnly,
  faceOfferedTo,
  faceSecondsThisMonth,
  loadFaceCaller,
  twinFaceFor,
} from './face.js';

/**
 * Who a founder talks to (the venture's vEIR as shown in chat and calls) and what a call may use: the
 * provider, the voice, the per-call and daily minute caps. Calls run in the browser (speech recognition) and
 * through the normal turn endpoint; only the spoken reply comes from the server (`SpeechService`).
 */
export interface VeirService {
  /** The vEIR coaching the venture (any member or the assigned EIR). */
  identity(ctx: RequestContext, ventureId: string): Promise<VeirIdentity>;
  /** Everything the call screen needs before the first word (founder/team). */
  callConfig(ctx: RequestContext, ventureId: string): Promise<CallConfigResponse>;
  /**
   * The face of a call (founder/team). A vendor face (or the development stand-in) gets a single-use session
   * token bound to the caller's live call `callId` and its time left; the built-in presence needs none, and a
   * face that is unavailable (no likeness consent, no live call named, the vendor down) leaves the call on the
   * presence. Refused when AI or calls are off, the coach is unavailable or no minutes are left.
   */
  avatarSession(
    ctx: RequestContext,
    input: z.input<typeof AvatarSessionRequest>,
  ): Promise<AvatarSessionResponse>;
}

/** The persona's embodiment as clients see it: a voice or portrait only where consent covers it. */
export function embodimentView(
  persona: Pick<personasRepo.PersonaRecord, 'kind' | 'embodiment'>,
  assets: readonly string[],
): PersonaEmbodiment {
  // The neutral guide is no person: its voice is a stock voice, no consent applies.
  const voiceConsented = persona.kind === 'neutral_guide' || assets.includes('voice');
  const likenessConsented = persona.kind === 'eir_persona' && assets.includes('likeness');
  return {
    provider: persona.embodiment.provider,
    voiceId: voiceConsented ? persona.embodiment.voiceId : null,
    // Portraits are stored as object keys; serving them comes with the avatar vendors (provider seam).
    portraitUrl: null,
    voiceConsented,
    likenessConsented,
  };
}

/**
 * "Corin" for Corin's vEIR (the EIR's first name), the persona name for the neutral guide. It is the EIR's
 * name, so it is never a label for the AI: clients name the AI by `name` ("Corin's vEIR").
 */
export function shortName(persona: { kind: string; name: string }, eirDisplayName: string | null): string {
  if (persona.kind === 'eir_persona' && eirDisplayName) {
    const first = eirDisplayName.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return persona.name;
}

export interface ResolvedVeir {
  readonly identity: VeirIdentity;
  readonly assignment: assignmentsRepo.ResolvedAssignment;
}

/** The venture's vEIR (null when the venture has no active assignment). */
export async function resolveVeir(ex: SqlExecutor, ventureId: string): Promise<ResolvedVeir | null> {
  const resolved = await assignmentsRepo.resolveActiveAssignment(ex, ventureId);
  if (resolved === null) return null;
  const persona = await personasRepo.getPersona(ex, resolved.persona.id);
  if (persona === null) return null;
  const assets = await personasRepo.personaConsentAssets(ex, persona.id);
  const eirDisplayName = await veirEirName(ex, persona);
  const veir = persona.kind === 'eir_persona';
  return {
    assignment: resolved,
    identity: {
      personaId: persona.id,
      name: persona.name,
      shortName: shortName(persona, eirDisplayName),
      kind: persona.kind,
      eirDisplayName,
      tagline: persona.tagline,
      disclosure: resolved.release?.disclosureText ?? '',
      embodiment: embodimentView(persona, assets),
      // Presence: under the EIR's first name only with that consent; the EIR sees the work when assigned here.
      firstPerson: veir && assets.includes('first_person'),
      eirSeesWork:
        veir && persona.eirProfileId !== null && persona.eirProfileId === (resolved.eir?.id ?? null),
    },
  };
}

export function createVeirService(kit: Kit, face: FaceService): VeirService {
  async function requireVeir(scope: RequestScope, ventureId: string): Promise<ResolvedVeir> {
    const veir = await resolveVeir(scope.tx, ventureId);
    if (veir === null) {
      throw new DomainError('assignment_inactive', 'This venture has no active coaching assignment', {
        reason: 'no_active_assignment',
      });
    }
    return veir;
  }

  return {
    identity: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'read', { objectType: 'veir' });
        return (await requireVeir(scope, ventureId)).identity;
      });
    },

    callConfig: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const provider = kit.deps.embodiment;
      const config = await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'call' });
        const { identity } = await requireVeir(scope, ventureId);
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        const used = await callSecondsToday(scope.tx, ctx.principalId);
        // A vendor face for this vEIR: faces on, a provider wired (a sandbox or admins-only one for platform admins
        // and people with video-face access only), and (for a real likeness) its face ready under likeness consent. The video minutes left are read
        // below (owner role).
        const faceOn =
          provider !== undefined &&
          settings.facesEnabled &&
          (!faceForAdminsOnly(provider) || faceOfferedTo(provider, await loadFaceCaller(scope.tx, ctx))) &&
          (!provider.likeness || (await twinFaceFor(scope.tx, provider, identity.personaId)) !== null);
        const response: CallConfigResponse = {
          veir: identity,
          provider: identity.embodiment.provider,
          maxMinutes: settings.maxCallMinutes,
          remainingMinutesToday: remainingDailyMinutes(used, settings.dailyCallMinutesPerPrincipal),
          aiEnabled: settings.aiEnabled,
          callsEnabled: settings.callsEnabled,
          // The caller's own acknowledgement of the first-call privacy notice (per person, not per browser).
          callNoticeAcknowledgedAt: await principalsRepo.callNoticeAcknowledgedAt(scope.tx),
        };
        return { response, faceOn, monthMinutes: settings.faceMinutesPerPrincipalMonth };
      });
      // The call screen opened (the page reads this before a call starts): the turn engine's first-run CPU is spent now,
      // after the response, rather than in the call's first reply (warm-up.ts). Once per process; never fails this.
      if (config.response.aiEnabled && config.response.callsEnabled) {
        const warming = Promise.resolve()
          .then(() => warmTurnEngine())
          .catch(() => undefined);
        if (kit.deps.afterResponse === undefined) void warming;
        else kit.deps.afterResponse(warming);
      }
      if (!config.faceOn || provider === undefined) return config.response;
      const left = Math.max(0, config.monthMinutes * 60 - (await faceSecondsThisMonth(kit, ctx.principalId)));
      if (left < MIN_FACE_SECONDS) return config.response;
      return {
        ...config.response,
        provider: provider.id,
        faceMinutesLeft: Math.floor(left / 6) / 10,
      };
    },

    avatarSession: (ctx, input) => face.session(ctx, input),
  };
}
