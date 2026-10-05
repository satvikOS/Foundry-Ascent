import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp, type FoundryApp } from '../src/app.js';
import type { PlatformConfig } from '../src/config.js';
import { INFRA_ROOT } from '../src/paths.js';

export interface CdkJson {
  readonly app: string;
  readonly context: Record<string, unknown>;
}

export function readCdkJson(): CdkJson {
  return JSON.parse(readFileSync(join(INFRA_ROOT, 'cdk.json'), 'utf8')) as CdkJson;
}

export interface Synthesized extends FoundryApp {
  readonly templates: {
    readonly foundation: Template;
    readonly data: Template;
    readonly app: Template;
  };
  readonly all: readonly Template[];
}

/**
 * Synthesizes the real app (cdk.json context, real config) with stub assets: no AWS credentials, no
 * dependency on apps/api or apps/web being built. `Template.fromStack` runs the full synthesis, including
 * the cdk-nag validation plugin, which throws on any unacknowledged finding.
 */
export function synthesize(extraContext: Record<string, string> = {}, config?: PlatformConfig): Synthesized {
  const outdir = mkdtempSync(join(tmpdir(), 'foundry-cdk-test-'));
  const app = new App({ context: { ...readCdkJson().context, ...extraContext }, outdir });
  const built = buildApp({ app, stubAssets: true, ...(config ? { config } : {}) });
  const templates = {
    foundation: Template.fromStack(built.foundation),
    data: Template.fromStack(built.data),
    app: Template.fromStack(built.appStack),
  };
  return { ...built, templates, all: [templates.foundation, templates.data, templates.app] };
}

let cached: Synthesized | undefined;

/** Default synthesis, shared by the tests of one file (vitest isolates files in separate workers). */
export function defaultSynth(): Synthesized {
  cached ??= synthesize({ appVersion: 'test-sha' });
  return cached;
}

export type CfnResources = Record<
  string,
  { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] }
>;

export function resources(template: Template): CfnResources {
  return (template.toJSON() as { Resources: CfnResources }).Resources;
}

export function resourcesOfType(template: Template, type: string): [string, Record<string, unknown>][] {
  return Object.entries(resources(template))
    .filter(([, r]) => r.Type === type)
    .map(([id, r]) => [id, r.Properties ?? {}]);
}

export type RoleStatement = Record<string, unknown>;

/** Statements of every AWS::IAM::Policy attached to the role of the named function. */
export function functionPolicyStatements(template: Template, functionName: string): RoleStatement[] {
  const fn = resourcesOfType(template, 'AWS::Lambda::Function').find(
    ([, p]) => p.FunctionName === functionName,
  );
  if (!fn) throw new Error(`function ${functionName} not found`);
  const roleRef = (fn[1].Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
  return resourcesOfType(template, 'AWS::IAM::Policy')
    .filter(([, p]) => (p.Roles as { Ref: string }[]).some((r) => r.Ref === roleRef))
    .flatMap(([, p]) => (p.PolicyDocument as { Statement: RoleStatement[] }).Statement);
}
