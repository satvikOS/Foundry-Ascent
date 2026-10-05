import { App } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { readSiteDomain } from '../src/app.js';
import { resourcesOfType, synthesize } from './helpers.js';

const DOMAIN = 'ascent.example.org';
const CERTIFICATE = 'arn:aws:acm:us-east-1:123456789012:certificate/0f2b8c1e-1d1a-4c5e-9b7a-2f9a1c3d4e5f';

describe('custom site domain (context siteDomainName + siteCertificateArn)', () => {
  const { templates } = synthesize({ siteDomainName: DOMAIN, siteCertificateArn: CERTIFICATE });

  it('serves the alias with the ACM certificate and TLS 1.2 minimum', () => {
    templates.app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [DOMAIN],
        ViewerCertificate: {
          AcmCertificateArn: CERTIFICATE,
          MinimumProtocolVersion: 'TLSv1.2_2021',
          SslSupportMethod: 'sni-only',
        },
      }),
    });
  });

  it('passes SITE_ORIGIN to the API and reports it as SiteUrl', () => {
    const api = resourcesOfType(templates.app, 'AWS::Lambda::Function').find(
      ([, p]) => p.FunctionName === 'FoundryAscent-Api',
    );
    expect((api?.[1].Environment as { Variables: Record<string, unknown> }).Variables.SITE_ORIGIN).toBe(
      `https://${DOMAIN}`,
    );
    templates.app.hasOutput('SiteUrl', { Value: `https://${DOMAIN}` });
  });

  it('allows uploads from the site origin', () => {
    templates.data.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [Match.objectLike({ AllowedOrigins: ['https://*.cloudfront.net', `https://${DOMAIN}`] })],
      },
    });
  });
});

describe('readSiteDomain', () => {
  const app = (context: Record<string, string>): App => new App({ context });

  it('is optional', () => {
    expect(readSiteDomain(app({}))).toBeUndefined();
  });

  it('requires both values', () => {
    expect(() => readSiteDomain(app({ siteDomainName: DOMAIN }))).toThrow(/must be set together/);
    expect(() => readSiteDomain(app({ siteCertificateArn: CERTIFICATE }))).toThrow(/must be set together/);
  });

  it('rejects certificates outside us-east-1 and malformed domains', () => {
    expect(() =>
      readSiteDomain(
        app({ siteDomainName: DOMAIN, siteCertificateArn: CERTIFICATE.replace('us-east-1', 'eu-west-1') }),
      ),
    ).toThrow(/siteCertificateArn/);
    expect(() =>
      readSiteDomain(app({ siteDomainName: 'https://x', siteCertificateArn: CERTIFICATE })),
    ).toThrow(/siteDomainName/);
  });
});
