import { join } from 'node:path';

import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import type * as LiveKit from 'livekit-client';

import { FOUNDER_STATE, OWNER_STATE, setFacesEnabled, test } from '../support/fixtures';
import {
  REPO,
  WRITE_HEADERS,
  acknowledgeNotices,
  appWithinBudget,
  callScreen,
  callStartup,
  errorName,
  hangUp,
  startCall,
  typeOnCall,
  writePrivate,
} from './lab-support';
import { faceLabInit, type FaceLab, type LabEvent, type LabFetch } from './face-lab-page';
import { pageScript } from './page-script';

/*
 * Face suite of the conversation lab (docs/runbooks/conversation-lab.md, plan E "sandbox" checks): the HeyGen
 * LiveAvatar FULL stock face against the vendor's free SANDBOX (the Wayne avatar, sessions of about a minute, no
 * credits), headless and silent (`--disable-audio-output`). The local API holds the vendor key (the lab passes it
 * to that process only); this spec never sees it.
 *
 *   probe      raw sandbox rooms opened through the dev server's lab probe (LAB_FACE_PROBE_TOKEN): this page joins
 *              them with livekit-client and commands the avatar itself, to measure what the vendor does with
 *              `avatar.speak_text` (exact words, queue or cut, timing), `avatar.interrupt`, `avatar.speak_response`
 *              in restricted mode, which tokens may publish, the transcript endpoint, and how sessions end.
 *   call       a real call as the seeded founder, a platform admin of the synthetic venture: the stock face opens
 *              labelled "AI avatar", says the vEIR's admitted units, never asks for the microphone, and the call
 *              falls back to the presence when the sandbox session ends.
 *   injection  a tampered page rewrites the words of one `avatar.speak_text` after the server admitted them: the
 *              server's transcript check must end the face within a heartbeat (`call.face_injection`).
 *   warm-up    one turn on a call without a face, not measured, before any measured arm (in every pass, the LITE pass's
 *              restarted API too): the first turn an API process serves pays the turn engine's first-run cost (lab run
 *              41235680528: ~0.5 s before the model started on the run's first turn, ~0.05 s on the next ones), which
 *              would otherwise land on whichever arm runs first and make the arms incomparable.
 *   polly      the same typed turn on a call without a face (Amazon Polly only): the A/B arm for first audio.
 *   call LITE  the same call arm with the app's face as a LITE stock face the page feeds (the sandbox's Wayne,
 *              lip-syncing the call's own ElevenLabs PCM: the page holds the avatar's speak channel, ws_url, and
 *              forwards each admitted unit as its PCM arrives, one utterance per turn), for the FULL / LITE /
 *              voice-only comparison, plus a barge-in turn. The lab restarts the API in LITE for it
 *              (LAB_FACE_APP_MODE=lite, MEDIA_FACE_LITE_ROUTE=browser) after the FULL pass, or runs only LITE (then the
 *              FULL-only tests skip). The page's own WebSocket frames on that channel are tapped (types, ids, sizes).
 *
 * Every page records the vendor's room events by tapping the page's own WebRTC data channels (the JSON inside each
 * packet), the avatar's audio level, microphone requests and fetches, with the page clock. Words and texts go to
 * the private folder (sealed); ops/lab conversation_lab/face.py turns the files into public numbers.
 */

const PROBE_TOKEN = process.env.LAB_FACE_PROBE_TOKEN ?? '';
/** `heygen` (the vendor sandbox, the lab on GitHub) or `stand-in` (the mock dry run: the development face). */
const FACE = process.env.LAB_FACE_VENDOR === 'heygen' ? 'heygen' : 'stand-in';
const API = process.env.E2E_API_URL ?? 'http://localhost:8787';
/** The app's face mode in this pass (the lab sets MEDIA_FACE_MODE on the API to match): `full` or `lite`. */
const APP_MODE = process.env.LAB_FACE_APP_MODE === 'lite' ? 'lite' : 'full';
const LIVEKIT_UMD = join(
  REPO,
  'apps',
  'web',
  'node_modules',
  'livekit-client',
  'dist',
  'livekit-client.umd.js',
);
const HEARTBEAT_SECONDS = 15;
/** How long a turn waits for the first sound: the vendor, or the stand-in (which makes none) in a dry run. */
const FIRST_SOUND_MS = FACE === 'heygen' ? 45_000 : 8_000;

/** The warm-up turn's line (synthetic): never measured. */
const WARM_UP_LINE = 'Quick check before we start: can you hear me?';
/** Founder lines (synthetic): one per measured turn. */
const LINES = [
  'What is the one thing I should test first with the clinic pilot?',
  'How would I know in two weeks whether that test worked?',
];
/** The LITE arm's barge-in turn (synthetic): its reply is cut off once the avatar started saying it. */
const BARGE_IN_LINE = 'Can you walk me through the whole plan for the next month, step by step?';
/** Words the probe asks the avatar to say (synthetic). */
const PROBE_TEXT = {
  exact: 'This is the first lab check, said exactly as written.',
  queue: ['First of three.', 'Second of three.', 'Third of three.'],
  long:
    'This is a long sentence for the interrupt check, and it keeps going for a while so that there is ' +
    'plenty of time to cut it off part of the way through, well before its natural end arrives.',
  queued: 'If you hear this, the interrupt did not clear the queue.',
  response: 'What is your name, and what do you do?',
};

// ---- page instruments (face-lab-page.ts) ---------------------------------------------------------------------

/**
 * Whether the page's remote audio and video arrived in one remote stream: true when an audio and a video track share
 * a stream id, false when both kinds came but never together, null when one kind is missing (nothing to compare).
 */
function sameStream(tracks: readonly { kind: string; stream: string | null }[]): boolean | null {
  const ids = (kind: string) =>
    new Set(tracks.filter((t) => t.kind === kind && t.stream !== null).map((t) => t.stream));
  const audio = ids('audio');
  const video = ids('video');
  if (audio.size === 0 || video.size === 0) return null;
  return [...audio].some((id) => video.has(id));
}

function readLab(page: Page): Promise<FaceLab> {
  return page.evaluate(() => (window as unknown as { __faceLab: FaceLab }).__faceLab);
}

function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

const inEvents = (lab: FaceLab, type: string, after = 0): LabEvent[] =>
  lab.events.filter((e) => e.dir === 'in' && e.type === type && e.at >= after);
const outEvents = (lab: FaceLab, type: string, after = 0): LabEvent[] =>
  lab.events.filter((e) => e.dir === 'out' && e.type === type && e.at >= after);
const firstAfter = (times: readonly number[], after: number): number | null =>
  times.find((t) => t >= after) ?? null;
const ms = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : Math.round(to - from);

/** Normalised words (case, punctuation and spacing aside) for comparing what was sent with what was said. */
function words(text: string | null): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The LITE speak-channel frames the page sent / got of `type` (at or after `after`). */
const liteOut = (lab: FaceLab, type: string, after = 0) =>
  lab.lite.out.filter((f) => f.type === type && f.at >= after);
const liteIn = (lab: FaceLab, type: string, after = 0) =>
  lab.lite.in.filter((f) => f.type === type && f.at >= after);

/** Whether an utterance the page opened on its speak channel is still being said (started, not ended or cut). */
function liteSpeaking(lab: FaceLab): boolean {
  const over = new Set(
    lab.lite.in
      .filter((f) => f.type === 'agent.speak_ended' || f.type === 'agent.speak_interrupted')
      .map((f) => f.source),
  );
  const opened = new Set(liteOut(lab, 'agent.speak').map((f) => f.id));
  return [...opened].some((id) => !over.has(id));
}

/** The LITE face hand-overs the page POSTed (`/calls/:id/face/speak`), each a part of a unit's audio. */
const speakPosts = (lab: FaceLab, after = 0): LabFetch[] =>
  lab.fetches.filter((f) => f.method === 'POST' && f.path.endsWith('/face/speak') && f.at >= after);

/**
 * Waits (polling the page) until the face said everything it started and has been quiet for `quietMs`. A LITE face
 * (`pairedEvents: false`) need not pair its room events (the vendor's LITE events reach the server's socket; the room
 * may carry some or none): its quiet is no sound on the face's track or the app's output (no onset without its
 * offset) and no hand-over still waiting for the server.
 */
async function waitForFaceQuiet(
  page: Page,
  { quietMs = 1200, timeoutMs = 30_000, pairedEvents = true } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lab = await readLab(page);
    const t = await pageNow(page);
    const started = inEvents(lab, 'avatar.speak_started').length;
    const ended = inEvents(lab, 'avatar.speak_ended').length;
    const last = Math.max(
      0,
      ...lab.events.map((e) => e.at),
      ...lab.plays,
      ...lab.appOnsets,
      ...lab.appOffsets,
      ...(pairedEvents ? [] : [...lab.onsets, ...lab.offsets]),
    );
    const busy = pairedEvents
      ? started > ended
      : lab.onsets.length > lab.offsets.length ||
        lab.appOnsets.length > lab.appOffsets.length ||
        speakPosts(lab).some((f) => f.doneAt === null) ||
        liteSpeaking(lab);
    if (!busy && t - last > quietMs) return;
    await page.waitForTimeout(200);
  }
}

// ---- the vendor probe -------------------------------------------------------------------------------------

/**
 * A blank page on the local API's origin (a secure context: localhost), served by the test itself (the API's own
 * responses forbid scripts), with the instruments and livekit-client loaded.
 */
async function openBlankPage(page: Page): Promise<void> {
  const blank = `${API}/__lab/face-probe`;
  await page.route(blank, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>lab</title><body></body>',
    }),
  );
  await page.goto(blank);
  await page.addScriptTag({ path: LIVEKIT_UMD });
}

async function probeApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: { 'x-lab-probe-token': PROBE_TOKEN },
  });
}

interface ProbeSession {
  sessionId: string;
  url: string;
  token: string;
}

async function openProbeSession(
  api: APIRequestContext,
  mode: 'full' | 'lite',
  maxSeconds: number,
): Promise<ProbeSession> {
  const response = await api.post('/api/v1/_lab/face/sessions', { data: { mode, maxSeconds } });
  expect(response.status(), `probe session (${mode})`).toBe(201);
  return (await response.json()) as ProbeSession;
}

async function stopProbeSession(api: APIRequestContext, session: ProbeSession): Promise<void> {
  await api.post(`/api/v1/_lab/face/sessions/${session.sessionId}/stop`).catch(() => undefined);
}

interface ProbeRoom {
  connectedMs: number | null;
  firstVideoMs: number | null;
  canPublishData: boolean | null;
  error: string | null;
}

/** Joins a probe session's room from the probe page with livekit-client (receive only; data commands). */
async function joinProbeRoom(page: Page, session: ProbeSession): Promise<ProbeRoom> {
  return page.evaluate(
    async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
      const w = window as unknown as {
        __probeRoom?: LiveKit.Room;
      };
      const now = (): number => performance.timeOrigin + performance.now();
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      w.__probeRoom = room;
      const begun = now();
      const seen: { firstVideo: number | null } = { firstVideo: null };
      const video = new Promise<void>((resolve) => {
        room.on(LK.RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === LK.Track.Kind.Video && seen.firstVideo === null) {
            seen.firstVideo = now();
            resolve();
          }
        });
      });
      try {
        await room.connect(url, token, { autoSubscribe: true });
        const connected = now();
        await Promise.race([video, new Promise((resolve) => setTimeout(resolve, 15_000))]);
        const permissions = room.localParticipant.permissions;
        return {
          connectedMs: Math.round(connected - begun),
          firstVideoMs: seen.firstVideo === null ? null : Math.round(seen.firstVideo - begun),
          canPublishData: permissions === undefined ? null : permissions.canPublishData,
          error: null,
        };
      } catch (err) {
        return {
          connectedMs: null,
          firstVideoMs: null,
          canPublishData: null,
          error: err instanceof Error ? err.name : 'error',
        };
      }
    },
    { url: session.url, token: session.token },
  );
}

/** Sends one command to the avatar from the probe page; returns the page time it went out. */
function command(page: Page, eventType: string, text?: string): Promise<number> {
  return page.evaluate(
    async ({ eventType, text }) => {
      const room = (window as unknown as { __probeRoom: LiveKit.Room }).__probeRoom;
      const payload = new TextEncoder().encode(
        JSON.stringify({ event_id: crypto.randomUUID(), event_type: eventType, ...(text ? { text } : {}) }),
      );
      const at = performance.timeOrigin + performance.now();
      await room.localParticipant.publishData(payload, { reliable: true, topic: 'agent-control' });
      return at;
    },
    { eventType, text: text ?? '' },
  );
}

async function leaveProbeRoom(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const w = window as unknown as { __probeRoom?: LiveKit.Room };
      await w.__probeRoom?.disconnect();
      w.__probeRoom = undefined;
    })
    .catch(() => undefined);
}

/** Polls the page until `done(lab)` or `timeoutMs`; returns whether it held. */
async function until(page: Page, done: (lab: FaceLab) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(await readLab(page))) return true;
    await page.waitForTimeout(100);
  }
  return done(await readLab(page));
}

// ---- the app's call ---------------------------------------------------------------------------------------

async function ownerApi(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, storageState: OWNER_STATE });
}

/** The ids of the audit events with `action` (newest first; null when the listing failed). */
async function auditIds(baseURL: string, action: string): Promise<number[] | null> {
  const owner = await ownerApi(baseURL);
  try {
    const response = await owner.get(`/api/v1/admin/audit?action=${encodeURIComponent(action)}&limit=200`);
    if (response.status() !== 200) return null;
    return ((await response.json()) as { items: { id: number }[] }).items.map((item) => item.id);
  } finally {
    await owner.dispose();
  }
}

async function faceSettings(baseURL: string, on: boolean): Promise<void> {
  const owner = await ownerApi(baseURL);
  try {
    const response = await owner.patch('/api/v1/admin/settings', {
      headers: WRITE_HEADERS,
      data: on
        ? { facesEnabled: true, faceMinutesPerCall: 5, faceMinutesPerPrincipalMonth: 120 }
        : { facesEnabled: false },
    });
    expect(response.status(), 'PATCH /admin/settings').toBe(200);
  } finally {
    await owner.dispose();
  }
}

interface FaceSessionSeen {
  /** The avatar-session response's HTTP status (a refused one is recorded too). */
  status: number;
  provider: string | null;
  voicing: string | null;
  stockFace: boolean | null;
  livekitHost: string | null;
  /** Whether the page was handed a room token and a LITE speak channel (presence only: never the values). */
  token: boolean | null;
  controlUrl: boolean | null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function watchAvatarSession(page: Page): FaceSessionSeen[] {
  const seen: FaceSessionSeen[] = [];
  page.on('response', (response) => {
    if (!response.url().endsWith('/api/v1/calls/avatar-session')) return;
    const status = response.status();
    if (!response.ok()) {
      seen.push({
        status,
        provider: null,
        voicing: null,
        stockFace: null,
        livekitHost: null,
        token: null,
        controlUrl: null,
      });
      return;
    }
    void response
      .json()
      .then(
        (body: {
          provider?: string;
          voicing?: string;
          stockFace?: boolean;
          url?: string | null;
          token?: string | null;
          controlUrl?: string | null;
        }) => {
          seen.push({
            status,
            provider: body.provider ?? null,
            voicing: body.voicing ?? null,
            stockFace: body.stockFace ?? null,
            livekitHost: hostOf(body.url ?? null),
            token: typeof body.token === 'string' && body.token !== '',
            controlUrl: typeof body.controlUrl === 'string' && body.controlUrl !== '',
          });
        },
      )
      .catch(() => undefined);
  });
  return seen;
}

const videoTile = (page: Page) => callScreen(page).locator('[data-slot="call-tile"][data-face="video"]');
const presenceTile = (page: Page) =>
  callScreen(page).locator('[data-slot="call-tile"][data-face="presence"]');
/** A video call whose face cannot come back (the server stopped it, or no session is offered now). */
const unavailableTile = (page: Page) =>
  callScreen(page).locator('[data-slot="call-tile"][data-face="video-unavailable"]');
/** A video call replacing its face with a new session (the vendor ended the last one). */
const reconnectingTile = (page: Page) =>
  callScreen(page).locator('[data-slot="call-tile"][data-face="video-reconnecting"]');

/** Each turn: page time sent, first face speak_started / audio onset / app playback after it, and the units said. */
interface TurnTiming {
  sentAt: number;
  /**
   * The turn request's id, which the server's `turn.timing` line carries: the lab reads the server's model start and
   * first spoken unit per arm from it (ops/lab face.py server_turns). An id, never a word of the turn.
   */
  requestId: string | null;
  firstSpeakStartedMs: number | null;
  firstFaceAudioMs: number | null;
  /** When the app scheduled its first buffer (before any sound): kept apart from the sound itself. */
  firstAppPlaybackMs: number | null;
  /** The first sound on the app's output, by the same meter as {@link firstFaceAudioMs}. */
  firstAppAudioMs: number | null;
  /** The turn's first hand-over to the face: FULL's `avatar.speak_text` on the room, LITE's `face/speak` POST. */
  firstHandOverMs: number | null;
  /** When the server answered that LITE hand-over (it relayed the audio over the speak socket); null in FULL. */
  firstHandOverDoneMs: number | null;
  /** The turn's first spoken unit (`turn.speech`) reaching the page. */
  firstUnitMs: number | null;
  /**
   * From that unit's arrival to the turn's first hand-over to the face. With FULL face pre-approval the unit is
   * already admitted, so the page hands it over at once: this is the round trip `face/say` used to add.
   */
  unitToHandOverMs: number | null;
}

async function measuredTurn(
  page: Page,
  line: string,
  { pairedEvents = true }: { pairedEvents?: boolean } = {},
): Promise<TurnTiming> {
  const before = await pageNow(page);
  await typeOnCall(page, line);
  // The turn request the call sent (page clock), else when the line was typed.
  let sentAt = before;
  await until(
    page,
    (lab) => lab.fetches.some((f) => f.method === 'POST' && f.path.endsWith('/turns') && f.at >= before),
    5_000,
  );
  const lab0 = await readLab(page);
  const sent = lab0.fetches.find((f) => f.method === 'POST' && f.path.endsWith('/turns') && f.at >= before);
  sentAt = sent?.at ?? before;
  await until(
    page,
    (lab) =>
      inEvents(lab, 'avatar.speak_started', sentAt).length > 0 ||
      firstAfter(lab.plays, sentAt) !== null ||
      firstAfter(lab.appOnsets, sentAt) !== null,
    FIRST_SOUND_MS,
  );
  await waitForFaceQuiet(page, { timeoutMs: 40_000, pairedEvents });
  const lab = await readLab(page);
  // FULL hands the face words on the room, LITE audio to the server: a call only ever does one of the two.
  const speakText = outEvents(lab, 'avatar.speak_text', sentAt)[0]?.at ?? null;
  const speakPost = speakPosts(lab, sentAt)[0] ?? null;
  // A LITE stock face the page feeds: its first chunk on the page's own speak channel.
  const liteChunk = liteOut(lab, 'agent.speak', sentAt)[0]?.at ?? null;
  const firstUnit = lab.units.find((u) => u.at >= sentAt)?.at ?? null;
  const handOver = speakText ?? speakPost?.at ?? liteChunk;
  const speakStarted =
    inEvents(lab, 'avatar.speak_started', sentAt)[0]?.at ??
    liteIn(lab, 'agent.speak_started', sentAt)[0]?.at ??
    null;
  return {
    sentAt,
    // Read again now: a response header can fill it in after the request went out.
    requestId: lab.fetches.find((f) => f.path === sent?.path && f.at === sent.at)?.requestId ?? null,
    firstSpeakStartedMs: ms(sentAt, speakStarted),
    firstFaceAudioMs: ms(sentAt, firstAfter(lab.onsets, sentAt)),
    firstAppPlaybackMs: ms(sentAt, firstAfter(lab.plays, sentAt)),
    firstAppAudioMs: ms(sentAt, firstAfter(lab.appOnsets, sentAt)),
    firstHandOverMs: ms(sentAt, handOver),
    firstHandOverDoneMs: ms(sentAt, speakPost?.doneAt ?? null),
    firstUnitMs: ms(sentAt, firstUnit),
    unitToHandOverMs: ms(firstUnit, handOver),
  };
}

/** For every speak_text the page published: time to the vendor's next speak_started and to the next audio onset. */
function unitTimings(
  lab: FaceLab,
  after: number,
): { publishToStartedMs: number[]; publishToAudioMs: number[] } {
  const started = inEvents(lab, 'avatar.speak_started', after).map((e) => e.at);
  const publishToStartedMs: number[] = [];
  const publishToAudioMs: number[] = [];
  for (const out of outEvents(lab, 'avatar.speak_text', after)) {
    const s = firstAfter(started, out.at);
    const a = firstAfter(lab.onsets, out.at);
    if (s !== null) publishToStartedMs.push(Math.round(s - out.at));
    if (a !== null) publishToAudioMs.push(Math.round(a - out.at));
  }
  return { publishToStartedMs, publishToAudioMs };
}

/**
 * LITE: for every unit the page handed the server (its first `face/speak` part): time to the next speak_started (when
 * the room carries it), to the next audio onset on the face's track, and to the server's 204 (relayed to the vendor).
 */
function liteUnitTimings(
  lab: FaceLab,
  after: number,
): { handOverToStartedMs: number[]; handOverToAudioMs: number[]; handOverToDoneMs: number[] } {
  const started = inEvents(lab, 'avatar.speak_started', after).map((e) => e.at);
  const handOverToStartedMs: number[] = [];
  const handOverToAudioMs: number[] = [];
  const handOverToDoneMs: number[] = [];
  for (const post of speakPosts(lab, after).filter((f) => f.part === '0')) {
    const s = firstAfter(started, post.at);
    const a = firstAfter(lab.onsets, post.at);
    if (s !== null) handOverToStartedMs.push(Math.round(s - post.at));
    if (a !== null) handOverToAudioMs.push(Math.round(a - post.at));
    if (post.doneAt !== null && post.status === 204) handOverToDoneMs.push(Math.round(post.doneAt - post.at));
  }
  return { handOverToStartedMs, handOverToAudioMs, handOverToDoneMs };
}

/** Sound intervals [onset, offset] (an onset without its offset runs to `end`). */
function intervals(onsets: readonly number[], offsets: readonly number[], after: number, end: number) {
  const out: [number, number][] = [];
  for (const onset of onsets.filter((t) => t >= after)) {
    out.push([onset, firstAfter(offsets, onset) ?? end]);
  }
  return out;
}

/**
 * A LITE stock face the page feeds, from its own speak channel and the same meters as every arm: the sockets it
 * opened, the utterances of each turn (must be one), chunk sizes, acknowledgements, first chunk → speak_started →
 * sound on the avatar's track, keep-alives, the units the call played itself while the face was live (fallbacks), and
 * the doubled-audio detector: the avatar's track and the call's own output sounding at the same time.
 */
function liteBrowserSummary(lab: FaceLab, live: number, turnsSentAt: readonly number[], end: number) {
  const speaks = liteOut(lab, 'agent.speak', live);
  const utterancesPerTurn = turnsSentAt.map((sentAt, i) => {
    const until = turnsSentAt[i + 1] ?? end;
    return new Set(speaks.filter((f) => f.at >= sentAt && f.at < until).map((f) => f.id)).size;
  });
  const ids = [...new Set(speaks.map((f) => f.id))];
  const firstChunkToStartedMs: number[] = [];
  const startedToAudioMs: number[] = [];
  const firstChunkBytes: number[] = [];
  for (const id of ids) {
    const first = speaks.find((f) => f.id === id);
    if (first === undefined) continue;
    firstChunkBytes.push(first.bytes);
    const started = liteIn(lab, 'agent.speak_started', first.at).find((f) => f.source === id);
    if (started === undefined) continue;
    firstChunkToStartedMs.push(Math.round(started.at - first.at));
    const sound = firstAfter(lab.onsets, started.at);
    if (sound !== null) startedToAudioMs.push(Math.round(sound - started.at));
  }
  const appended = liteIn(lab, 'agent.audio_buffer_appended', live).length;
  const committed = liteIn(lab, 'agent.audio_buffer_committed', live).length;
  const face = intervals(lab.onsets, lab.offsets, live, end);
  const own = intervals(lab.appOnsets, lab.appOffsets, live, end);
  let overlaps = 0;
  let overlapMs = 0;
  for (const [a0, a1] of face) {
    for (const [b0, b1] of own) {
      const ms = Math.min(a1, b1) - Math.max(a0, b0);
      if (ms > 0) {
        overlaps += 1;
        overlapMs += ms;
      }
    }
  }
  return {
    sockets: lab.lite.sockets,
    utterances: ids.length,
    utterancesPerTurn,
    chunks: speaks.length,
    firstChunkBytes,
    maxChunkBytes: Math.max(0, ...speaks.map((f) => f.bytes)),
    speakEnds: liteOut(lab, 'agent.speak_end', live).length,
    keepAlives: liteOut(lab, 'session.keep_alive', live).length,
    interrupts: liteOut(lab, 'agent.interrupt', live).length,
    appendedOk: appended === speaks.length,
    committedOk: committed === liteOut(lab, 'agent.speak_end', live).length,
    firstChunkToStartedMs,
    startedToAudioMs,
    errors: liteIn(lab, 'error', live).length,
    // The call's own speakers while the face was live: units the face gave back (or never took).
    fallbacks: lab.plays.filter((t) => t >= live).length,
    doubledAudio: { overlaps, ms: Math.round(overlapMs) },
  };
}

/** The LITE arm's steps, in order: a failure records the one it stopped at. */
type LiteStep = 'start_call' | 'face_join' | 'greeting' | 'turns' | 'barge_in';

/** A message's first line with colours, URLs and long id-like runs removed (private files only, still never a URL). */
function scrubbed(message: string): string {
  return (
    (message.split('\n').find((line) => line.trim() !== '') ?? '')
      // eslint-disable-next-line no-control-regex -- terminal colours in Playwright's messages
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
      .replace(/[A-Za-z0-9_-]{24,}/g, '<id>')
      .trim()
      .slice(0, 160)
  );
}

/** The page's uncaught errors while the arm runs: name and scrubbed first line (at most 20). */
function watchPageErrors(page: Page): { name: string; message: string }[] {
  const seen: { name: string; message: string }[] = [];
  page.on('pageerror', (error) => {
    if (seen.length < 20) seen.push({ name: error.name, message: scrubbed(error.message) });
  });
  return seen;
}

/**
 * Why the LITE arm failed, for the private result and (as tokens) the summary: the step it stopped at, the error's
 * name and scrubbed first line, the page's own account of the face it gave up (`face/end`: reason, join stage, code),
 * the vendor speak channel as the page used it (sockets attempted, opened, close codes), and uncaught page errors.
 */
async function liteFailure(
  page: Page,
  step: LiteStep,
  err: unknown,
  pageErrors: readonly { name: string; message: string }[],
): Promise<Record<string, unknown>> {
  const lab = await readLab(page).catch(() => null);
  return {
    step,
    error: errorName(err),
    message: err instanceof Error ? scrubbed(err.message) : null,
    face_end: lab?.faceEnds[0] ?? null,
    face_ends: lab?.faceEnds.length ?? null,
    lite_socket:
      lab === null
        ? null
        : {
            attempts: lab.lite.attempts,
            opened: lab.lite.opened,
            close_codes: lab.lite.closeCodes.slice(0, 10),
            carried_frames: lab.lite.sockets,
          },
    page_errors: [...pageErrors],
  };
}

/**
 * Barge-in on a LITE stock face the page feeds: a line is typed, and once the avatar started saying the reply the
 * founder interrupts (the call's Interrupt button). From the page's `agent.interrupt` to the vendor's
 * `agent.audio_buffer_cleared`, to silence on the avatar's track (the meter's offset), and whether the face's element
 * was silenced at once (before the vendor answered).
 */
async function liteBargeIn(page: Page, line: string) {
  const before = await pageNow(page);
  await typeOnCall(page, line);
  const started = await until(
    page,
    (lab) => liteIn(lab, 'agent.speak_started', before).length > 0,
    FIRST_SOUND_MS,
  );
  if (!started) return { measured: false };
  await page.waitForTimeout(600);
  await callScreen(page).getByRole('button', { name: 'Interrupt' }).click({ timeout: 5_000 });
  const elementSilenced = await videoTile(page)
    .locator('video')
    .evaluate((element: HTMLVideoElement) => element.muted || element.volume === 0)
    .catch(() => null);
  await until(page, (lab) => liteOut(lab, 'agent.interrupt', before).length > 0, 5_000);
  await page.waitForTimeout(1_500);
  const lab = await readLab(page);
  const interrupt = liteOut(lab, 'agent.interrupt', before)[0] ?? null;
  const cleared =
    interrupt === null ? null : (liteIn(lab, 'agent.audio_buffer_cleared', interrupt.at)[0] ?? null);
  const silence = interrupt === null ? null : firstAfter(lab.offsets, interrupt.at);
  return {
    measured: interrupt !== null,
    elementSilenced,
    interruptToClearedMs: ms(interrupt?.at ?? null, cleared?.at ?? null),
    interruptToSilenceMs: ms(interrupt?.at ?? null, silence),
    // The page interrupted once and told the server.
    serverTold: lab.fetches.some(
      (f) => f.method === 'POST' && f.path.endsWith('/face/interrupt') && f.at >= before,
    ),
  };
}

// ---- the suite --------------------------------------------------------------------------------------------

// Not serial: one failing test must not skip the others (a single worker runs them in order anyway).
test.describe('Conversation lab · face (HeyGen LiveAvatar FULL and LITE, sandbox)', () => {
  test.use({ storageState: FOUNDER_STATE });

  // The instruments themselves, first and in every run (the dry run included): a loopback data channel in one page
  // carries a packet shaped like LiveKit's (bytes around a JSON payload); the tap must read it in both directions
  // and the injection must rewrite its words in place, same length, so the receiver gets the injected words.
  test('instruments: the page taps read and rewrite a data channel, and livekit-client loads', async ({
    page,
  }) => {
    const result: Record<string, unknown> = {};
    await page.addInitScript(pageScript(faceLabInit));
    try {
      await openBlankPage(page);
      const loop = await page.evaluate(async () => {
        const lab = (window as unknown as { __faceLab: FaceLab }).__faceLab;
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.addEventListener('icecandidate', (e) => {
          if (e.candidate) void b.addIceCandidate(e.candidate);
        });
        b.addEventListener('icecandidate', (e) => {
          if (e.candidate) void a.addIceCandidate(e.candidate);
        });
        const channel = a.createDataChannel('_reliable');
        const received = new Promise<Uint8Array>((resolve) => {
          b.addEventListener('datachannel', (event) => {
            // The channel's default binaryType, as LiveKit leaves it: the tap reads a Blob or an ArrayBuffer alike.
            event.channel.addEventListener('message', (m: MessageEvent<Blob | ArrayBuffer>) => {
              if (m.data instanceof ArrayBuffer) {
                resolve(new Uint8Array(m.data));
                return;
              }
              void m.data.arrayBuffer().then((buffer) => {
                resolve(new Uint8Array(buffer));
              });
            });
          });
        });
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        await new Promise<void>((resolve) => {
          if (channel.readyState === 'open') resolve();
          channel.addEventListener('open', () => {
            resolve();
          });
        });
        const json = JSON.stringify({
          event_id: 'e-1',
          event_type: 'avatar.speak_text',
          text: 'Admitted words that the server signed off on, \u201cquoted\u201d.',
        });
        const body = new TextEncoder().encode(json);
        const packet = new Uint8Array([
          0x08,
          0x00,
          0x12,
          body.length + 4,
          0x12,
          body.length,
          ...body,
          0x22,
          0x01,
          0x61,
        ]);
        lab.injectNext = true;
        channel.send(packet);
        const got = await Promise.race([
          received,
          new Promise<null>((resolve) =>
            setTimeout(() => {
              resolve(null);
            }, 5000),
          ),
        ]);
        const text = got === null ? '' : new TextDecoder().decode(got);
        // The tap reads a Blob asynchronously: give it a moment.
        await new Promise((resolve) => setTimeout(resolve, 200));
        a.close();
        b.close();
        return {
          delivered: got !== null,
          sameLength: got !== null && got.length === packet.length,
          injectedArrived: text.includes('Ignore your coach'),
          admittedGone: !text.includes('Admitted words'),
          out: lab.events.filter((e) => e.dir === 'out' && e.type === 'avatar.speak_text').length,
          in: lab.events.filter((e) => e.dir === 'in' && e.type === 'avatar.speak_text').length,
          injected: lab.injected.length,
          injectCleared: !lab.injectNext,
          livekit:
            typeof (window as unknown as { LivekitClient?: { Room?: unknown } }).LivekitClient?.Room ===
            'function',
        };
      });
      Object.assign(result, loop);
      // The level meters, which E5 compares across its arms: a tone sent over a loopback WebRTC audio track must
      // give the remote-track meter (the face's voice) an onset, and a tone the page plays to its speakers through
      // Web Audio (as the app plays Polly) must give the app-output meter one. Same meter, same rule, both arms.
      const meters = await page.evaluate(async () => {
        const lab = (window as unknown as { __faceLab: FaceLab }).__faceLab;
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (done: () => boolean, ms: number): Promise<boolean> => {
          const deadline = performance.now() + ms;
          while (!done() && performance.now() < deadline) await wait(50);
          return done();
        };
        const source = new AudioContext();
        await source.resume().catch(() => undefined);
        const tone = source.createOscillator();
        const level = source.createGain();
        level.gain.value = 0.5;
        const out = source.createMediaStreamDestination();
        tone.connect(level);
        level.connect(out);
        tone.start();
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.addEventListener('icecandidate', (e) => {
          if (e.candidate) void b.addIceCandidate(e.candidate);
        });
        b.addEventListener('icecandidate', (e) => {
          if (e.candidate) void a.addIceCandidate(e.candidate);
        });
        const [track] = out.stream.getAudioTracks();
        if (track !== undefined) a.addTrack(track, out.stream);
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        const onsetsBefore = lab.onsets.length;
        const meter = await waitFor(() => lab.onsets.length > onsetsBefore, 8000);
        tone.stop();
        a.close();
        b.close();
        await source.close().catch(() => undefined);

        const speakers = new AudioContext();
        await speakers.resume().catch(() => undefined);
        const buffer = speakers.createBuffer(1, speakers.sampleRate, speakers.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i += 1)
          samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / speakers.sampleRate);
        const gain = speakers.createGain();
        gain.connect(speakers.destination);
        const play = speakers.createBufferSource();
        play.buffer = buffer;
        play.connect(gain);
        const appBefore = lab.appOnsets.length;
        const scheduledAt = performance.timeOrigin + performance.now();
        play.start();
        const appMeter = await waitFor(() => lab.appOnsets.length > appBefore, 4000);
        const heard = lab.appOnsets[appBefore];
        await speakers.close().catch(() => undefined);
        return {
          meter,
          appMeter,
          appScheduledToOnsetMs: heard === undefined ? null : Math.round(heard - scheduledAt),
        };
      });
      Object.assign(result, meters);
      // The WebSocket tap (the LITE speak channel's) and LiveKit's signalling, which is a WebSocket too: a socket must
      // construct under the tap and reach the network (a refused local port closes within seconds), and a room
      // joining a refused address must fail as fast, never wait out its signal timeout. Run 42112455038's tap threw
      // on every construction, so the LITE face's room never joined (face-lab-page.ts).
      const sockets = await page.evaluate(async () => {
        const lab = (window as unknown as { __faceLab: FaceLab }).__faceLab;
        let constructs: boolean;
        try {
          const socket = new WebSocket('ws://127.0.0.1:9/lab/interactive-avatar/session/lab');
          constructs = socket instanceof WebSocket;
          await new Promise<void>((resolve) => {
            socket.addEventListener('close', () => {
              resolve();
            });
            setTimeout(resolve, 5000);
          });
        } catch {
          constructs = false;
        }
        const LK = (window as unknown as { LivekitClient?: typeof LiveKit }).LivekitClient;
        let signalMs: number | null = null;
        if (LK?.Room !== undefined) {
          const room = new LK.Room({ adaptiveStream: false, dynacast: false });
          const begun = performance.now();
          try {
            await room.connect('ws://127.0.0.1:9', 'lab-instruments', { autoSubscribe: false });
          } catch {
            /* refused, as it must be */
          }
          signalMs = Math.round(performance.now() - begun);
          await room.disconnect().catch(() => undefined);
        }
        return {
          socketTap: constructs && lab.lite.attempts === 1 && lab.lite.closeCodes.length === 1,
          livekitSignal: signalMs !== null && signalMs < 5000,
          livekitSignalMs: signalMs,
        };
      });
      Object.assign(result, sockets);
    } catch (err) {
      result.error = errorName(err);
    } finally {
      writePrivate('face/instruments.json', result);
    }
    expect(result).toMatchObject({
      delivered: true,
      sameLength: true,
      injectedArrived: true,
      admittedGone: true,
      out: 1,
      in: 1,
      injected: 1,
      injectCleared: true,
      livekit: true,
      meter: true,
      appMeter: true,
      socketTap: true,
      livekitSignal: true,
    });
  });

  test('probe: the vendor sandbox commanded directly', async ({ page }) => {
    test.skip(FACE !== 'heygen' || PROBE_TOKEN === '', 'needs the vendor sandbox (the lab on GitHub)');
    test.skip(APP_MODE !== 'full', 'the FULL pass only (the app runs its face in LITE)');
    test.setTimeout(6 * 60_000);
    const api = await probeApi();
    const result: Record<string, unknown> = {};
    const texts: Record<string, unknown> = {};
    await page.addInitScript(pageScript(faceLabInit));
    try {
      await openBlankPage(page);
      // Session A: exact words, back-to-back texts, the transcript endpoint, then idle until the vendor ends it.
      const a = await openProbeSession(api, 'full', 120);
      const openedA = await pageNow(page);
      const roomA = await joinProbeRoom(page, a);
      result.full_room = roomA;
      if (roomA.error === null) {
        const sentExact = await command(page, 'avatar.speak_text', PROBE_TEXT.exact);
        await until(page, (lab) => inEvents(lab, 'avatar.speak_ended', sentExact).length > 0, 20_000);
        let lab = await readLab(page);
        const said = inEvents(lab, 'avatar.transcription', sentExact).map((e) => e.text ?? '');
        result.exact = {
          speak_started: inEvents(lab, 'avatar.speak_started', sentExact).length > 0,
          speak_ended: inEvents(lab, 'avatar.speak_ended', sentExact).length > 0,
          transcriptions: said.length,
          matches: said.some((s) => words(s) === words(PROBE_TEXT.exact)),
          publish_to_started_ms: ms(
            sentExact,
            inEvents(lab, 'avatar.speak_started', sentExact)[0]?.at ?? null,
          ),
          publish_to_audio_ms: ms(sentExact, firstAfter(lab.onsets, sentExact)),
          publish_to_transcription_ms: ms(
            sentExact,
            inEvents(lab, 'avatar.transcription', sentExact)[0]?.at ?? null,
          ),
        };
        texts.exact = { sent: PROBE_TEXT.exact, said };
        await page.waitForTimeout(800);

        const queueFrom = await pageNow(page);
        for (const text of PROBE_TEXT.queue) await command(page, 'avatar.speak_text', text);
        await until(page, (l) => inEvents(l, 'avatar.speak_ended', queueFrom).length >= 3, 25_000);
        await page.waitForTimeout(1500);
        lab = await readLab(page);
        const starts = inEvents(lab, 'avatar.speak_started', queueFrom).map((e) => e.at);
        const ends = inEvents(lab, 'avatar.speak_ended', queueFrom).map((e) => e.at);
        const queueSaid = inEvents(lab, 'avatar.transcription', queueFrom).map((e) => e.text ?? '');
        const inOrder =
          queueSaid.length === 3 && queueSaid.every((s, i) => words(s) === words(PROBE_TEXT.queue[i] ?? ''));
        const overlapping = starts.slice(1).some((s, i) => (ends[i] ?? Infinity) > s);
        result.queue = {
          starts: starts.length,
          ends: ends.length,
          transcriptions: queueSaid.length,
          in_order: inOrder,
          behaviour:
            starts.length === 3 && ends.length === 3 && inOrder && !overlapping
              ? 'queued'
              : starts.length < 3 || ends.length < starts.length || overlapping
                ? 'cut'
                : 'other',
          gaps_ms: starts.slice(1).map((s, i) => ms(ends[i] ?? null, s)),
        };
        texts.queue = { sent: PROBE_TEXT.queue, said: queueSaid };

        const readAt = Date.now();
        const transcript = await api.get(`/api/v1/_lab/face/sessions/${a.sessionId}/transcript`);
        const body =
          transcript.status() === 200
            ? ((await transcript.json()) as { complete: boolean; lines: { role: string; text: string }[] })
            : null;
        const avatarLines = (body?.lines ?? []).filter((l) => l.role === 'avatar').map((l) => l.text);
        result.transcript_endpoint = {
          status: transcript.status(),
          ms: Date.now() - readAt,
          complete: body?.complete ?? null,
          avatar_lines: avatarLines.length,
          user_lines: (body?.lines ?? []).filter((l) => l.role === 'user').length,
          has_exact: avatarLines.some((l) => words(l) === words(PROBE_TEXT.exact)),
          has_all_queue: PROBE_TEXT.queue.every((q) => avatarLines.some((l) => words(l) === words(q))),
        };
        texts.transcript = avatarLines;

        // Idle: no command until the vendor stops the session (the sandbox's own limit, or its idle timeout).
        await until(page, (l) => inEvents(l, 'session.stopped', openedA).length > 0, 100_000);
        lab = await readLab(page);
        const stopped = inEvents(lab, 'session.stopped', openedA)[0] ?? null;
        result.idle_end = {
          stopped: stopped !== null,
          end_reason: stopped?.reason ?? null,
          seconds: stopped === null ? null : Math.round((stopped.at - openedA) / 100) / 10,
        };
        result.full_user_transcriptions = inEvents(lab, 'user.transcription', openedA).length;
      }
      await leaveProbeRoom(page);
      await stopProbeSession(api, a);

      // Session B: interrupt (time to silence, queue cleared), speak_response ignored, and its own max duration.
      const maxB = 30;
      const b = await openProbeSession(api, 'full', maxB);
      const openedB = await pageNow(page);
      const roomB = await joinProbeRoom(page, b);
      result.full_room_b = roomB;
      if (roomB.error === null) {
        const sentLong = await command(page, 'avatar.speak_text', PROBE_TEXT.long);
        await command(page, 'avatar.speak_text', PROBE_TEXT.queued);
        await until(page, (l) => inEvents(l, 'avatar.speak_started', sentLong).length > 0, 15_000);
        await page.waitForTimeout(1500);
        const interruptAt = await command(page, 'avatar.interrupt');
        await until(page, (l) => inEvents(l, 'avatar.speak_ended', interruptAt).length > 0, 8_000);
        await page.waitForTimeout(6000);
        let lab = await readLab(page);
        const queuedSaid = inEvents(lab, 'avatar.transcription', sentLong)
          .map((e) => e.text ?? '')
          .some((s) => words(s) === words(PROBE_TEXT.queued));
        result.interrupt = {
          started_before: inEvents(lab, 'avatar.speak_started', sentLong).some((e) => e.at < interruptAt),
          to_speak_ended_ms: ms(interruptAt, inEvents(lab, 'avatar.speak_ended', interruptAt)[0]?.at ?? null),
          to_silence_ms: ms(interruptAt, firstAfter(lab.offsets, interruptAt)),
          queued_started_after: inEvents(lab, 'avatar.speak_started', interruptAt + 50).length,
          queued_transcribed: queuedSaid,
          queue_cleared: inEvents(lab, 'avatar.speak_started', interruptAt + 50).length === 0,
        };

        const responseAt = await command(page, 'avatar.speak_response', PROBE_TEXT.response);
        await page.waitForTimeout(8000);
        lab = await readLab(page);
        result.speak_response = {
          speak_started: inEvents(lab, 'avatar.speak_started', responseAt).length,
          avatar_transcriptions: inEvents(lab, 'avatar.transcription', responseAt).length,
          ignored:
            inEvents(lab, 'avatar.speak_started', responseAt).length === 0 &&
            inEvents(lab, 'avatar.transcription', responseAt).length === 0,
        };
        texts.speak_response = inEvents(lab, 'avatar.transcription', responseAt).map((e) => e.text);

        await until(page, (l) => inEvents(l, 'session.stopped', openedB).length > 0, (maxB + 45) * 1000);
        lab = await readLab(page);
        const stopped = inEvents(lab, 'session.stopped', openedB)[0] ?? null;
        result.max_duration = {
          requested_seconds: maxB,
          stopped: stopped !== null,
          end_reason: stopped?.reason ?? null,
          seconds: stopped === null ? null : Math.round((stopped.at - openedB) / 100) / 10,
        };
      }
      await leaveProbeRoom(page);
      await stopProbeSession(api, b);

      // Session C: may a LITE room token publish data at all? (FULL's must: commands go over the room.)
      const c = await openProbeSession(api, 'lite', 20);
      const roomC = await joinProbeRoom(page, c);
      result.lite_room = roomC;
      await leaveProbeRoom(page);
      await stopProbeSession(api, c);
      const lab = await readLab(page);
      result.probe_mic_requests = lab.mic.length;
      result.probe_audio_senders = lab.audioSenders;
    } catch (err) {
      result.error = errorName(err);
    } finally {
      writePrivate('face/probe.json', result);
      writePrivate('face/probe-texts.json', texts);
      await api.dispose();
    }
    expect(result.error ?? null, 'probe').toBeNull();
  });

  // Before any measured arm, in every pass (the LITE pass's API was restarted): one call turn nobody measures, so the API
  // process's first-turn cost (orchestrator/warm-up.ts, lab run 41235680528) lands on no arm. On Polly alone, so it
  // opens no vendor session. Its server timing is reported apart (face.py public_warm_up), never in an arm.
  test('warm-up: one unmeasured call turn before the measured arms', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.setTimeout(3 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = {};
    await page.addInitScript(pageScript(faceLabInit));
    await setFacesEnabled(baseURL, false);
    let started = false;
    try {
      await acknowledgeNotices(page);
      await startCall(page);
      started = true;
      await expect(presenceTile(page)).toBeVisible({ timeout: 30_000 });
      await waitForFaceQuiet(page, { timeoutMs: 20_000 });
      const turn = await measuredTurn(page, WARM_UP_LINE);
      result.turns = [turn].map(({ sentAt: _sentAt, ...rest }) => rest);
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/warmup.json', result);
    }
    // Never a reason to stop the run: the measured arms go on whatever happened here.
  });

  test('call: the stock face in a call, admins only, labelled, without the microphone', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.skip(APP_MODE !== 'full', 'the FULL pass only (the app runs its face in LITE)');
    test.setTimeout(6 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = { vendor: FACE };
    await page.addInitScript(pageScript(faceLabInit));
    const sessions = watchAvatarSession(page);
    await faceSettings(baseURL, true);
    let started = false;
    try {
      await acknowledgeNotices(page);
      const call = await startCall(page, 'video');
      started = true;
      result.input_mode = call.inputMode;
      await expect(videoTile(page)).toBeVisible({ timeout: 30_000 });
      const live = await pageNow(page);
      // The face first, then the conversation: Start call → first frame → first word (the intro, said by the face).
      result.startup = await callStartup(page);
      const label = videoTile(page).locator('[data-slot="call-ai-avatar-label"]');
      result.label_visible = await label.isVisible();
      result.label_text_ok = ((await label.textContent()) ?? '').trim() === 'AI avatar';
      const micAtLive = (await readLab(page)).mic.length;
      // The greeting (the call's intro), when there is one, is said first.
      await waitForFaceQuiet(page, { timeoutMs: 20_000 });
      const turns: TurnTiming[] = [];
      for (const line of LINES) turns.push(await measuredTurn(page, line));
      let lab = await readLab(page);
      const units = unitTimings(lab, live);
      const sayResponses = lab.fetches.filter((f) => f.path.endsWith('/face/say')).length;
      result.session = sessions[0] ?? null;
      result.turns = turns.map(({ sentAt: _sentAt, ...rest }) => rest);
      result.units = units;
      result.speak_text_sent = outEvents(lab, 'avatar.speak_text', live).length;
      result.say_requests = sayResponses;
      // The reply's units the server pre-approved for the face as it signed them (no face/say for those).
      result.units_streamed = lab.units.filter((u) => u.at >= live).length;
      result.units_preapproved = lab.units.filter((u) => u.at >= live && u.face).length;
      result.app_playbacks_after_live = lab.plays.filter((t) => t >= live).length;
      result.mic_requests_after_live = lab.mic.length - micAtLive;
      result.audio_senders = lab.audioSenders;
      result.user_transcriptions = inEvents(lab, 'user.transcription').length;
      // Whether the avatar's voice and video arrive in one remote stream (WebRTC's lip sync), runbook §8.5.
      result.av_same_stream = sameStream(lab.remoteTracks);
      // The sandbox ends the session by itself (about a minute): a new session of the same call replaces the face (the
      // tile says "Reconnecting…" meanwhile), and the call goes on. The stand-in never ends by itself: in the dry run
      // its video track is ended instead (a dropped face).
      if (FACE !== 'heygen') {
        await videoTile(page)
          .locator('video')
          .evaluate((element: HTMLVideoElement) => {
            const stream = element.srcObject as MediaStream;
            for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
          });
      }
      const reconnecting = await reconnectingTile(page)
        .waitFor({ state: 'visible', timeout: 120_000 })
        .then(() => true)
        .catch(() => false);
      const gone = await pageNow(page);
      const reconnected =
        reconnecting &&
        (await videoTile(page)
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => true)
          .catch(() => false));
      const back = await pageNow(page);
      lab = await readLab(page);
      const stopped = inEvents(lab, 'session.stopped', live)[0] ?? null;
      result.fallback = {
        reconnected,
        seconds_to_reconnect: reconnected ? Math.round((back - gone) / 100) / 10 : null,
        seconds_live: reconnecting ? Math.round((gone - live) / 100) / 10 : null,
        session_stopped_event: stopped !== null,
        end_reason: stopped?.reason ?? null,
        typed_line_editable: await callScreen(page)
          .getByRole('textbox', { name: /^Reply to / })
          .isEditable()
          .catch(() => false),
      };
      writePrivate('face/call-texts.json', {
        lines: LINES,
        said: outEvents(lab, 'avatar.speak_text', live).map((e) => e.text),
        transcribed: inEvents(lab, 'avatar.transcription', live).map((e) => e.text),
      });
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/call.json', result);
    }
    expect(result.error ?? null, 'call').toBeNull();
    expect(result.label_visible, 'the "AI avatar" label').toBe(true);
    expect(result.mic_requests_after_live, 'microphone requests after the face joined').toBe(0);
  });

  test('injection: words the server never admitted end the face within a heartbeat', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.skip(FACE !== 'heygen', 'the stand-in keeps no transcript (nothing to reconcile)');
    test.skip(APP_MODE !== 'full', 'the FULL pass only (a LITE face renders audio, not words)');
    test.setTimeout(5 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = {};
    await page.addInitScript(pageScript(faceLabInit));
    await faceSettings(baseURL, true);
    const auditsBefore = new Set((await auditIds(baseURL, 'call.face_injection')) ?? []);
    let started = false;
    try {
      await acknowledgeNotices(page);
      await startCall(page, 'video');
      started = true;
      await expect(videoTile(page)).toBeVisible({ timeout: 30_000 });
      const live = await pageNow(page);
      await page.evaluate(() => {
        (window as unknown as { __faceLab: FaceLab }).__faceLab.injectNext = true;
      });
      await typeOnCall(page, LINES[0] ?? '');
      const injected = await until(page, (lab) => lab.injected.length > 0, 60_000);
      let lab = await readLab(page);
      const at = lab.injected[0]?.at ?? null;
      // The server stopped the face: it never comes back in this call, and the tile says video is not available.
      const ended = await unavailableTile(page)
        .waitFor({ state: 'visible', timeout: (3 * HEARTBEAT_SECONDS + 15) * 1000 })
        .then(() => true)
        .catch(() => false);
      const back = await pageNow(page);
      lab = await readLab(page);
      const stopped = inEvents(lab, 'session.stopped', live)[0] ?? null;
      // The audits this test caused; the harness reads where each check ran (heartbeat or after the face ended)
      // from the lab's database (lab-face-audits.ts), since the admin listing carries no metadata. Whatever ended
      // the face, `session.stopped` reaches the page first (the page drops the face on it), so its ORDER says
      // nothing; its end_reason and the audits' atEnd do.
      let added: number[] = [];
      const auditDeadline = Date.now() + 20_000;
      while (Date.now() < auditDeadline && added.length === 0) {
        added = ((await auditIds(baseURL, 'call.face_injection')) ?? []).filter(
          (id) => !auditsBefore.has(id),
        );
        if (added.length === 0) await page.waitForTimeout(1000);
      }
      result.injected = injected;
      result.face_ended = ended;
      result.seconds_to_end = ended && at !== null ? Math.round((back - at) / 100) / 10 : null;
      // From the face going live (the video tile shown) to the injection: against the sandbox's ~60 s minute.
      result.seconds_into_session = at === null ? null : Math.round((at - live) / 100) / 10;
      result.heartbeat_seconds = HEARTBEAT_SECONDS;
      result.audit_injection_events = added.length;
      result.audit_ids = added;
      result.end_reason = stopped?.reason ?? null;
      writePrivate('face/injection-texts.json', { injected: lab.injected.map((i) => i.text) });
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/injection.json', result);
    }
    expect(result.error ?? null, 'injection').toBeNull();
  });

  test('polly: the same turns without a face (first audio, the A/B arm)', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.setTimeout(4 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = {};
    await page.addInitScript(pageScript(faceLabInit));
    await setFacesEnabled(baseURL, false);
    let started = false;
    try {
      await acknowledgeNotices(page);
      await startCall(page);
      started = true;
      await expect(presenceTile(page)).toBeVisible({ timeout: 30_000 });
      await waitForFaceQuiet(page, { timeoutMs: 20_000 });
      const turns: TurnTiming[] = [];
      for (const line of LINES) turns.push(await measuredTurn(page, line));
      result.turns = turns.map(({ sentAt: _sentAt, ...rest }) => rest);
    } catch (err) {
      result.error = errorName(err);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/polly.json', result);
    }
    expect(result.error ?? null, 'polly').toBeNull();
  });

  // The same call arm with the app's face as a LITE stock face the page feeds (the lab restarted the API with
  // MEDIA_FACE_MODE=lite and MEDIA_FACE_LITE_ROUTE=browser; the sandbox's Wayne, admins only): the same founder turns
  // and meters as the FULL call and the voice alone. The page holds the avatar's speak channel and forwards each
  // admitted unit's ElevenLabs PCM as it arrives, one utterance per turn; then one barge-in turn.
  test("call LITE: the stock face lip-syncs the call's own voice, the same turns", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.skip(APP_MODE !== 'lite', 'the LITE pass only (the app runs its face in FULL)');
    test.setTimeout(6 * 60_000);
    test.skip(!(await appWithinBudget(baseURL, 0.1)), 'the app reached its share of the budget');
    const result: Record<string, unknown> = { vendor: FACE, mode: 'lite' };
    await page.addInitScript(pageScript(faceLabInit));
    const sessions = watchAvatarSession(page);
    const pageErrors = watchPageErrors(page);
    await faceSettings(baseURL, true);
    let started = false;
    // Where the arm is, so a failure says which step it stopped at (and, for the face's join, the page's own account).
    let step: LiteStep = 'start_call';
    try {
      await acknowledgeNotices(page);
      const call = await startCall(page, 'video');
      started = true;
      result.input_mode = call.inputMode;
      step = 'face_join';
      await expect(videoTile(page)).toBeVisible({ timeout: 30_000 });
      result.face_shown = true;
      const live = await pageNow(page);
      // The face first, then the conversation: Start call → first frame → first word (the intro, said by the face).
      result.startup = await callStartup(page);
      const micAtLive = (await readLab(page)).mic.length;
      // The greeting (the call's intro), when there is one, is said first.
      step = 'greeting';
      await waitForFaceQuiet(page, { timeoutMs: 20_000, pairedEvents: false });
      const turns: TurnTiming[] = [];
      step = 'turns';
      for (const line of LINES) turns.push(await measuredTurn(page, line, { pairedEvents: false }));
      const measuredEnd = await pageNow(page);
      const lab = await readLab(page);
      const posts = speakPosts(lab, live);
      result.session = sessions[0] ?? null;
      result.turns = turns.map(({ sentAt: _sentAt, ...rest }) => rest);
      result.units = liteUnitTimings(lab, live);
      result.lite_browser = liteBrowserSummary(
        lab,
        live,
        turns.map((t) => t.sentAt),
        measuredEnd,
      );
      step = 'barge_in';
      result.barge_in = await liteBargeIn(page, BARGE_IN_LINE).catch((err: unknown) => ({
        measured: false,
        error: errorName(err),
      }));
      result.speak_requests = posts.length;
      result.speak_accepted = posts.filter((f) => f.status === 204).length;
      result.speak_text_sent = outEvents(lab, 'avatar.speak_text', live).length;
      result.app_playbacks_after_live = lab.plays.filter((t) => t >= live).length;
      result.mic_requests_after_live = lab.mic.length - micAtLive;
      result.audio_senders = lab.audioSenders;
    } catch (err) {
      result.face_shown ??= false;
      result.error = errorName(err);
      result.session ??= sessions[0] ?? null;
      result.failure = await liteFailure(page, step, err, pageErrors);
    } finally {
      if (started) await hangUp(page).catch(() => undefined);
      writePrivate('face/call-lite.json', result);
    }
    expect(result.error ?? null, 'call (LITE)').toBeNull();
  });
});
