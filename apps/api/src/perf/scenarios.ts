import { buildEvidenceBlock } from '@foundry/ai';
import { StartCallResponse, SessionView, TurnStreamEvent, type TurnView } from '@foundry/contracts';
import { estimateTokens } from '@foundry/core';
import { p } from '@foundry/db';

import { type RequestOptions } from '../testing/api-harness.js';
import { QUICK_PREFIX, type LatencyRig } from './rig.js';

/**
 * What the founder's browser sees, measured at the client edge of the API (in process, so no network to the
 * browser is included), plus the server's own stage timings for the same request (its log lines).
 * Milliseconds from sending the request.
 */
export interface TurnSample {
  readonly channel: 'text' | 'voice';
  /** The request's `x-request-id` (its round trips in `LatencyRig.queries`). */
  readonly requestId: string;
  /** `performance.now()` when the request was sent (the marks below are relative to it). */
  readonly sentAt: number;
  /** Response headers (the stream opened). */
  readonly headersMs: number;
  readonly acceptedMs: number | null;
  /** First validated sentence on screen (`turn.delta`). */
  readonly firstDeltaMs: number | null;
  /** Voice: first signed spoken unit (`turn.speech`). */
  readonly firstSpeechMs: number | null;
  /** Voice: first audio bytes of that unit, fetched from `POST /speech` as soon as it arrived. */
  readonly firstAudioMs: number | null;
  /** Voice: the reply's last signed spoken unit. */
  readonly lastSpeechMs: number | null;
  /** Voice: signed spoken units of the reply. */
  readonly units: number;
  /** The terminal event (`turn.completed`). */
  readonly completedMs: number | null;
  /** The response stream ended (the API is free for the next request; work after the response excluded). */
  readonly streamEndMs: number | null;
  /** The `turn.timing` log line of the request. */
  readonly server: Readonly<Record<string, unknown>> | null;
  /** The `speech.timing` log line of the first unit's `/speech` request (voice). */
  readonly speech: Readonly<Record<string, unknown>> | null;
  /** Evidence items the reply's prompt carried. */
  readonly evidenceItems: number | null;
  /** Their `<evidence>` block, in estimated tokens (read by both of the turn's model calls). */
  readonly evidenceTokens: number | null;
  /** The reply call's whole prompt, in estimated tokens (the turn's audit, `inputTokensEstimate`). */
  readonly inputTokens: number | null;
}

/** One plain request (a page's data, a call start, the intro's speech). */
export interface RequestSample {
  readonly name: string;
  /** Response headers. */
  readonly headersMs: number;
  /** The whole body (for speech: the first audio bytes). */
  readonly bodyMs: number;
  /** The `http.request` log line of the request. */
  readonly server: Readonly<Record<string, unknown>> | null;
}

let counter = 0;
function nextRequestId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(process.pid)}-${String(counter).padStart(5, '0')}`;
}

/** The parsed log lines of `requestId` with event `event`. */
export function logLine(rig: LatencyRig, requestId: string, event: string): Record<string, unknown> | null {
  for (const line of rig.logs) {
    if (!line.includes(requestId)) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.event === event && parsed.requestId === requestId) return parsed;
  }
  return null;
}

async function timed(
  rig: LatencyRig,
  name: string,
  path: string,
  options: RequestOptions,
  readFirstChunkOnly = false,
): Promise<{ sample: RequestSample; res: Response; body: string }> {
  const requestId = nextRequestId(name);
  const started = performance.now();
  const res = await rig.request(path, {
    ...options,
    headers: { ...options.headers, 'x-request-id': requestId },
  });
  const headersMs = performance.now() - started;
  let body = '';
  if (readFirstChunkOnly && res.body) {
    const reader = res.body.getReader();
    await reader.read();
    const bodyMs = performance.now() - started;
    // Drain the rest so the request finishes (and logs) as a browser's would.
    for (;;) if ((await reader.read()).done) break;
    return {
      sample: { name, headersMs, bodyMs, server: logLine(rig, requestId, 'http.request') },
      res,
      body,
    };
  }
  body = await res.text();
  const bodyMs = performance.now() - started;
  if (res.status >= 400) throw new Error(`${name} answered ${String(res.status)}: ${body.slice(0, 200)}`);
  return { sample: { name, headersMs, bodyMs, server: logLine(rig, requestId, 'http.request') }, res, body };
}

/** Reads an SSE response as it arrives, calling `onEvent` with each event and its arrival time. */
async function readEvents(
  res: Response,
  started: number,
  onEvent: (event: TurnStreamEvent, atMs: number) => void,
): Promise<void> {
  if (!res.body) throw new Error('the turn has no stream');
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data !== '') onEvent(TurnStreamEvent.parse(JSON.parse(data)), performance.now() - started);
      cut = buffer.indexOf('\n\n');
    }
  }
}

/** A new conversation of the rig's venture. */
export async function newConversation(
  rig: LatencyRig,
  cookie: string,
): Promise<RequestSample & { id: string }> {
  const { sample, body } = await timed(rig, 'session-create', `/ventures/${rig.ventureId}/sessions`, {
    body: {},
    cookie,
  });
  return { ...sample, id: SessionView.parse(JSON.parse(body)).id };
}

const TEXT_MESSAGES = [
  'We interviewed twelve librarians this week. Which signal should we trust most?',
  'Our pilot at the north campus library starts in two weeks. What should we measure first?',
  'Two of the librarians said the sensors felt intrusive. How do we handle that?',
  'Should we price per library or per seat for the first paid pilot?',
  'What would make you confident that quiet-space demand is real?',
  'I am worried we are building too much before the pilot. What should we cut?',
  // A decision stated in the founder's own words is kept with the turn, and settled by meaning (an embedding).
  "We've decided to ask each library for a paid commitment before the pilot starts.",
];

/** One turn as the chat or call screen sends it, timed from the browser's side. */
export async function turn(
  rig: LatencyRig,
  args: {
    readonly cookie: string;
    readonly sessionId: string;
    readonly text: string;
    readonly callId?: string;
  },
): Promise<TurnSample> {
  const requestId = nextRequestId('turn');
  const voice = args.callId !== undefined;
  const started = performance.now();
  const res = await rig.request(`/sessions/${args.sessionId}/turns`, {
    body: voice ? { text: args.text, channel: 'voice', callId: args.callId } : { text: args.text },
    cookie: args.cookie,
    idempotencyKey: `${requestId}-key`,
    headers: { 'x-request-id': requestId },
  });
  const headersMs = performance.now() - started;
  if (res.status !== 200)
    throw new Error(`turn answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
  const marks = {
    accepted: null as number | null,
    firstDelta: null as number | null,
    firstSpeech: null as number | null,
    lastSpeech: null as number | null,
    completed: null as number | null,
  };
  let finished: TurnView | null = null;
  let firstAudio: Promise<{ ms: number; requestId: string } | null> = Promise.resolve(null);
  const speechFetches: Promise<unknown>[] = [];
  await readEvents(res, started, (event, at) => {
    switch (event.event) {
      case 'turn.accepted':
        marks.accepted ??= at;
        break;
      case 'turn.delta':
        marks.firstDelta ??= at;
        break;
      case 'turn.speech': {
        marks.lastSpeech = at;
        // The call screen asks for each unit's audio as soon as the unit arrives (pipelined playback).
        const speechId = nextRequestId('speech');
        const fetched = rig
          .request('/speech', {
            body: {
              sessionId: args.sessionId,
              turnId: event.turnId,
              seq: event.seq,
              text: event.text,
              sig: event.sig,
            },
            cookie: args.cookie,
            headers: { 'x-request-id': speechId },
          })
          .then(async (audio) => {
            if (audio.status !== 200 || !audio.body) return null;
            const reader = audio.body.getReader();
            await reader.read();
            const ms = performance.now() - started;
            for (;;) if ((await reader.read()).done) break;
            return { ms, requestId: speechId };
          });
        speechFetches.push(fetched);
        if (marks.firstSpeech === null) {
          marks.firstSpeech = at;
          firstAudio = fetched;
        }
        break;
      }
      case 'turn.completed':
        finished = event.turn;
        marks.completed ??= at;
        break;
      case 'turn.blocked':
      case 'turn.error':
        marks.completed ??= at;
        break;
      case 'turn.status':
        break;
    }
  });
  const streamEndMs = performance.now() - started;
  const audio = await firstAudio;
  await Promise.all(speechFetches);
  const completedTurn = finished as TurnView | null;
  const prompt = completedTurn === null ? null : await promptSize(rig, completedTurn);
  return {
    channel: voice ? 'voice' : 'text',
    requestId,
    sentAt: started,
    headersMs,
    acceptedMs: marks.accepted,
    firstDeltaMs: marks.firstDelta,
    firstSpeechMs: marks.firstSpeech,
    firstAudioMs: audio?.ms ?? null,
    lastSpeechMs: marks.lastSpeech,
    units: speechFetches.length,
    completedMs: marks.completed,
    streamEndMs,
    server: logLine(rig, requestId, 'turn.timing'),
    speech: audio === null ? null : logLine(rig, audio.requestId, 'speech.timing'),
    evidenceItems: completedTurn?.evidence.length ?? null,
    evidenceTokens: prompt?.evidenceTokens ?? null,
    inputTokens: prompt?.inputTokens ?? null,
  };
}

/** The size of a completed turn's prompt: its evidence block and the whole reply prompt (estimates). */
async function promptSize(
  rig: LatencyRig,
  turn: TurnView,
): Promise<{ evidenceTokens: number; inputTokens: number | null }> {
  const evidenceTokens = estimateTokens(buildEvidenceBlock(turn.evidence));
  const r = await rig.t.db.system((sx) =>
    sx.query("SELECT metadata FROM audit_events WHERE object_id = :id AND action = 'turn.completed'", {
      id: p.text(turn.id),
    }),
  );
  const raw: unknown = r.rows[0]?.metadata;
  const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined;
  const estimate = metadata?.inputTokensEstimate;
  return { evidenceTokens, inputTokens: typeof estimate === 'number' ? estimate : null };
}

export interface ScenarioResult {
  readonly turns: TurnSample[];
  readonly requests: RequestSample[];
}

/**
 * Starts a call in `sessionId` as the call screen does (and, on a rig with a FULL face, opens the face as the call
 * screen does once the call is live): the start request, the call, and its spoken intro if any.
 */
export async function startCall(
  rig: LatencyRig,
  cookie: string,
  sessionId: string,
): Promise<{ sample: RequestSample; started: StartCallResponse }> {
  const start = await timed(rig, 'call-start', `/sessions/${sessionId}/calls`, { body: {}, cookie });
  const started = StartCallResponse.parse(JSON.parse(start.body));
  if (rig.face) {
    await timed(rig, 'face-start', '/calls/avatar-session', {
      body: { ventureId: rig.ventureId, callId: started.call.id },
      cookie,
    });
  }
  return { sample: start.sample, started };
}

/**
 * The founder's day in miniature: sign in, open the venture and its conversations, start a conversation and
 * type `textTurns` messages, then start a call (the intro is spoken) and talk `voiceTurns` times.
 */
export async function runScenario(
  rig: LatencyRig,
  options: {
    readonly textTurns: number;
    readonly voiceTurns: number;
    /**
     * Milliseconds between one turn's end and the next turn, as a person paces a call (LAB-P2: browser call turns
     * were about ten seconds apart). Default 0: back to back.
     */
    readonly turnGapMs?: number;
  },
): Promise<ScenarioResult> {
  const turns: TurnSample[] = [];
  const requests: RequestSample[] = [];
  const cookie = await rig.signIn(rig.founderId);
  /** The pause between turns; on a call, the browser's heartbeats keep the call alive through it. */
  const gap = async (callId?: string): Promise<void> => {
    let left = options.turnGapMs ?? 0;
    while (left > 0) {
      if (callId !== undefined) {
        await rig.request(`/calls/${callId}/heartbeat`, {
          body: { state: 'listening', micOpenSeconds: 0 },
          cookie,
        });
      }
      const step = Math.min(left, 5_000);
      await new Promise((resolve) => setTimeout(resolve, step));
      left -= step;
    }
  };

  requests.push((await timed(rig, 'me', '/me', { cookie })).sample);
  requests.push((await timed(rig, 'venture', `/ventures/${rig.ventureId}`, { cookie })).sample);
  requests.push(
    (await timed(rig, 'conversations', `/ventures/${rig.ventureId}/sessions`, { cookie })).sample,
  );
  // What New chat also asks for as it opens.
  for (const [name, path] of [
    ['overview', `/ventures/${rig.ventureId}/overview`],
    ['notebook', `/ventures/${rig.ventureId}/notebook`],
    ['memory', `/ventures/${rig.ventureId}/memory`],
    ['call-config', `/ventures/${rig.ventureId}/call-config`],
  ] as const) {
    requests.push((await timed(rig, name, path, { cookie })).sample);
  }

  const typed = await newConversation(rig, cookie);
  requests.push(typed);
  for (let i = 0; i < options.textTurns; i += 1) {
    if (i > 0) await gap();
    turns.push(
      await turn(rig, {
        cookie,
        sessionId: typed.id,
        text: TEXT_MESSAGES[i % TEXT_MESSAGES.length] ?? 'Hello',
      }),
    );
  }
  requests.push((await timed(rig, 'conversation', `/sessions/${typed.id}`, { cookie })).sample);

  if (options.voiceTurns > 0) {
    const spoken = await newConversation(rig, cookie);
    requests.push(spoken);
    const start = await startCall(rig, cookie, spoken.id);
    requests.push(start.sample);
    const { started } = start;
    if (started.intro !== null) {
      const intro = await timed(
        rig,
        'call-intro-speech',
        '/speech',
        {
          body: {
            sessionId: spoken.id,
            turnId: null,
            seq: 0,
            text: started.intro.text,
            sig: started.intro.sig,
          },
          cookie,
        },
        true,
      );
      requests.push(intro.sample);
    }
    for (let i = 0; i < options.voiceTurns; i += 1) {
      await gap(started.call.id);
      turns.push(
        await turn(rig, {
          cookie,
          sessionId: spoken.id,
          callId: started.call.id,
          // Every other spoken message is a quick question with a one-sentence reply.
          text: `${i % 2 === 1 ? `${QUICK_PREFIX} ` : ''}${TEXT_MESSAGES[(i + 3) % TEXT_MESSAGES.length] ?? 'Hello'}`,
        }),
      );
    }
    const ended = await timed(rig, 'call-end', `/calls/${started.call.id}/end`, {
      body: { reason: 'user' },
      cookie,
    });
    requests.push(ended.sample);
  }
  return { turns, requests };
}
