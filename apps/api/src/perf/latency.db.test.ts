/**
 * The latency harness (docs/runbooks/latency.md) end to end on the local profile: every stage of a typed and
 * a spoken turn is measured and reported, the stages come in order, and the timing log lines carry numbers
 * and identifiers only, never what the founder or the vEIR said.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportRows, markdownReport } from './report.js';
import { createLatencyRig, type LatencyRig } from './rig.js';
import { runScenario, type ScenarioResult } from './scenarios.js';
import { LATENCY_PROFILES } from './simulation.js';

let rig: LatencyRig;
let result: ScenarioResult;

beforeAll(async () => {
  // As production's venture memory was: some items repeated.
  rig = await createLatencyRig(LATENCY_PROFILES.local, { duplicateMemory: 3 });
  result = await runScenario(rig, { textTurns: 2, voiceTurns: 2 });
}, 120_000);
afterAll(async () => {
  await rig.cleanup();
});

const num = (v: unknown): number => {
  if (typeof v !== 'number') throw new Error(`expected a number, got ${String(v)}`);
  return v;
};

describe('the latency harness', () => {
  it('measures every stage of typed and spoken turns, in order', () => {
    expect(result.turns.map((t) => t.channel)).toEqual(['text', 'text', 'voice', 'voice']);
    for (const t of result.turns) {
      const s = t.server;
      if (s === null) throw new Error('a turn has no turn.timing line');
      const accepted = num(s.acceptedMs);
      const retrieval = num(s.retrievalMs);
      const modelStart = num(s.modelStartMs);
      const firstDelta = num(s.firstDeltaMs);
      const total = num(s.totalMs);
      expect(accepted).toBeLessThanOrEqual(modelStart);
      expect(retrieval).toBeLessThanOrEqual(modelStart);
      expect(modelStart).toBeLessThanOrEqual(firstDelta);
      expect(firstDelta).toBeLessThanOrEqual(total);
      expect(num(s.admissionMs)).toBeLessThanOrEqual(accepted);
      expect(num(s.embedMs)).toBeGreaterThanOrEqual(0);
      expect(num(s.dbRoundTrips)).toBeGreaterThan(10);
      expect(t.firstDeltaMs).not.toBeNull();
      expect(t.completedMs).not.toBeNull();
      expect(t.streamEndMs).toBeGreaterThanOrEqual(t.completedMs ?? Number.POSITIVE_INFINITY);
      if (t.channel === 'voice') {
        expect(s.voice).toBe(true);
        expect(num(s.firstSpeechMs)).toBeLessThanOrEqual(total);
        expect(t.firstAudioMs).not.toBeNull();
        expect(num(t.speech?.firstAudioMs)).toBeGreaterThanOrEqual(num(t.speech?.reservedMs));
      }
    }
    // The second spoken message is a quick question: its reply is one sentence, said as one unit, then the short
    // hand-back a reply that ends on a statement is given (wave 7: spoken_no_handback).
    expect(result.turns.at(-1)?.units).toBe(2);
    expect(result.requests.map((r) => r.name)).toEqual([
      'me',
      'venture',
      'conversations',
      'overview',
      'notebook',
      'memory',
      'call-config',
      'session-create',
      'conversation',
      'session-create',
      'call-start',
      'call-intro-speech',
      'call-end',
    ]);
    for (const r of result.requests) expect(num(r.server?.dbRoundTrips)).toBeGreaterThan(0);
  });

  it('measures the prompt each turn sent: its evidence and its size', () => {
    for (const t of result.turns) {
      expect(num(t.evidenceItems)).toBeGreaterThan(0);
      expect(num(t.evidenceTokens)).toBeGreaterThan(0);
      expect(num(t.inputTokens)).toBeGreaterThan(num(t.evidenceTokens));
    }
    const voice = result.turns.filter((t) => t.channel === 'voice');
    const typed = result.turns.filter((t) => t.channel === 'text');
    // A call's turn reads fewer items than a typed one (retrieval's voice caps), and no repeat takes a slot.
    for (const t of voice) expect(num(t.evidenceItems)).toBeLessThanOrEqual(13);
    expect(Math.max(...voice.map((t) => num(t.evidenceTokens)))).toBeLessThan(
      Math.min(...typed.map((t) => num(t.evidenceTokens))),
    );
  });

  it('reports a table of every flow', () => {
    const table = markdownReport(reportRows(result), rig.latency, 'local');
    expect(table).toContain('| typed turn | client: first sentence (turn.delta) | 2 |');
    expect(table).toContain('| voice turn | client: first audio bytes | 2 |');
    expect(table).toContain('| call-intro-speech | server: database round trips | 1 |');
    expect(table).toContain('| voice turn | prompt: evidence block (tokens, estimate) | 2 |');
  });

  it('logs numbers and identifiers only: no words of the conversation', () => {
    const timing = rig.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => ['turn.timing', 'speech.timing', 'http.request'].includes(String(line.event)));
    expect(timing.length).toBeGreaterThan(20);
    const allowedText = new Set([
      'level',
      'time',
      'event',
      'requestId',
      'turnId',
      'callId',
      'outcome',
      'method',
      'route',
      'principal',
      'code',
      'component',
    ]);
    for (const line of timing) {
      for (const [key, value] of Object.entries(line)) {
        if (typeof value === 'string') expect(allowedText, `${String(line.event)}.${key}`).toContain(key);
        else expect(['number', 'boolean'].includes(typeof value) || value === null, key).toBe(true);
      }
    }
    const joined = rig.logs.join('\n');
    for (const said of ['librarians', 'north campus', 'Quick question']) expect(joined).not.toContain(said);
  });
});
