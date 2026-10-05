import { eirRepo, venturesRepo, ventureCanary } from '@foundry/db';

import { type Kit } from './kit.js';

/** Tenant-wide names used by the cross-venture and identity guards (never shown to callers). */
export interface TenantDirectory {
  readonly ventures: readonly {
    readonly id: string;
    readonly name: string;
    readonly canary: string;
    /** Display names of the venture's active members (founders, team, advisors). */
    readonly memberNames: readonly string[];
  }[];
  /** Display names of EIR profiles the coach must never speak as. */
  readonly eirNames: readonly string[];
}

export interface OtherVentures {
  readonly names: string[];
  readonly canaries: string[];
  /**
   * Display names of the other ventures' members, minus anyone who is also a member of this venture (a
   * shared advisor may be named here). Feeds `classifyRisk` and `validateCoachResponse`.
   */
  readonly memberNames: string[];
}

const DIRECTORY_TTL_MS = 60_000;

/** Slug used for synthetic canaries (`ventureCanary(slug)`; seed slugs are the lower-cased names). */
export function ventureSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Per-container cache of each tenant's venture names, canaries, member names and EIR names. Read with
 * the owner role (a founder cannot see other ventures under RLS, but the guards must know what to block),
 * always for the caller's own tenant only. The data never leaves core: it only feeds the classifier and
 * validators.
 */
export class DirectoryCache {
  readonly #entries = new Map<string, { value: TenantDirectory; loadedAt: number }>();

  constructor(private readonly kit: Kit) {}

  async get(tenantId: string): Promise<TenantDirectory> {
    const now = this.kit.now().getTime();
    const cached = this.#entries.get(tenantId);
    if (cached && now - cached.loadedAt < DIRECTORY_TTL_MS) return cached.value;
    const value = await this.kit.system(
      async (sx) => {
        const ventures = await venturesRepo.listProgramVentures(sx, tenantId);
        const members = await venturesRepo.listVentureMemberNames(sx, tenantId);
        const eirs = await eirRepo.listEirProfiles(sx, { tenantId });
        return {
          ventures: ventures.map((v) => ({
            id: v.id,
            name: v.name,
            canary: ventureCanary(ventureSlug(v.name)),
            memberNames: members.filter((m) => m.ventureId === v.id).map((m) => m.displayName),
          })),
          eirNames: [...new Set(eirs.map((e) => e.displayName))],
        };
      },
      { transaction: false },
    );
    this.#entries.set(tenantId, { value, loadedAt: now });
    return value;
  }

  invalidate(tenantId: string): void {
    this.#entries.delete(tenantId);
  }

  /** Names and canaries of every venture of the tenant except `ventureId`. */
  async others(tenantId: string, ventureId: string): Promise<OtherVentures> {
    const dir = await this.get(tenantId);
    const own = dir.ventures.find((v) => v.id === ventureId);
    const others = dir.ventures.filter((v) => v.id !== ventureId);
    const ownMembers = new Set((own?.memberNames ?? []).map((n) => n.toLowerCase()));
    return {
      // A name shared with the own venture (e.g. a duplicate) cannot be guarded without blocking the venture itself.
      names: others.map((v) => v.name).filter((n) => n.toLowerCase() !== own?.name.toLowerCase()),
      canaries: others.map((v) => v.canary).filter((c) => c !== own?.canary),
      memberNames: [
        ...new Set(others.flatMap((v) => v.memberNames).filter((n) => !ownMembers.has(n.toLowerCase()))),
      ],
    };
  }
}
