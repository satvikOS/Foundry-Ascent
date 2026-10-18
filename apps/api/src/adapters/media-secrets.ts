import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** A secret's value is read again after this long (a rotated key reaches every container within minutes). */
export const SECRET_CACHE_MS = 5 * 60_000;

/** A vendor API key the server reads when it first needs it; never logged, never sent to a browser. */
export type ApiKeySource = () => Promise<string>;

export class MediaSecretError extends Error {
  override readonly name = 'MediaSecretError';
}

export interface MediaSecretsOptions {
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: Pick<SecretsManagerClient, 'send'>;
  readonly now?: () => number;
}

/**
 * The digital-twin vendors' API keys in AWS Secrets Manager (`foundry-ascent/media/heygen`,
 * `foundry-ascent/media/elevenlabs`; packages/core/media-vendors.json), each the JSON `{"apiKey": "…"}`. A key
 * is read on first use, not at cold start, and cached per container for {@link SECRET_CACHE_MS}; a failed read is
 * not cached. Errors name the secret, never its value. The API role may read exactly these secrets (infra).
 */
export class MediaSecrets {
  readonly #client: Pick<SecretsManagerClient, 'send'>;
  readonly #now: () => number;
  readonly #cache = new Map<string, { readonly value: string; readonly at: number }>();

  constructor(options: MediaSecretsOptions) {
    this.#client = options.client ?? new SecretsManagerClient({ region: options.region });
    this.#now = options.now ?? Date.now;
  }

  /** The `apiKey` of the secret `name`, as a source an adapter calls when it needs the key. */
  apiKey(name: string): ApiKeySource {
    return () => this.#read(name);
  }

  async #read(name: string): Promise<string> {
    const cached = this.#cache.get(name);
    if (cached !== undefined && this.#now() - cached.at < SECRET_CACHE_MS) return cached.value;
    let raw: string | undefined;
    try {
      const output = await this.#client.send(new GetSecretValueCommand({ SecretId: name }));
      raw = output.SecretString;
    } catch (err) {
      throw new MediaSecretError(`secret ${name} could not be read`, {
        cause: err instanceof Error ? err.name : undefined,
      });
    }
    let value: unknown;
    try {
      value = raw === undefined ? undefined : (JSON.parse(raw) as { apiKey?: unknown }).apiKey;
    } catch {
      value = undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new MediaSecretError(`secret ${name} must be JSON {"apiKey": "..."}`);
    }
    const key = value.trim();
    this.#cache.set(name, { value: key, at: this.#now() });
    return key;
  }
}
