/**
 * Speech inside a spoken turn's own stream (docs/runbooks/latency.md): a turn that asks for it (`speechAudio: 'pcm'`)
 * carries each signed unit's audio as `turn.audio` frames right after the unit, voiced by the stock ElevenLabs voice
 * (fake vendors behind the ports), with no `POST /speech`. Each unit is reserved, metered and audited once, as
 * `POST /speech` does it, and asked for again there it is refused as already spoken (never synthesized twice); a vendor
 * failure is said by Polly in the same stream; a turn that does not ask for it is unchanged.
 */
import { SessionView, StartCallResponse, TurnStreamEvent } from '@foundry/contracts';
import { FakeSpeechSynthesizer, FakeVoiceProvider } from '@foundry/core/testing';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
const polly = new FakeSpeechSynthesizer();
const eleven = new FakeVoiceProvider('elevenlabs', 0.04);
let maya: string;

beforeAll(async () => {
  api = await createApiHarness({
    speech: polly,
    stockVoice: { provider: eleven, voiceRef: 'AaOhDHYJ1XLZk74lXhdE', fallbackVoiceId: 'Matthew' },
  });
  maya = await api.signInAs(api.h.people.maya);
});
afterAll(async () => {
  await api.cleanup();
});

type AudioFrame = Extract<TurnStreamEvent, { event: 'turn.audio' }>;
type SpeechUnit = Extract<TurnStreamEvent, { event: 'turn.speech' }>;

async function newCall(): Promise<{ sessionId: string; callId: string }> {
  const session = SessionView.parse(
    await (
      await api.request(`/ventures/${api.h.ventures.quietquad.id}/sessions`, { body: {}, cookie: maya })
    ).json(),
  );
  const started = StartCallResponse.parse(
    await (
      await api.request(`/sessions/${session.id}/calls`, {
        body: { inputMode: 'typed', replace: true },
        cookie: maya,
      })
    ).json(),
  );
  return { sessionId: session.id, callId: started.call.id };
}

let keys = 0;
async function turn(
  call: { sessionId: string; callId: string },
  speechAudio: boolean,
): Promise<{ events: TurnStreamEvent[]; requestId: string }> {
  keys += 1;
  const requestId = `speech-in-turn-${String(keys)}`;
  const res = await api.request(`/sessions/${call.sessionId}/turns`, {
    body: {
      text: 'We interviewed twelve librarians this week. Which signal should we trust most?',
      channel: 'voice',
      callId: call.callId,
      ...(speechAudio ? { speechAudio: 'pcm' } : {}),
    },
    cookie: maya,
    idempotencyKey: `${requestId}-key`,
    headers: { 'x-request-id': requestId },
  });
  expect(res.status).toBe(200);
  const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
  return { events, requestId };
}

const unitsOf = (events: TurnStreamEvent[]) =>
  events.filter((e): e is SpeechUnit => e.event === 'turn.speech');
const audioOf = (events: TurnStreamEvent[], seq: number) =>
  events.filter((e): e is AudioFrame => e.event === 'turn.audio' && e.seq === seq);
const pcmBytes = (frames: AudioFrame[]) =>
  frames.reduce((n, f) => n + (f.pcm === undefined ? 0 : Buffer.from(f.pcm, 'base64').byteLength), 0);

/** `POST /speech` requests the API answered so far (its `http.request` log lines). */
function speechRequests(): number {
  return api.logs
    .map((line) => JSON.parse(line) as { event?: string; route?: string })
    .filter((l) => l.event === 'http.request' && l.route?.endsWith('/speech') === true).length;
}

async function audits(turnId: string): Promise<Record<string, unknown>[]> {
  const r = await api.h.t.db.system((sx) =>
    sx.query("SELECT metadata FROM audit_events WHERE action = 'speech.synthesized' AND object_id = :id", {
      id: p.text(turnId),
    }),
  );
  return r.rows.map((row) => {
    const raw: unknown = row.metadata;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  });
}

describe('speech inside the turn stream', () => {
  it('carries each unit’s PCM right after the unit, reserved, metered and audited once, with no POST /speech', async () => {
    const call = await newCall();
    const before = eleven.calls.length;
    const prewarms = eleven.prewarms;
    const speechRequestsBefore = speechRequests();
    const { events, requestId } = await turn(call, true);
    const units = unitsOf(events);
    expect(units.length).toBeGreaterThan(0);
    const turnId = units[0]?.turnId ?? '';
    for (const unit of units) {
      expect(unit.audio).toBe(true);
      const frames = audioOf(events, unit.seq);
      // After its unit; its rate on the first frame; closed once, last.
      expect(events.indexOf(frames[0] as TurnStreamEvent)).toBeGreaterThan(events.indexOf(unit));
      expect(frames[0]?.sampleRate).toBe(24_000);
      expect(frames.filter((f) => f.end !== undefined).map((f) => f.end)).toEqual(['done']);
      expect(frames.at(-1)?.end).toBe('done');
      expect(pcmBytes(frames)).toBeGreaterThan(0);
      expect(pcmBytes(frames) % 2).toBe(0);
    }
    // The terminal event is there (the stream ends once the turn settled and the last unit's audio was sent).
    expect(events.some((e) => e.event === 'turn.completed')).toBe(true);

    // Each unit synthesized once, as raw 24 kHz PCM, the unit before it as context; the vendor's connection warmed.
    const made = eleven.calls.slice(before);
    expect(made).toHaveLength(units.length);
    expect(made.every((c) => c.format === 'pcm_24000' && c.unit !== null)).toBe(true);
    if (units.length > 1) expect(made[1]?.previousText).toBeTruthy();
    expect(eleven.prewarms).toBeGreaterThan(prewarms);

    // Reserved and metered like POST /speech, audited as voiced in the turn.
    const audited = await audits(turnId);
    expect(audited).toHaveLength(units.length);
    expect(audited.every((m) => m.inTurn === true && m.signed === true)).toBe(true);
    const ledger = await api.h.t.db.system((sx) =>
      sx.query("SELECT count(*)::int AS n FROM usage_ledger WHERE purpose = 'speech' AND request_id = :id", {
        id: p.text(requestId),
      }),
    );
    expect(ledger.rows[0]?.n).toBe(units.length);

    // The page made no POST /speech; asked anyway, a unit voiced in the stream is never synthesized twice.
    expect(speechRequests()).toBe(speechRequestsBefore);
    const first = units[0];
    if (first === undefined) throw new Error('no unit');
    const again = await api.request('/speech', {
      body: { sessionId: call.sessionId, turnId, seq: first.seq, text: first.text, sig: first.sig },
      cookie: maya,
      headers: { accept: 'audio/pcm, audio/mpeg, application/problem+json' },
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reason?: string }).reason).toBe('speech_already_played');
    expect(eleven.calls.length - before).toBe(units.length);
  });

  it('leaves a turn that does not ask for it unchanged: units without audio, nothing voiced', async () => {
    const call = await newCall();
    const before = eleven.calls.length + polly.calls.length;
    const { events } = await turn(call, false);
    expect(unitsOf(events).length).toBeGreaterThan(0);
    expect(unitsOf(events).every((u) => u.audio === undefined)).toBe(true);
    expect(events.some((e) => e.event === 'turn.audio')).toBe(false);
    expect(eleven.calls.length + polly.calls.length).toBe(before);
  });

  it('leaves the crisis support line to POST /speech (a stock voice, a few plays, whatever the caps)', async () => {
    const call = await newCall();
    const before = eleven.calls.length + polly.calls.length;
    const res = await api.request(`/sessions/${call.sessionId}/turns`, {
      body: {
        text: 'I want to kill myself tonight.',
        channel: 'voice',
        callId: call.callId,
        speechAudio: 'pcm',
      },
      cookie: maya,
      idempotencyKey: 'speech-in-turn-crisis-key',
    });
    const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'crisis_support' });
    const units = unitsOf(events);
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.audio === undefined)).toBe(true);
    expect(events.some((e) => e.event === 'turn.audio')).toBe(false);
    expect(eleven.calls.length + polly.calls.length).toBe(before);
  });

  it('decides the voice once per turn: the vendor voice switched off, Polly voices the turn in the stream', async () => {
    const call = await newCall();
    await api.h.t.db.system((sx) =>
      sx.query(
        `INSERT INTO platform_settings (key, value) VALUES ('vendor_voice_enabled', 'false'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        {},
      ),
    );
    try {
      const before = eleven.calls.length;
      const pollyBefore = polly.calls.length;
      const { events } = await turn(call, true);
      const units = unitsOf(events);
      expect(units.every((u) => u.audio === true)).toBe(true);
      expect(audioOf(events, 0)[0]?.sampleRate).toBe(16_000);
      expect(eleven.calls.length).toBe(before);
      expect(polly.calls.length - pollyBefore).toBe(units.length);
    } finally {
      await api.h.t.db.system((sx) =>
        sx.query(`UPDATE platform_settings SET value = 'true'::jsonb WHERE key = 'vendor_voice_enabled'`, {}),
      );
    }
  });

  it('a vendor that fails is replaced by Polly in the same stream, unit by unit, with no gap and nothing said twice', async () => {
    const call = await newCall();
    const pollyBefore = polly.calls.length;
    eleven.failNext = true;
    const { events } = await turn(call, true);
    const units = unitsOf(events);
    expect(units.length).toBeGreaterThan(0);
    const first = audioOf(events, units[0]?.seq ?? 0);
    // Polly's 16 kHz PCM, the unit closed once.
    expect(first[0]?.sampleRate).toBe(16_000);
    expect(first.filter((f) => f.end !== undefined).map((f) => f.end)).toEqual(['done']);
    expect(
      polly.calls.slice(pollyBefore).every((c) => c.format === 'pcm_16000' && c.voiceId === 'Matthew'),
    ).toBe(true);
    // Every unit was voiced exactly once (the vendor rests: the next units go to Polly at once).
    expect(polly.calls.length - pollyBefore).toBe(units.length);
    const audited = await audits(units[0]?.turnId ?? '');
    expect(audited.filter((m) => m.fallback === true)).toHaveLength(units.length);
  });
});
