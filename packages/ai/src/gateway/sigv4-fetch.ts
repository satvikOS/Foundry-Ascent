import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  expiration?: Date | undefined;
}
export type AwsCredentialProvider = () => Promise<AwsCredentials>;

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `BodyInit` is not a global in Node's type definitions without the DOM lib. */
type RequestBody = NonNullable<RequestInit['body']>;

export interface SigV4FetchOptions {
  region: string;
  /** SigV4 signing name. Default `bedrock-mantle`. */
  service?: string;
  /** Static credentials or a provider. Default: the Node credential chain (env, SSO, ini, IMDS/ECS, Lambda role). */
  credentials?: AwsCredentials | AwsCredentialProvider;
  /** Underlying fetch. Default `globalThis.fetch`. */
  fetch?: FetchFn;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * Only these headers are signed. Everything else (user-agent, accept-encoding, x-stainless-*,
 * content-length, …) may be added or rewritten by fetch/undici or the OpenAI SDK after signing, and
 * a signed header that changes in flight breaks the signature.
 */
function isSignable(name: string): boolean {
  return name === 'host' || name === 'content-type' || name.startsWith('x-amz-');
}

async function bodyToSignable(
  body: RequestBody | null | undefined,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // Streams and FormData cannot be hashed without consuming them; the JSON APIs we call never use them.
  throw new TypeError('SigV4 fetch: unsupported request body type (streams and FormData cannot be signed)');
}

function queryBag(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return query;
}

/**
 * Returns a `fetch` that SigV4-signs every request (e.g. for the Bedrock Mantle OpenAI-compatible
 * endpoint, service `bedrock-mantle`). The exact body bytes are hashed and sent; any bearer
 * `Authorization` header added by an SDK is removed before signing.
 */
export function createSigV4Fetch(options: SigV4FetchOptions): FetchFn {
  const baseFetch: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const credentials = options.credentials ?? defaultProvider();
  const signer = new SignatureV4({
    service: options.service ?? 'bedrock-mantle',
    region: options.region,
    credentials,
    sha256: Sha256,
    uriEscapePath: true,
    applyChecksum: true,
  });
  const now = options.now ?? (() => new Date());

  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input instanceof URL ? input.href : input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.delete('authorization');

    let rawBody: RequestBody | null | undefined = init?.body;
    if (rawBody === undefined && request && request.body !== null) rawBody = await request.arrayBuffer();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await bodyToSignable(rawBody);

    const toSign: Record<string, string> = { host: url.host };
    headers.forEach((value, key) => {
      if (isSignable(key)) toSign[key] = value;
    });

    const signed = await signer.sign(
      new HttpRequest({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname,
        query: queryBag(url),
        headers: toSign,
        body,
      }),
      { signingDate: now() },
    );

    for (const [key, value] of Object.entries(signed.headers)) {
      // fetch derives `host` from the URL; setting it explicitly is forbidden.
      if (key.toLowerCase() !== 'host') headers.set(key, value);
    }

    const { headers: _ignoredHeaders, body: _ignoredBody, method: _ignoredMethod, ...rest } = init ?? {};
    const finalInit: RequestInit = { ...rest, method, headers };
    if (body !== undefined) finalInit.body = body;
    if (request && init?.signal === undefined) finalInit.signal = request.signal;
    return baseFetch(url.href, finalInit);
  };
}
