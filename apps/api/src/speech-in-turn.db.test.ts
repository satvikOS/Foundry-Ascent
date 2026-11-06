/**
 * Speech inside a spoken turn's own stream (docs/runbooks/latency.md): a turn that asks for it (`speechAudio: 'pcm'`)
 * carries each signed unit's audio as `turn.audio` frames right after the unit, voiced by the stock ElevenLabs voice
 * (fake vendors behind the ports), with no `POST /speech`. Each unit is reserved, metered and audited once, as
 * `POST /speech` does it, and asked for again there it is refused as already spoken (never synthesized twice); a vendor
 * failure is said by Polly in the same stream; a turn that does not ask for it is unchanged.
 */
import { SessionView, StartCallResponse, TurnStreamEvent } from '@foundry/contracts';
import { type SynthesizedSpeech, type VoiceProvider, type VoiceSynthesisInput } from '@foundry/core';
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
    // Up to VOICE_AHEAD units synthesize at once, each reserved on its own connection, so the vendor may be asked for
    // unit 1 before unit 0 (CI did): the context is checked per unit, by seq, never by the order the vendor was asked.
    expect(units.length).toBeGreaterThan(1);
    const bySeq = [...made].sort((a, b) => (a.unit?.seq ?? 0) - (b.unit?.seq ?? 0));
    expect(bySeq.map((c) => c.unit?.seq)).toEqual(units.map((u) => u.seq));
    expect(bySeq[0]?.previousText).toBeUndefined();
    for (let i = 1; i < bySeq.length; i += 1) {
      // The words of the unit before it, as that unit was said (spoken form), its last NEIGHBOUR_CHARS (300).
      const said = bySeq[i - 1]?.text ?? '';
      expect(said).not.toBe('');
      expect(bySeq[i]?.previousText).toBe(said.slice(-300).trimStart());
    }
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

/**
 * A vendor voice that holds every synthesis until it is released or aborted (it honours the request's signal, as the
 * ElevenLabs adapter does): the units of a reply are still being voiced when its terminal event comes.
 */
class HeldVoice implements VoiceProvider {
  readonly id = 'elevenlabs' as const;
  readonly model = 'test_model';
  readonly usdPer1kCharacters = 0.04;
  readonly inner = new FakeVoiceProvider('elevenlabs', 0.04);
  readonly calls: VoiceSynthesisInput[] = [];
  aborted = 0;
  #held: (() => void)[] = [];
  hold = true;

  synthesize(input: VoiceSynthesisInput): Promise<SynthesizedSpeech> {
    this.calls.push(input);
    if (!this.hold) return this.inner.synthesize(input);
    return new Promise<SynthesizedSpeech>((resolve, reject) => {
      input.signal?.addEventListener(
        'abort',
        () => {
          this.aborted += 1;
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
      this.#held.push(() => {
        resolve(this.inner.synthesize(input));
      });
    });
  }

  release(): void {
    this.hold = false;
    for (const go of this.#held.splice(0)) go();
  }
}

describe('speech inside the turn stream: a reply blocked or failed after its units were announced', () => {
  let held: ApiHarness;
  let cookie: string;
  const vendor = new HeldVoice();
  let reply = '';
  // Every sentence passes the sentence gate and is released as it is written; the last names the EIR, so the whole
  // reply is blocked after the units before it were announced (identity).
  const NAMES_THE_EIR =
    'Start with the door counts this week. Then count the seats at lunch every day. ' +
    'Then ask the manager about the busy hours. Then compare the two weeks side by side. ' +
    'corin here, by the way.';
  const LONG =
    'Start with the door counts this week. Then count the seats at lunch every day. ' +
    'Then ask the manager about the busy hours. Then compare the two weeks side by side. ' +
    'Then write down what surprised you most. Then bring the numbers to our next call. ' +
    'Then pick the one hour that matters most. Then test a sign at the door for a week. ' +
    'Then count again with the sign up. Then tell me which number moved and by how much.';

  beforeAll(async () => {
    held = await createApiHarness({
      speech: new FakeSpeechSynthesizer(),
      stockVoice: { provider: vendor, voiceRef: 'AaOhDHYJ1XLZk74lXhdE', fallbackVoiceId: 'Matthew' },
      gatewayOptions: { streamDelayMs: 0, streamFixture: () => reply },
    });
    cookie = await held.signInAs(held.h.people.maya);
  });
  afterAll(async () => {
    await held.cleanup();
  });

  async function heldCall(): Promise<{ sessionId: string; callId: string }> {
    const session = SessionView.parse(
      await (
        await held.request(`/ventures/${held.h.ventures.quietquad.id}/sessions`, { body: {}, cookie })
      ).json(),
    );
    const started = StartCallResponse.parse(
      await (
        await held.request(`/sessions/${session.id}/calls`, {
          body: { inputMode: 'typed', replace: true },
          cookie,
        })
      ).json(),
    );
    return { sessionId: session.id, callId: started.call.id };
  }

  async function heldTurn(call: { sessionId: string; callId: string }, key: string) {
    const requestId = `speech-in-turn-held-${key}`;
    const res = await held.request(`/sessions/${call.sessionId}/turns`, {
      body: { text: 'Where do we start?', channel: 'voice', callId: call.callId, speechAudio: 'pcm' },
      cookie,
      idempotencyKey: `${requestId}-key`,
      headers: { 'x-request-id': requestId },
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    return { events, requestId };
  }

  async function heldSpeech(callId: string, requestId: string) {
    const ledger = await held.h.t.db.system((sx) =>
      sx.query("SELECT count(*)::int AS n FROM usage_ledger WHERE purpose = 'speech' AND request_id = :id", {
        id: p.text(requestId),
      }),
    );
    const plays = await held.h.t.db.system((sx) =>
      sx.query(
        `SELECT coalesce(sum(s.plays), 0)::int AS plays, (SELECT speech_characters FROM calls WHERE id = :call) AS chars
           FROM call_speech s WHERE s.call_id = :call AND s.unit LIKE 'unit.%'`,
        { call: p.uuid(callId) },
      ),
    );
    return {
      usage: ledger.rows[0]?.n as number,
      plays: plays.rows[0]?.plays as number,
      characters: Number(plays.rows[0]?.chars ?? 0),
    };
  }

  function expectWithdrawn(events: TurnStreamEvent[], terminal: 'turn.blocked' | 'turn.error') {
    const at = events.findIndex((e) => e.event === terminal);
    expect(at).toBeGreaterThan(0);
    const units = unitsOf(events.slice(0, at)).filter((u) => u.audio === true);
    expect(units.length).toBeGreaterThanOrEqual(2);
    // No PCM of the reply after its terminal event (none at all here: every synthesis was still held).
    expect(events.slice(at).filter((e) => e.event === 'turn.audio' && e.pcm !== undefined)).toEqual([]);
    // Each unit closed once, refused (the page never asks POST /speech for it).
    for (const unit of units) {
      expect(audioOf(events, unit.seq).map((f) => f.end)).toEqual(['refused']);
    }
    return units;
  }

  it('a reply blocked by the whole-reply gate: its announced units are never synthesized, billed or sent', async () => {
    const call = await heldCall();
    reply = NAMES_THE_EIR;
    const before = vendor.calls.length;
    const abortedBefore = vendor.aborted;
    const { events, requestId } = await heldTurn(call, 'blocked');
    expect(events.find((e) => e.event === 'turn.blocked')).toMatchObject({ event: 'turn.blocked' });
    expect(events.find((e) => e.event === 'turn.blocked')).not.toMatchObject({ reason: 'crisis_support' });
    const units = expectWithdrawn(events, 'turn.blocked');
    // The syntheses in flight were aborted; nothing billed, every play and character given back.
    const started = vendor.calls.length - before;
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThanOrEqual(units.length);
    expect(vendor.aborted - abortedBefore).toBe(started);
    expect(await heldSpeech(call.callId, requestId)).toEqual({ usage: 0, plays: 0, characters: 0 });
    // POST /speech refuses them as before.
    const first = units[0];
    if (first === undefined) throw new Error('no unit');
    const asked = await held.request('/speech', {
      body: {
        sessionId: call.sessionId,
        turnId: first.turnId,
        seq: first.seq,
        text: first.text,
        sig: first.sig,
      },
      cookie,
      headers: { accept: 'audio/pcm, audio/mpeg, application/problem+json' },
    });
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { detail?: string }).detail).toBe('This reply can no longer be spoken.');
  });

  it('a completed reply is voiced in full once its syntheses go ahead (the gate in each reservation holds)', async () => {
    const call = await heldCall();
    reply = 'Start with the door counts this week. Then count the seats at lunch every day.';
    vendor.release();
    try {
      const { events, requestId } = await heldTurn(call, 'completed');
      expect(events.some((e) => e.event === 'turn.completed')).toBe(true);
      const units = unitsOf(events);
      expect(units.length).toBeGreaterThan(0);
      for (const unit of units) expect(audioOf(events, unit.seq).at(-1)?.end).toBe('done');
      expect((await heldSpeech(call.callId, requestId)).usage).toBe(units.length);
    } finally {
      vendor.hold = true;
    }
  });

  it('a setting changed mid-reply (a kill switch, a voice switch, a cap) leaves its next units to POST /speech', async () => {
    const call = await heldCall();
    reply = 'Start with the door counts this week. Then count the seats at lunch every day.';
    vendor.release();
    // Signed units of a reply (asked without speechAudio: nothing voiced in its stream).
    const res = await held.request(`/sessions/${call.sessionId}/turns`, {
      body: { text: 'Where do we start?', channel: 'voice', callId: call.callId },
      cookie,
      idempotencyKey: 'speech-in-turn-held-settings-key',
    });
    const units = unitsOf(
      parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data))),
    );
    const [first, second] = units;
    if (first === undefined || second === undefined) throw new Error('expected two units');
    const ctx = await held.h.ctxFor(held.h.people.maya);
    const before = vendor.calls.length;
    try {
      // The turn's voice decided with the settings of its start.
      const voice = await held.h.core.speech.prepareTurnVoice(ctx, call);
      if (voice === null) throw new Error('expected a voice');
      const one = await voice.speak(first, {});
      expect(one.kind).toBe('audio');
      if (one.kind === 'audio') await new Response(one.audio).arrayBuffer();
      // The vendor voice switched off mid-reply: the next unit is not reserved, synthesized or billed here.
      await held.h.t.db.system((sx) =>
        sx.query(
          `INSERT INTO platform_settings (key, value) VALUES ('vendor_voice_enabled', 'false'::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          {},
        ),
      );
      expect(await voice.speak(second, { previousText: first.text })).toEqual({ kind: 'failed' });
      expect(vendor.calls.length - before).toBe(1);
      const plays = await held.h.t.db.system((sx) =>
        sx.query(
          'SELECT count(*)::int AS n FROM call_speech WHERE call_id = :call AND unit = :unit AND plays > 0',
          {
            call: p.uuid(call.callId),
            unit: p.text(`unit.${second.turnId.toLowerCase()}.${String(second.seq)}`),
          },
        ),
      );
      expect(plays.rows[0]?.n).toBe(0);
      // POST /speech decides it on the settings of the moment: Polly, not the vendor.
      const asked = await held.request('/speech', {
        body: {
          sessionId: call.sessionId,
          turnId: second.turnId,
          seq: second.seq,
          text: second.text,
          sig: second.sig,
        },
        cookie,
        headers: { accept: 'audio/pcm, audio/mpeg, application/problem+json' },
      });
      expect(asked.status).toBe(200);
      await asked.arrayBuffer();
      expect(vendor.calls.length - before).toBe(1);
    } finally {
      vendor.hold = true;
      await held.h.t.db.system((sx) =>
        sx.query(`UPDATE platform_settings SET value = 'true'::jsonb WHERE key = 'vendor_voice_enabled'`, {}),
      );
    }
  });

  // Last: the mock's scripted outcomes this leaves unused would fail a later turn.
  it('a reply that failed after its units were announced is withdrawn the same way', async () => {
    const call = await heldCall();
    reply = LONG;
    held.h.gateway.scriptStream('fail_midway');
    held.h.gateway.scriptNext('fallback', 'unavailable', 'unavailable', 'unavailable', 'unavailable');
    const { events, requestId } = await heldTurn(call, 'failed');
    expectWithdrawn(events, 'turn.error');
    expect(await heldSpeech(call.callId, requestId)).toEqual({ usage: 0, plays: 0, characters: 0 });
  });
});
