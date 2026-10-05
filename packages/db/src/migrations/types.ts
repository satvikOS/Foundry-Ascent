/** One SQL migration file shipped inside the bundle (see `pnpm --filter @foundry/db gen:migrations`). */
export interface Migration {
  /** File stem, e.g. `0001_init`; applied in lexical order. */
  readonly version: string;
  /** sha256 (hex) of `sql`. */
  readonly checksum: string;
  readonly sql: string;
}
