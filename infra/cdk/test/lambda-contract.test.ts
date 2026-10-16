/**
 * The infra side of apps/api/lambda-contract.json: the parser fails synth when the file drifts from what
 * this CDK app sets (environment names, the exact scheduled message bodies). The API parses the same file
 * with its own schema (apps/api/src/lambda-contract.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  environmentNames,
  LAMBDA_CONTRACT,
  LAMBDA_CONTRACT_FILE,
  parseLambdaContract,
} from '../src/lib/lambda-contract.js';

type Json = Record<string, unknown>;

const raw = (): Json => JSON.parse(readFileSync(LAMBDA_CONTRACT_FILE, 'utf8')) as Json;
const worker = (contract: Json): Json => contract.worker as Json;

describe('lambda contract', () => {
  it('gives the scheduled jobs their exact message bodies', () => {
    expect(JSON.parse(LAMBDA_CONTRACT.worker.dailyMaintenanceMessage)).toEqual({
      type: 'maintenance',
      task: 'daily',
    });
    expect(JSON.parse(LAMBDA_CONTRACT.worker.distillSweepMessage)).toEqual({ type: 'distill_sweep' });
  });

  it('passes the speech settings to the API only', () => {
    const speech = ['SPEECH_ENABLED', 'SPEECH_DEFAULT_VOICE', 'SPEECH_ENGINE'];
    expect(environmentNames('api')).toEqual(expect.arrayContaining(speech));
    for (const role of ['worker', 'migrate'] as const) {
      expect(
        environmentNames(role).filter((name) => speech.includes(name)),
        role,
      ).toEqual([]);
    }
  });

  it.each([
    [{ type: 'distill_session' }],
    [{ type: 'distill_sweep', sessionId: 'x' }],
    ['{"type":"distill_sweep"}'],
    [undefined],
  ])('rejects distillSweepMessage %j', (message) => {
    const contract = raw();
    worker(contract).distillSweepMessage = message;
    expect(() => parseLambdaContract(contract)).toThrow(/distillSweepMessage/);
  });

  it('still pins the daily maintenance message', () => {
    const contract = raw();
    worker(contract).dailyMaintenanceMessage = { type: 'maintenance', task: 'hourly' };
    expect(() => parseLambdaContract(contract)).toThrow(/dailyMaintenanceMessage/);
  });

  it('rejects malformed environment names', () => {
    const contract = raw();
    (contract.environment as Json).api = ['speech_enabled'];
    expect(() => parseLambdaContract(contract)).toThrow(/environment\.api\[0\]/);
  });
});
