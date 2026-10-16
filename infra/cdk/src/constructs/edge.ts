/**
 * CloudFront edge configuration: viewer-request functions and the security-headers policy.
 * Function bodies are cloudfront-js-2.0 source; they are exported so tests can execute them.
 */
import { Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type { Construct } from 'constructs';
import { VIEWER_HOST_HEADER, VIEWER_IP_HEADER } from '../lib/constants.js';

/**
 * Default (S3) behavior, viewer-request: client-side routes (no file extension in the last path segment)
 * are served `/index.html`; files (`/assets/app-3f2a.js`, `/favicon.svg`) pass through. `/api/*` has its
 * own behavior and never reaches this function; the guard keeps `/api` itself from becoming the SPA.
 */
export const SPA_REWRITE_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/api' || uri.indexOf('/api/') === 0) {
    return request;
  }
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
`;

/**
 * /api/* behavior, viewer-request (cloudfront-js-2.0). Sets two trusted headers, overwriting anything the
 * client sent under the same names (CloudFront lower-cases header names in the event, so no case variant
 * survives):
 *
 * - ${VIEWER_IP_HEADER}: `event.viewer.ip`, the address of the client that connected to CloudFront
 *   (CloudFront Functions event structure: `{ version, context, viewer: { ip }, request }`). The API keys
 *   its per-IP sign-in lockout on it instead of the client-controlled `x-forwarded-for`.
 * - ${VIEWER_HOST_HEADER}: the host the browser addressed (the distribution domain or an alternate domain
 *   name; CloudFront only routes requests whose Host belongs to this distribution). The origin request
 *   policy forwards every viewer header except Host (the Function URL needs its own Host for SigV4), so
 *   this is how the API learns its public origin.
 *
 * The Function URL only accepts SigV4-signed requests from this distribution (OAC), so neither header can
 * be forged by calling the URL directly.
 */
export const API_VIEWER_REQUEST_CODE = `function handler(event) {
  var request = event.request;
  var headers = request.headers;
  var host = headers.host && headers.host.value
    ? headers.host.value
    : event.context.distributionDomainName;
  headers['${VIEWER_HOST_HEADER}'] = { value: host };
  headers['${VIEWER_IP_HEADER}'] = { value: event.viewer.ip };
  return request;
}
`;

/**
 * Origin the browser uploads documents to: the presigned PUT URLs the API signs (apps/api
 * s3-object-store.ts, AWS SDK v3 defaults) address the documents bucket's virtual-hosted, regional
 * endpoint `https://<bucket>.s3.<region>.amazonaws.com`. The bucket name may be a token (it comes from
 * the Data stack); CloudFront does not parse the policy until deploy time.
 */
export function documentsUploadOrigin(bucketName: string, region: string): string {
  return `https://${bucketName}.s3.${region}.amazonaws.com`;
}

/**
 * Origin of Amazon Transcribe streaming's WebSocket endpoint. During a voice call the browser streams the
 * founder's microphone audio straight to it over a URL the API presigns (ADR-0010); the audio never passes
 * through this platform. Port 8443 is part of the origin, so it must be named exactly.
 */
export function speechToTextOrigin(region: string): string {
  return `wss://transcribestreaming.${region}.amazonaws.com:8443`;
}

export interface ContentSecurityPolicyOrigins {
  /** The documents bucket endpoint presigned uploads go to (`documentsUploadOrigin`). */
  readonly uploadOrigin: string;
  /** Amazon Transcribe streaming (`speechToTextOrigin`). */
  readonly speechToTextOrigin: string;
}

/**
 * The SPA's Content-Security-Policy. `connect-src` allows the app's own origin and exactly two others:
 * the documents bucket and Transcribe streaming. A wildcard such as `https://*.s3.amazonaws.com` would let
 * injected script send data to any bucket in the world. The Transcribe endpoint serves every AWS account,
 * so it cannot be pinned to ours; `script-src 'self'` (no inline or third-party script) is what keeps
 * injected code from using it.
 *
 * Voice calls (ADR-0010) also rely on:
 * - `media-src 'self' blob:`: the call screen fetches synthesized speech (`POST /api/v1/speech`,
 *   `audio/mpeg`) and plays it from a `blob:` object URL. Remote media stays blocked.
 * - `script-src 'self'` for the microphone's AudioWorklet: a worklet module is fetched as a script
 *   (CSP3 `script-src-elem`, falling back to `script-src`), so a same-origin static file such as
 *   `/worklets/<name>.js` loads, while `blob:` and cross-origin modules are refused. Verified in Chromium
 *   on 2026-10-16; no `worker-src` is needed.
 *
 * `style-src` keeps `'unsafe-inline'`: Radix's scroll lock injects a `<style>` element at runtime. The SPA
 * already ships that rule and sonner's styles in its own stylesheet, so removing `'unsafe-inline'` is a
 * one-line change once a browser pass over every page shows no violation.
 */
export function contentSecurityPolicy(origins: ContentSecurityPolicyOrigins): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${origins.uploadOrigin} ${origins.speechToTextOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Powerful features the SPA may use. The microphone is allowed for this origin only (`self`; never for
 * frames, and `frame-ancestors 'none'` keeps the app out of other sites' frames) so a founder can talk to
 * the vEIR in a call; the browser still asks the person before the first capture. Camera and geolocation
 * stay off: calls are voice only and nothing needs a location (ADR-0010).
 */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(self), geolocation=()';

/** Two years, the HSTS preload list minimum is one. */
export const HSTS_MAX_AGE = Duration.days(730);

export type SecurityHeadersProps = ContentSecurityPolicyOrigins;

export function createSecurityHeadersPolicy(
  scope: Construct,
  id: string,
  props: SecurityHeadersProps,
): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    comment: 'Foundry Ascent security headers (CSP, HSTS, frame denial)',
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        contentSecurityPolicy: contentSecurityPolicy(props),
        override: true,
      },
      strictTransportSecurity: {
        accessControlMaxAge: HSTS_MAX_AGE,
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
    },
    customHeadersBehavior: {
      customHeaders: [{ header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true }],
    },
  });
}

export function createViewerRequestFunction(
  scope: Construct,
  id: string,
  code: string,
  comment: string,
): cloudfront.Function {
  return new cloudfront.Function(scope, id, {
    code: cloudfront.FunctionCode.fromInline(code),
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    comment,
  });
}
