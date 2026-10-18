import { readFileSync } from 'node:fs';

import { expect, type Page, type Request } from '@playwright/test';

import { FOUNDER_STATE, test } from '../support/fixtures';
import {
  acknowledgeNotices,
  appWithinBudget,
  callScreen,
  errorName,
  privateDir,
  sessionTurns,
  startCall,
  writePrivate,
} from './lab-support';

/*
 * Voice suite of the conversation lab: a true voice call, headless. Chromium's fake microphone device plays the
 * founder's first line (LAB_FAKE_MIC_WAV, after a silence long enough for the vEIR's greeting); the later lines
 * are mixed into the same microphone stream when the call is listening, or on purpose while the vEIR is still
 * speaking (barge-in). The app streams the microphone to Amazon Transcribe, answers on the real model and speaks
 * with Amazon Polly into a fake output device. The page records when the app's speech starts and stops; the
 * request log gives when each turn was sent. Graded by ops/lab conversation_lab/voice.py.
 */

interface ManifestLine {
  id: string;
  file: string;
  speechSeconds: number;
  leadSeconds: number;
  bargeIn: boolean;
  bargeInDelayMs: number;
}

interface LabAudio {
  appStarts: number[];
  appStops: number[];
  appEnds: number[];
  appPlaying: number;
  captureStartedAt: number | null;
}

/**
 * Runs in the page before the app: counts the app's speech playback (AudioBufferSourceNode start/stop/ended on
 * any context but the lab's own) and wraps getUserMedia so the microphone the app receives is the fake device
 * mixed with lines the test plays into it (`__labSay`). Nothing reaches a speaker: the lab's context only feeds a
 * MediaStream, and Chromium runs with a fake output device.
 */
function labAudioInit(): void {
  const now = (): number => performance.timeOrigin + performance.now();
  const lab = {
    appStarts: [] as number[],
    appStops: [] as number[],
    appEnds: [] as number[],
    appPlaying: 0,
    captureStartedAt: null as number | null,
    ctx: null as AudioContext | null,
    dest: null as MediaStreamAudioDestinationNode | null,
  };
  (window as unknown as { __lab: typeof lab }).__lab = lab;
  const proto = AudioBufferSourceNode.prototype;
  type Play = (this: AudioBufferSourceNode, ...args: number[]) => void;
  const start: Play = Reflect.get<AudioBufferSourceNode, 'start'>(proto, 'start');
  const stop: Play = Reflect.get<AudioBufferSourceNode, 'stop'>(proto, 'stop');
  proto.start = function (this: AudioBufferSourceNode, ...args: number[]) {
    if (this.context !== lab.ctx) {
      lab.appStarts.push(now());
      lab.appPlaying += 1;
      this.addEventListener(
        'ended',
        () => {
          lab.appPlaying = Math.max(0, lab.appPlaying - 1);
          lab.appEnds.push(now());
        },
        { once: true },
      );
    }
    start.apply(this, args);
  };
  proto.stop = function (this: AudioBufferSourceNode, ...args: number[]) {
    if (this.context !== lab.ctx) lab.appStops.push(now());
    stop.apply(this, args);
  };
  const devices = navigator.mediaDevices;
  const getUserMedia = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    const device = await getUserMedia(constraints);
    if (!constraints?.audio) return device;
    lab.captureStartedAt = now();
    const ctx = new AudioContext();
    lab.ctx = ctx;
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(device).connect(dest);
    lab.dest = dest;
    const [track] = dest.stream.getAudioTracks();
    if (!track) return device;
    const stopTrack = track.stop.bind(track);
    track.stop = () => {
      for (const t of device.getTracks()) t.stop();
      stopTrack();
    };
    return new MediaStream([track]);
  };
  (
    window as unknown as { __labSay: (b64: string) => Promise<{ startedAt: number; durationMs: number }> }
  ).__labSay = async (b64: string) => {
    const ctx = lab.ctx;
    const dest = lab.dest;
    if (!ctx || !dest) throw new Error('the call has no microphone yet');
    if (ctx.state !== 'running') await ctx.resume();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    const startedAt = now();
    source.start();
    return { startedAt, durationMs: buffer.duration * 1000 };
  };
}

async function audio(page: Page): Promise<LabAudio> {
  return page.evaluate(() => {
    const lab = (window as unknown as { __lab: LabAudio }).__lab;
    return {
      appStarts: [...lab.appStarts],
      appStops: [...lab.appStops],
      appEnds: [...lab.appEnds],
      appPlaying: lab.appPlaying,
      captureStartedAt: lab.captureStartedAt,
    };
  });
}

/** Plays a WAV into the call's microphone stream (`__labSay`); returns when it started and how long it lasts. */
async function sayLine(page: Page, file: string): Promise<{ startedAt: number; durationMs: number }> {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    (data) =>
      (
        window as unknown as { __labSay: (b: string) => Promise<{ startedAt: number; durationMs: number }> }
      ).__labSay(data),
    b64,
  );
}

class TypedCallError extends Error {
  override readonly name = 'TypedCallError';
}

const firstAfter = (values: number[], t: number): number | null => values.find((v) => v >= t) ?? null;

/** Waits until the app has spoken since `since` and then been silent for `quietMs` (or `timeoutMs` passes). */
async function waitForReplyToFinish(
  page: Page,
  since: number,
  quietMs = 1500,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const a = await audio(page);
    const lastActivity = Math.max(0, ...a.appStarts, ...a.appEnds, ...a.appStops);
    const spoke = a.appStarts.some((t) => t >= since);
    if (spoke && a.appPlaying === 0 && Date.now() - lastActivity > quietMs) return;
    await page.waitForTimeout(250);
  }
}

interface CallLog {
  turnPosts: number[];
  interrupts: number[];
  clientStats: unknown[];
  consoleErrors: string[];
}

/** Whether an interrupt request belongs to a barge-in the test made (from its injection to 6 s after). */
function isOwnBargeIn(at: number, injections: readonly number[]): boolean {
  return injections.some((t) => at >= t - 200 && at <= t + 6_000);
}

/**
 * One voice call: line 1 through the fake device (or the mixed stream when the device is not heard), the later
 * lines mixed in, a barge-in where the script says, then End call. Returns what the page saw (times are epoch ms).
 */
async function oneCall(
  page: Page,
  manifest: { lines: ManifestLine[] },
  log: CallLog,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const stats = log.clientStats.length;
  const result: Record<string, unknown> = { lines: [] as unknown[], error: null };
  const injections: number[] = [];
  let sessionId = '';
  /** The step in progress (a fixed label), recorded when something fails. */
  let step = 'start call';
  try {
    const call = await startCall(page);
    sessionId = call.sessionId;
    result.inputMode = call.inputMode;
    result.intro = call.intro;
    // Whether the app opened the (fake) microphone at all, whatever the server granted.
    result.micOpened = (await audio(page)).captureStartedAt !== null;
    // No speech-to-text grant: the call fell back to typing, so there is no voice loop to measure.
    if (call.inputMode !== 'transcribe') throw new TypedCallError();
    const lines = result.lines as Record<string, unknown>[];
    let previousTurnAt = 0;
    for (const [index, line] of manifest.lines.entries()) {
      let speechEndedAt: number;
      let injectedAt: number | null = null;
      let replyWasPlaying = false;
      step = `${line.id}: speak`;
      if (index === 0) {
        // The device file plays from the moment the app opened the microphone.
        const captureAt = await expect
          .poll(async () => (await audio(page)).captureStartedAt, { timeout: 60_000 })
          .not.toBeNull()
          .then(async () => (await audio(page)).captureStartedAt ?? 0);
        speechEndedAt = captureAt + (line.leadSeconds + line.speechSeconds) * 1000;
        // If the device line produced no turn (the file restarted or was never heard), say it through the mixed
        // stream instead, so the rest of the call still runs; the result records which path carried it.
        const deadline = speechEndedAt + 20_000;
        while (Date.now() < deadline && firstAfter(log.turnPosts, speechEndedAt - 400) === null) {
          await page.waitForTimeout(250);
        }
        result.deviceLineHeard = firstAfter(log.turnPosts, speechEndedAt - 400) !== null;
        if (!result.deviceLineHeard) {
          await waitForReplyToFinish(page, 0, 1500, 15_000);
          const said = await sayLine(page, line.file);
          speechEndedAt = said.startedAt + (line.leadSeconds + line.speechSeconds) * 1000;
        }
      } else {
        if (line.bargeIn) {
          // While the reply to the previous line is playing.
          await expect
            .poll(async () => firstAfter((await audio(page)).appStarts, previousTurnAt), {
              timeout: 90_000,
            })
            .not.toBeNull();
          await page.waitForTimeout(line.bargeInDelayMs);
          replyWasPlaying = (await audio(page)).appPlaying > 0;
        } else {
          await waitForReplyToFinish(page, previousTurnAt);
        }
        const said = await sayLine(page, line.file);
        injectedAt = said.startedAt;
        if (line.bargeIn) injections.push(injectedAt);
        speechEndedAt = said.startedAt + (line.leadSeconds + line.speechSeconds) * 1000;
      }
      // The turn the app sends once it hears the end of this line.
      step = `${line.id}: turn sent`;
      await expect
        .poll(() => firstAfter(log.turnPosts, speechEndedAt - 400), {
          timeout: 60_000,
          intervals: [100, 250],
        })
        .not.toBeNull();
      const turnPostedAt = firstAfter(log.turnPosts, speechEndedAt - 400) ?? 0;
      previousTurnAt = turnPostedAt;
      step = `${line.id}: reply audio`;
      await expect
        .poll(async () => firstAfter((await audio(page)).appStarts, turnPostedAt), { timeout: 90_000 })
        .not.toBeNull()
        .catch(() => undefined);
      const a = await audio(page);
      lines.push({
        id: line.id,
        speechEndedAt,
        turnPostedAt,
        firstAudioAt: firstAfter(a.appStarts, turnPostedAt),
      });
      if (line.bargeIn && injectedAt !== null) {
        const interruptAt = firstAfter(log.interrupts, injectedAt - 50);
        result.bargeIn = {
          injectedAt,
          replyWasPlaying,
          playbackStoppedAt: firstAfter(a.appStops, injectedAt),
          interruptSent: interruptAt !== null && interruptAt <= injectedAt + 6_000,
        };
      }
    }
    step = 'end call';
    await waitForReplyToFinish(page, previousTurnAt);
    await callScreen(page).getByRole('button', { name: 'End call' }).click();
    await expect(callScreen(page).getByRole('heading', { name: 'Call ended' })).toBeVisible();
    await expect.poll(() => log.clientStats.length, { timeout: 15_000 }).toBeGreaterThan(stats);
    await callScreen(page).getByRole('button', { name: 'Back to conversation' }).click();
  } catch (error) {
    result.error = error instanceof TypedCallError ? 'typed' : errorName(error);
    result.failedAt = step;
    result.status = await callScreen(page)
      .getByRole('status')
      .allInnerTexts()
      .catch(() => []);
    await page
      .screenshot({ path: `${privateDir()}/voice/failure-${String(startedAt)}.png`, fullPage: true })
      .catch(() => undefined);
  } finally {
    const endedAt = Date.now();
    result.clientStats = log.clientStats.length > stats ? log.clientStats.at(-1) : null;
    // Interrupt requests the test did not cause by barging in: the vEIR cut off by its own voice or by noise.
    const own = log.interrupts.filter((t) => t >= startedAt && t <= endedAt);
    result.interrupts = own.length;
    result.selfInterruptions = own.filter((t) => !isOwnBargeIn(t, injections)).length;
    if (sessionId) {
      const detail = await sessionTurns(page, sessionId).catch(() => null);
      result.transcripts = detail?.turns.map((t) => t.founderText ?? '') ?? [];
      result.replies = detail?.turns.map((t) => t.response?.spoken ?? t.response?.answer ?? '') ?? [];
    }
  }
  return result;
}

test.describe('conversation lab: voice', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('a voice call: speech in, speech out, barge-in', async ({ page, baseURL }) => {
    /** Calls in a row (LAB_VOICE_REPEAT, the workflow's `repeat`): more barge-ins and first-audio samples. */
    const repeat = Math.min(5, Math.max(1, Number(process.env.LAB_VOICE_REPEAT ?? '1') || 1));
    test.setTimeout(repeat * 8 * 60_000);
    const manifestFile = process.env.LAB_VOICE_MANIFEST;
    test.skip(!manifestFile, 'LAB_VOICE_MANIFEST is not set (the lab prepares it)');
    const manifest = JSON.parse(readFileSync(manifestFile ?? '', 'utf8')) as { lines: ManifestLine[] };
    await page.addInitScript(labAudioInit);
    await acknowledgeNotices(page);

    const log: CallLog = { turnPosts: [], interrupts: [], clientStats: [], consoleErrors: [] };
    page.on('request', (request: Request) => {
      if (request.method() !== 'POST') return;
      const url = request.url();
      if (/\/sessions\/[0-9a-f-]{36}\/turns$/.test(url)) log.turnPosts.push(Date.now());
      else if (/\/turns\/[0-9a-f-]{36}\/interrupt$/.test(url)) log.interrupts.push(Date.now());
      else if (/\/calls\/[0-9a-f-]{36}\/end$/.test(url)) {
        const body = request.postDataJSON() as { clientStats?: unknown } | null;
        log.clientStats.push(body?.clientStats ?? null);
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error') log.consoleErrors.push(message.text().slice(0, 300));
    });

    const calls: Record<string, unknown>[] = [];
    for (let n = 0; n < repeat; n += 1) {
      if (!baseURL || !(await appWithinBudget(baseURL, 0.2))) {
        calls.push({ error: 'budget' });
        break;
      }
      const call = await oneCall(page, manifest, log);
      calls.push(call);
      writePrivate('voice/result.json', { calls, consoleErrors: log.consoleErrors });
      if (call.error === 'typed') break;
    }
    writePrivate('voice/result.json', { calls, consoleErrors: log.consoleErrors });
    expect(
      calls.map((c) => c.error ?? null),
      'every voice call ran to its end',
    ).toEqual(calls.map(() => null));
  });
});
