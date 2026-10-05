/**
 * cdk-nag v3 acknowledgments (the successor of v2 `NagSuppressions`). Every acknowledgment is attached to
 * the narrowest construct that produces the finding, names one rule or one `Rule[finding]`, and carries a
 * written justification. Stack- or app-wide acknowledgments are deliberately not offered here.
 */
import { Stack, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

export interface NagAcknowledgment {
  /** Rule id (`AwsSolutions-S1`) or a single finding (`AwsSolutions-IAM5[Resource::*]`). */
  readonly id: string;
  readonly reason: string;
}

const RULE_ID = /^AwsSolutions-[A-Z]+\d+(\[.+\])?$/;
const MIN_REASON_LENGTH = 40;

export function acknowledge(scope: IConstruct, ...rules: readonly NagAcknowledgment[]): void {
  for (const rule of rules) {
    if (!RULE_ID.test(rule.id)) throw new Error(`Invalid cdk-nag rule id "${rule.id}" at ${scope.node.path}`);
    if (rule.reason.trim().length < MIN_REASON_LENGTH) {
      throw new Error(`cdk-nag acknowledgment ${rule.id} at ${scope.node.path} needs a real justification`);
    }
    Validations.of(scope).acknowledge({ id: rule.id, reason: rule.reason });
  }
}

/**
 * Same flattening cdk-nag applies to policy resources before reporting them (utils/flatten-cfn-reference
 * in cdk-nag 3.0.2), so finding ids can be derived from the very values put into a policy instead of
 * hard-coding logical ids or cross-stack output names.
 */
export function flattenCfnReference(reference: unknown): string {
  const visit = (node: unknown): string => {
    if (node === undefined) return '';
    if (typeof node === 'string') return node.replace(/\$\{/g, '<').replace(/\}/g, '>');
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      const join = record['Fn::Join'];
      if (Array.isArray(join)) {
        const [delimiter, items] = join as [string, unknown[]];
        return items.map(visit).join(delimiter);
      }
      if (record['Fn::Sub'] !== undefined) return visit(record['Fn::Sub']);
      const getAtt = record['Fn::GetAtt'];
      if (Array.isArray(getAtt)) {
        const [resource, attribute] = getAtt as [unknown, unknown];
        return `<${visit(resource)}.${visit(attribute)}>`;
      }
      if (record['Fn::ImportValue'] !== undefined) return visit(record['Fn::ImportValue']);
      if (record.Ref !== undefined) return `<${visit(record.Ref)}>`;
    }
    return JSON.stringify(node);
  };
  return visit(reference);
}

/** `AwsSolutions-IAM5[Resource::…]` finding id for a policy resource (string or token) used in `scope`'s stack. */
export function wildcardResource(scope: IConstruct, resource: string): string {
  return `AwsSolutions-IAM5[Resource::${flattenCfnReference(Stack.of(scope).resolve(resource))}]`;
}

/** `AwsSolutions-IAM5[Action::…]` finding id. */
export function wildcardAction(action: string): string {
  return `AwsSolutions-IAM5[Action::${action}]`;
}

/** `AwsSolutions-IAM4[Policy::…]` finding id for an AWS managed policy. */
export function managedPolicy(name: string): string {
  return `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${name}]`;
}
