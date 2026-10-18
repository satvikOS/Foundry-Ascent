import {
  AvatarSessionRequest,
  type AvatarSessionResponse,
  type CallConfigResponse,
  type PersonaEmbodiment,
  type VeirIdentity,
} from '@foundry/contracts';
import { assignmentsRepo, personasRepo, principalsRepo, settingsRepo, type SqlExecutor } from '@foundry/db';
import { type z } from 'zod';

import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, parseInput } from '../errors.js';
import { veirEirName } from '../internal/eir-names.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { CALL_LIMITS, callSecondsToday, remainingDailyMinutes, remainingDailySeconds } from './call-usage.js';
import { callVoiceFor } from './calls.js';

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
   * Starts a call's avatar session (founder/team). Vendor providers would mint a single-use token here; the
   * built-in provider needs none. Refused when AI is off, the coach is unavailable or no minutes are left.
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

export function createVeirService(kit: Kit): VeirService {
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
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'call' });
        const { identity } = await requireVeir(scope, ventureId);
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        const used = await callSecondsToday(scope.tx, ctx.principalId);
        return {
          veir: identity,
          provider: identity.embodiment.provider,
          maxMinutes: settings.maxCallMinutes,
          remainingMinutesToday: remainingDailyMinutes(used, settings.dailyCallMinutesPerPrincipal),
          aiEnabled: settings.aiEnabled,
          callsEnabled: settings.callsEnabled,
          // The caller's own acknowledgement of the first-call privacy notice (per person, not per browser).
          callNoticeAcknowledgedAt: await principalsRepo.callNoticeAcknowledgedAt(scope.tx),
        };
      });
    },

    avatarSession: async (ctx, rawInput) => {
      const input = parseInput(AvatarSessionRequest, rawInput);
      const ventureId = requireId(input.ventureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'call' });
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        if (!settings.aiEnabled) {
          throw new DomainError(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            {
              reason: 'kill_switch',
            },
          );
        }
        if (!settings.callsEnabled) {
          throw new DomainError('ai_disabled', 'Calls are paused by the program. You can keep chatting.', {
            reason: 'calls_disabled',
          });
        }
        const active = await requireAssignmentActive(scope, ventureId);
        const { identity } = await requireVeir(scope, ventureId);
        const persona = await personasRepo.getPersona(scope.tx, active.persona.id);
        // The same voice rule as calls: an EIR's own voice only under voice consent, never another voice.
        const voiceId =
          persona === null
            ? null
            : callVoiceFor(persona, await personasRepo.personaConsentAssets(scope.tx, persona.id));
        if (voiceId === null) {
          throw new DomainError(
            'persona_suspended',
            'This vEIR’s voice consent is not in force, so calls are paused.',
            { reason: 'voice_consent' },
          );
        }
        const used = await callSecondsToday(scope.tx, ctx.principalId);
        if (
          remainingDailySeconds(used, settings.dailyCallMinutesPerPrincipal) < CALL_LIMITS.minStartSeconds
        ) {
          throw new DomainError(
            'rate_limited',
            'You have used today’s call minutes. Calls reset at midnight UTC.',
            {
              reason: 'daily_call_minutes',
              retryAfterSeconds: secondsUntilUtcMidnight(kit.now()),
            },
          );
        }
        await audit(scope, {
          action: 'call.avatar_session',
          outcome: 'succeeded',
          ventureId,
          objectType: 'persona',
          objectId: identity.personaId,
          metadata: { provider: identity.embodiment.provider },
        });
        return {
          provider: identity.embodiment.provider,
          token: null,
          expiresAt: null,
          voiceId,
        };
      });
    },
  };
}
