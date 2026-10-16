import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SttGrantError, type IssuedSttGrant, type SttGrantIssuer, type SttGrantRequest } from '@foundry/core';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  readonly expiration?: Date | undefined;
}

export interface TranscribePresignerOptions {
  readonly region: string;
  /** Static credentials or a provider. Default: the Node credential chain (the Lambda role in production). */
  readonly credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
  /** Clock override (tests). */
  readonly now?: () => Date;
}

/** Amazon Transcribe streaming's WebSocket endpoint (port and path are fixed by the service). */
export const TRANSCRIBE_STREAMING_PORT = 8443;
export const TRANSCRIBE_STREAMING_PATH = '/stream-transcription-websocket';
/** Transcribe refuses presigned URLs that live longer than this. */
export const MAX_PRESIGN_SECONDS = 300;

/** RFC 3986 percent-encoding, as SigV4 canonicalizes query strings. */
function uriEscape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Speech-to-text grants for calls (core `SttGrantIssuer` port): a SigV4-presigned URL for Amazon Transcribe
 * streaming over WebSocket, which the browser opens directly; the founder's audio never passes through our
 * API. Signed with the API role's own credentials (credential provider chain; no keys in code or config), so
 * the role needs `transcribe:StartStreamTranscriptionWebSocket`. The URL authorizes exactly one stream
 * request with these parameters (US English, 16 kHz PCM, stabilized partial results) for at most five
 * minutes; it carries the role's temporary session token, never its secret key. URLs are never logged.
 */
export class TranscribeStreamingPresigner implements SttGrantIssuer {
  readonly #signer: SignatureV4;
  readonly #hostname: string;
  readonly #now: () => Date;

  constructor(options: TranscribePresignerOptions) {
    this.#hostname = `transcribestreaming.${options.region}.amazonaws.com`;
    this.#now = options.now ?? (() => new Date());
    this.#signer = new SignatureV4({
      service: 'transcribe',
      region: options.region,
      credentials: options.credentials ?? defaultProvider(),
      sha256: Sha256,
      uriEscapePath: true,
      applyChecksum: false,
    });
  }

  async issue(request: SttGrantRequest): Promise<IssuedSttGrant> {
    const expiresIn = Math.min(MAX_PRESIGN_SECONDS, Math.max(1, Math.floor(request.expiresInSeconds)));
    const signingDate = this.#now();
    const host = `${this.#hostname}:${String(TRANSCRIBE_STREAMING_PORT)}`;
    let signed: HttpRequest;
    try {
      signed = (await this.#signer.presign(
        new HttpRequest({
          method: 'GET',
          protocol: 'wss:',
          hostname: this.#hostname,
          port: TRANSCRIBE_STREAMING_PORT,
          path: TRANSCRIBE_STREAMING_PATH,
          headers: { host },
          query: {
            'language-code': request.languageCode,
            'media-encoding': 'pcm',
            'sample-rate': String(request.sampleRateHertz),
            'enable-partial-results-stabilization': 'true',
            'partial-results-stability': 'high',
          },
        }),
        { expiresIn, signingDate },
      )) as HttpRequest;
    } catch (err) {
      throw new SttGrantError('could not presign the speech-to-text stream', { cause: err });
    }
    const query = Object.entries(signed.query)
      .flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).flatMap((v) =>
          v === null ? [] : [`${uriEscape(key)}=${uriEscape(v)}`],
        ),
      )
      .sort()
      .join('&');
    return {
      url: `wss://${host}${TRANSCRIBE_STREAMING_PATH}?${query}`,
      expiresAt: new Date(signingDate.getTime() + expiresIn * 1000).toISOString(),
    };
  }
}
