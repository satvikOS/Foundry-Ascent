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
 * The SPA's Content-Security-Policy. `connect-src` allows the app's own origin and exactly one other: the
 * documents bucket. A wildcard such as `https://*.s3.amazonaws.com` would let injected script send data to
 * any bucket in the world.
 */
export function contentSecurityPolicy(uploadOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${uploadOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

/** Two years, the HSTS preload list minimum is one. */
export const HSTS_MAX_AGE = Duration.days(730);

export interface SecurityHeadersProps {
  /** The only cross-origin `connect-src` (see `documentsUploadOrigin`). */
  readonly uploadOrigin: string;
}

export function createSecurityHeadersPolicy(
  scope: Construct,
  id: string,
  props: SecurityHeadersProps,
): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    comment: 'Foundry Ascent security headers (CSP, HSTS, frame denial)',
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        contentSecurityPolicy: contentSecurityPolicy(props.uploadOrigin),
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
