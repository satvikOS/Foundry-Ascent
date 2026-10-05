import * as logs from 'aws-cdk-lib/aws-logs';

/** Maps a day count (validated in config.ts) to the CloudWatch Logs retention enum. */
export function retentionDays(days: number): logs.RetentionDays {
  const values: readonly unknown[] = Object.values(logs.RetentionDays);
  const match = values.find(
    (value): value is logs.RetentionDays => typeof value === 'number' && value === days,
  );
  if (match === undefined) throw new Error(`${String(days)} is not a CloudWatch Logs retention period`);
  return match;
}
