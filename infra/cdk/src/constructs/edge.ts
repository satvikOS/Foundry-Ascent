/**
 * CloudFront edge configuration: viewer-request functions and the security-headers policy.
 * Function bodies are cloudfront-js-2.0 source; they are exported so tests can execute them.
 */
import { Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type { Construct } from 'constructs';
import { VIEWER_HOST_HEADER } from '../lib/constants.js';

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
 * /api/* behavior, viewer-request: records the host the browser addressed (the distribution domain or an
 * alternate domain name; CloudFront only routes requests whose Host belongs to this distribution) in
 * ${VIEWER_HOST_HEADER}. The origin request policy forwards every viewer header except Host (the Function
 * URL needs its own Host for SigV4), so this is how the API learns its public origin. Any value the client
 * sent is overwritten. The Function URL only accepts SigV4-signed requests from this distribution (OAC),
 * so the header cannot be forged by calling the URL directly.
 */
export const API_VIEWER_HOST_CODE = `function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value
    ? request.headers.host.value
    : event.context.distributionDomainName;
  request.headers['${VIEWER_HOST_HEADER}'] = { value: host };
  return request;
}
`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

/** Two years, the HSTS preload list minimum is one. */
export const HSTS_MAX_AGE = Duration.days(730);

export function createSecurityHeadersPolicy(scope: Construct, id: string): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    comment: 'Foundry Ascent security headers (CSP, HSTS, frame denial)',
    securityHeadersBehavior: {
      contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
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
