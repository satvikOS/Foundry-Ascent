/**
 * The conversation lab's injection-audit split (lab-face-audits.ts): a `call.face_injection` audit from a heartbeat
 * check (`atEnd: false`) is told apart from one written by the final check after the face had ended (`atEnd: true`),
 * which the `face` suite's E10 must not count as the heartbeat catching the injection.
 */
import { auditRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from '../testing/api-harness.js';
import { countInjectionAudits, formatLine, parseIds } from './lab-face-audits.js';

let api: ApiHarness;

beforeAll(async () => {
  api = await createApiHarness();
});
afterAll(async () => {
  await api.cleanup();
});

function injection(atEnd: boolean | null) {
  return api.h.t.db.system((sx) =>
    auditRepo.appendAudit(sx, {
      action: 'call.face_injection',
      outcome: 'blocked',
      objectType: 'call',
      objectId: 'lab-call',
      policyReason: 'words_not_admitted',
      metadata: atEnd === null ? { provider: 'heygen' } : { provider: 'heygen', check: 'mismatch', atEnd },
    }),
  );
}

describe('lab-face-audits', () => {
  it('splits the injection audits the test saw by heartbeat and end-of-face checks, ignoring other rows', async () => {
    const atEnd = await injection(true);
    const heartbeat = await injection(false);
    const unrecorded = await injection(null);
    const other = await api.h.t.db.system((sx) =>
      auditRepo.appendAudit(sx, {
        action: 'call.face_transcript_unchecked',
        outcome: 'failed',
        metadata: {},
      }),
    );
    const notSeen = await injection(false);
    const ids = parseIds([
      String(atEnd),
      String(heartbeat),
      String(unrecorded),
      String(other),
      String(atEnd),
    ]);
    expect(ids).toHaveLength(4);
    const counts = await api.h.t.db.system((sx) => countInjectionAudits(sx, ids ?? []));
    expect(counts).toEqual({ heartbeat: 1, atEnd: 1, unknown: 1 });
    expect(formatLine(counts)).toBe('lab-face-audits: heartbeat=1 at_end=1 unknown=1');
    // Only the final check: the face was never ended by a heartbeat.
    expect(await api.h.t.db.system((sx) => countInjectionAudits(sx, [String(atEnd)]))).toEqual({
      heartbeat: 0,
      atEnd: 1,
      unknown: 0,
    });
    expect(notSeen).toBeGreaterThan(atEnd);
  });

  it('takes audit ids only', () => {
    expect(parseIds([])).toBeNull();
    expect(parseIds(['1', '2; DROP TABLE audit_events'])).toBeNull();
    expect(parseIds(['0'])).toBeNull();
    expect(parseIds(['-3'])).toBeNull();
    expect(parseIds(Array.from({ length: 51 }, (_, i) => String(i + 1)))).toBeNull();
    expect(parseIds([' 12 ', '12', '7'])).toEqual(['12', '7']);
  });
});
