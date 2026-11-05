/**
 * The platform's stock voice at a vendor (an "AI voice": infra `media.voice.provider: elevenlabs-stock`), through the
 * core speech service with fake vendors behind the `VoiceProvider` and `SpeechSynthesizer` ports:
 *
 * - every validated unit of a call (the intro, signed units, passages of a stored reply) is said by the stock voice,
 *   in its spoken form (numbers, symbols and addresses written out), with the verified neighbouring units as prosody
 *   context (never a neighbour whose signature fails);
 * - raw 24 kHz PCM when the page plays PCM as it arrives, MP3 otherwise;
 * - metered per character at the vendor's price, audited by its stock id, disclosed as "AI voice" in the call config;
 * - a vendor failure before the first audio is said by Amazon Polly in the same response and reservation (one ledger
 *   row, the Polly one; never both), and the vendor rests for 60 s; a stream that breaks after its first audio ends
 *   the unit there and rests the vendor too;
 * - the crisis line is never the vendor's;
 * - the platform setting `vendor_voice_enabled` (migration 0025) switches it off at runtime: Polly says the next unit,
 *   the call config stops naming it, and nothing is asked of the vendor; on again, the vendor says the next unit.
 */
import { CallConfigResponse, StartCallResponse, TurnStreamEvent } from '@foundry/contracts';
import { p, settingsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformKeyCache } from '../auth/keys.js';
import { type RequestContext } from '../context.js';
import { type Core } from '../core.js';
import { resolveDeps } from '../deps.js';
import { Kit } from '../internal/kit.js';
import { signSpeechUnit } from '../orchestrator/speech-units.js';
import { type SynthesizedSpeech } from '../ports.js';
import { FakeSpeechSynthesizer, FakeVoiceProvider, ManualClock } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { CLONE_REST_MS, chooseVoice } from './speech.js';
import { STOCK_VOICE_LABEL } from './veir.js';

const STOCK_ID = 'OZ0L6eISlOejga3XjDFt';
let h: CoreHarness;
let keys: PlatformKeyCache;
let core: Core;
const clock = new ManualClock();
const polly = new FakeSpeechSynthesizer();
const eleven = new FakeVoiceProvider('elevenlabs', 0.04);
let maya: RequestContext;

const quietquad = (): string => h.ventures.quietquad.id;

async function startCall() {
  const sessionId = (await core.sessions.create(maya, quietquad(), {})).id;
  const started = StartCallResponse.parse(
    await core.calls.start(maya, sessionId, { inputMode: 'typed', replace: true }),
  );
  return { sessionId, started };
}

/** Speech as the route serves it: the audio read to its end (when its bookkeeping is done). */
async function speak(input: Parameters<Core['speech']['synthesize']>[1], pcm = false) {
  const spoken: SynthesizedSpeech = await core.speech.synthesize(maya, input, { pcm });
  return { ...spoken, bytes: new Uint8Array(await new Response(spoken.audio).arrayBuffer()) };
}

async function usage(modelPrefix: string): Promise<{ n: number; units: number; cost: number }> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT count(*)::int AS n, coalesce(sum(input_tokens), 0)::int AS units,
              coalesce(sum(cost_usd), 0)::float8 AS cost
         FROM usage_ledger WHERE model_id LIKE :m AND purpose = 'speech'`,
      { m: p.text(`${modelPrefix}%`) },
    ),
  );
  return { n: Number(r.rows[0]?.n), units: Number(r.rows[0]?.units), cost: Number(r.rows[0]?.cost) };
}

async function lastAudit(action: string): Promise<Record<string, unknown>> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT metadata::text AS metadata FROM audit_events WHERE action = :action ORDER BY id DESC LIMIT 1`,
      { action: p.text(action) },
    ),
  );
  const metadata = rows.rows[0]?.metadata;
  return JSON.parse(typeof metadata === 'string' ? metadata : '{}') as Record<string, unknown>;
}

/** A turn of the call (the real turn engine) and units of it signed with the platform key, words of our choosing. */
async function signedTurn(sessionId: string, callId: string, texts: readonly string[]) {
  const seen: string[] = [];
  await core.orchestrator.runTurn(
    maya,
    sessionId,
    { text: 'What should I test first?', channel: 'voice', callId },
    (e) => {
      const event = TurnStreamEvent.parse(e);
      if (event.event === 'turn.speech') seen.push(event.turnId);
    },
  );
  const id = seen[0];
  if (id === undefined) throw new Error('the turn spoke no unit');
  const key = await keys.signingKey();
  return texts.map((text, i) => ({
    turnId: id,
    seq: 100 + i,
    text,
    sig: signSpeechUnit(key, { sessionId, turnId: id, seq: 100 + i, text }),
  }));
}

beforeAll(async () => {
  clock.set(new Date());
  h = await createCoreHarness({ speech: polly, clock });
  core = h.withPorts({ speech: polly, stockVoice: { provider: eleven, voiceRef: STOCK_ID } });
  keys = new PlatformKeyCache(
    new Kit(
      resolveDeps({
        db: h.t.db,
        gateway: h.gateway,
        config: h.config,
        objectStore: h.objectStore,
        jobQueue: h.jobQueue,
      }),
    ),
    3600,
  );
  maya = await h.ctxFor(h.people.maya);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('the stock vendor voice (an "AI voice")', () => {
  it('is disclosed as an AI voice in the call config, and warmed when a call starts', async () => {
    const config = CallConfigResponse.parse(await core.veir.callConfig(maya, quietquad()));
    expect(config.voice).toEqual({ vendor: 'elevenlabs', label: 'AI voice' });
    expect(STOCK_VOICE_LABEL).toBe('AI voice');
    // Without a stock voice the field is absent (Polly).
    const plain = CallConfigResponse.parse(await h.core.veir.callConfig(maya, quietquad()));
    expect(plain.voice).toBeUndefined();
    const before = eleven.prewarms;
    await startCall();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(eleven.prewarms).toBeGreaterThan(before);
  });

  it('says the intro in the stock voice, as PCM for a streaming page and MP3 otherwise, metered at its price', async () => {
    const { sessionId, started } = await startCall();
    const intro = started.intro;
    if (intro === null) throw new Error('expected an intro');
    const pollyCalls = polly.calls.length;
    const before = await usage('elevenlabs:');
    const pcm = await speak({ sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig }, true);
    expect(pcm).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 24_000, engine: 'vendor' });
    expect(eleven.calls.at(-1)).toMatchObject({ voiceRef: STOCK_ID, format: 'pcm_24000' });
    expect(eleven.calls.at(-1)?.unit).toMatchObject({ sig: intro.sig, seq: 0, turnId: null });
    expect(polly.calls.length).toBe(pollyCalls);
    const after = await usage('elevenlabs:');
    expect(after.n).toBe(before.n + 1);
    expect(after.cost - before.cost).toBeCloseTo(((after.units - before.units) / 1000) * 0.04, 8);
    expect(await lastAudit('speech.synthesized')).toMatchObject({
      voiceId: `elevenlabs:stock:${STOCK_ID}`,
      engine: 'vendor',
    });
    const timing = h.logger.records.findLast((r) => r.event === 'speech.timing');
    expect(timing?.fields).toMatchObject({ voice: 'vendor', fallback: false, pcm: true });

    // A second call: an older page (no PCM) gets MP3.
    const other = await startCall();
    const otherIntro = other.started.intro;
    if (otherIntro === null) throw new Error('expected an intro');
    const mp3 = await speak({
      sessionId: other.sessionId,
      turnId: null,
      seq: 0,
      text: otherIntro.text,
      sig: otherIntro.sig,
    });
    expect(mp3.contentType).toBe('audio/mpeg');
    expect(eleven.calls.at(-1)?.format).toBe('mp3');
  });

  it('hands the vendor the spoken form, with only verified neighbours as context', async () => {
    const { sessionId, started } = await startCall();
    const units = await signedTurn(sessionId, started.call.id, [
      'Revenue grew 25% to $1.5M.',
      'See https://example.com/plan for the **numbers**.',
      'Then talk to 3-5 clinics.',
    ]);
    const [first, middle, last] = units;
    if (first === undefined || middle === undefined || last === undefined) throw new Error('units');
    await speak({
      sessionId,
      ...middle,
      context: {
        previous: { seq: first.seq, text: first.text, sig: first.sig },
        next: { seq: last.seq, text: last.text, sig: last.sig },
      },
    });
    const asked = eleven.calls.at(-1);
    expect(asked?.text).toBe('See the link on screen for the numbers.');
    expect(asked?.previousText).toBe('Revenue grew twenty-five percent to one point five million dollars.');
    expect(asked?.nextText).toBe('Then talk to three to five clinics.');
    // Never the address, never the Markdown, in what the vendor is handed to say or as context.
    expect(JSON.stringify([asked?.text, asked?.previousText, asked?.nextText])).not.toMatch(
      /example\.com|\*\*/,
    );

    // A neighbour whose signature does not verify (or is not adjacent) is left out; the unit is still said.
    await speak({
      sessionId,
      ...last,
      context: {
        previous: { seq: middle.seq, text: 'Something else entirely.', sig: middle.sig },
        next: { seq: last.seq + 2, text: first.text, sig: first.sig },
      },
    });
    expect(eleven.calls.at(-1)?.text).toBe('Then talk to three to five clinics.');
    expect(eleven.calls.at(-1)?.previousText).toBeUndefined();
    expect(eleven.calls.at(-1)?.nextText).toBeUndefined();
  });

  it('falls back to Polly for a failed unit in the same response, once, and rests the vendor for 60 s', async () => {
    const { sessionId, started } = await startCall();
    const [a, b, c] = await signedTurn(sessionId, started.call.id, [
      'First sentence here.',
      'Second sentence here.',
      'Third sentence here.',
    ]);
    if (a === undefined || b === undefined || c === undefined) throw new Error('units');
    const elevenBefore = await usage('elevenlabs:');
    const pollyBefore = await usage('polly:');
    const vendorCalls = eleven.calls.length;
    eleven.failNext = true;
    const saved = await speak({ sessionId, ...a }, true);
    // The vendor was asked once, Polly said the same words in the same response (16 kHz PCM for the streaming page).
    expect(eleven.calls.length).toBe(vendorCalls + 1);
    expect(polly.calls.at(-1)).toMatchObject({ text: 'First sentence here.', format: 'pcm_16000' });
    expect(saved).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 16_000 });
    expect(saved.bytes.byteLength).toBeGreaterThan(0);
    expect((await usage('elevenlabs:')).n).toBe(elevenBefore.n);
    expect((await usage('polly:')).n).toBe(pollyBefore.n + 1);
    expect(await lastAudit('speech.synthesized')).toMatchObject({ fallback: true });
    expect(h.logger.records.some((r) => r.event === 'speech.vendor_failed')).toBe(true);
    // The unit was played once: asking again is refused like any replay.
    await expect(speak({ sessionId, ...a }, true)).rejects.toMatchObject({ reason: 'speech_already_played' });

    // Resting: the next unit goes straight to Polly without asking the vendor.
    await speak({ sessionId, ...b }, true);
    expect(eleven.calls.length).toBe(vendorCalls + 1);
    // After the rest, the vendor again.
    clock.advance(CLONE_REST_MS + 1_000);
    await speak({ sessionId, ...c }, true);
    expect(eleven.calls.length).toBe(vendorCalls + 2);
    expect(eleven.calls.at(-1)?.text).toBe('Third sentence here.');
  });

  it('ends a unit whose vendor stream breaks after its first audio, and rests the vendor', async () => {
    const { sessionId, started } = await startCall();
    const [a, b] = await signedTurn(sessionId, started.call.id, ['A unit that breaks.', 'The next unit.']);
    if (a === undefined || b === undefined) throw new Error('units');
    eleven.breakAfterFirstChunk = true;
    const speech = await core.speech.synthesize(maya, { sessionId, ...a }, { pcm: true });
    const reader = speech.audio.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.read()).rejects.toThrow('voice vendor stream broke');
    expect(h.logger.records.some((r) => r.event === 'speech.vendor_stream_failed')).toBe(true);
    const vendorCalls = eleven.calls.length;
    await speak({ sessionId, ...b }, true);
    expect(eleven.calls.length).toBe(vendorCalls);
    clock.advance(CLONE_REST_MS + 1_000);
  });

  it('says a passage of a stored reply in the stock voice too (it is no one’s likeness)', async () => {
    const { sessionId, started } = await startCall();
    const done: { turnId: string; spoken: string }[] = [];
    await core.orchestrator.runTurn(
      maya,
      sessionId,
      { text: 'Who should I talk to first?', channel: 'voice', callId: started.call.id },
      (e) => {
        const event = TurnStreamEvent.parse(e);
        if (event.event === 'turn.completed') {
          done.push({ turnId: event.turn.id, spoken: event.turn.response?.spoken ?? '' });
        }
      },
    );
    const completed = done[0];
    if (completed === undefined || completed.spoken === '') throw new Error('no completed spoken turn');
    const { turnId, spoken } = completed;
    const calls = eleven.calls.length;
    await speak({ sessionId, turnId, text: spoken });
    expect(eleven.calls.length).toBe(calls + 1);
    expect(eleven.calls.at(-1)?.unit).toBeNull();
  });

  it('is switched off and on at runtime by vendor_voice_enabled, with no deploy', async () => {
    const setVendorVoice = (vendorVoiceEnabled: boolean) =>
      h.t.db.system((sx) => settingsRepo.updatePlatformSettings(sx, { vendorVoiceEnabled }, h.people.owner));
    expect((await h.t.db.system((sx) => settingsRepo.getPlatformSettings(sx))).vendorVoiceEnabled).toBe(true);
    const { sessionId, started } = await startCall();
    const [a] = await signedTurn(sessionId, started.call.id, ['Said by Polly now.']);
    if (a === undefined) throw new Error('unit');
    await setVendorVoice(false);
    try {
      const vendorCalls = eleven.calls.length;
      const pollyCalls = polly.calls.length;
      const off = await speak({ sessionId, ...a }, true);
      expect(eleven.calls.length).toBe(vendorCalls);
      expect(polly.calls.length).toBe(pollyCalls + 1);
      expect(off).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 16_000 });
      expect(await lastAudit('speech.synthesized')).not.toMatchObject({ engine: 'vendor' });
      // The call config no longer names an AI vendor voice, and a new call does not warm it.
      expect(CallConfigResponse.parse(await core.veir.callConfig(maya, quietquad())).voice).toBeUndefined();
      const prewarms = eleven.prewarms;
      await startCall();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(eleven.prewarms).toBe(prewarms);
    } finally {
      await setVendorVoice(true);
    }
    // On again: the next unit is the vendor's.
    const again = await startCall();
    const [c] = await signedTurn(again.sessionId, again.started.call.id, ['Said by the vendor again.']);
    if (c === undefined) throw new Error('unit');
    const vendorCalls = eleven.calls.length;
    await speak({ sessionId: again.sessionId, ...c }, true);
    expect(eleven.calls.length).toBe(vendorCalls + 1);
    expect(CallConfigResponse.parse(await core.veir.callConfig(maya, quietquad())).voice).toEqual({
      vendor: 'elevenlabs',
      label: 'AI voice',
    });
  });

  it('never gives the crisis line or a clone’s place to the stock voice', () => {
    const base = {
      call: { voiceId: 'Danielle', voiceVendor: 'polly' as const },
      persona: { kind: 'neutral_guide' as const, embodiment: { voiceId: null } } as never,
      assets: [],
      clonedVoiceEnabled: true,
      provider: eleven,
      twinVoice: null,
      verified: true,
      stockVoice: { provider: eleven, voiceRef: STOCK_ID },
    };
    expect(chooseVoice({ ...base, crisis: true })).toEqual({ kind: 'polly', voiceId: 'Danielle' });
    expect(chooseVoice({ ...base, crisis: false })).toMatchObject({ kind: 'vendor', ref: STOCK_ID });
    // The EIR's clone still wins where it applies.
    expect(
      chooseVoice({
        ...base,
        crisis: false,
        call: { voiceId: 'Danielle', voiceVendor: 'elevenlabs' },
        twinVoice: { ref: 'VoiceClone01' },
      }),
    ).toMatchObject({ kind: 'clone', ref: 'VoiceClone01' });
    expect(chooseVoice({ ...base, crisis: false, stockVoice: undefined })).toMatchObject({ kind: 'polly' });
  });
});
