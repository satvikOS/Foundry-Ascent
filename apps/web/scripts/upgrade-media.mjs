/** Actual Chromium Web Audio graphs. No STT/model or physical-speaker claims are made by this fixture suite. */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const output = resolve(process.env.UPGRADE_RESULTS_DIR ?? '../../docs/upgrade/evidence/media');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  args: [
    '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
await page.route('**/upgrade-media-harness', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Foundry synthetic media harness</title>',
  }),
);
await page.goto(
  new URL('/upgrade-media-harness', process.env.UPGRADE_WEB_URL ?? 'http://127.0.0.1:5173').href,
);
const results = [];
page.on('pageerror', (error) => {
  process.stderr.write(`Browser error: ${error.name}\n`);
});
outer: for (const sampleRate of [8000, 16000, 24000, 32000, 44100, 48000]) {
  for (const pattern of ['voiced', 'pauses', 'quiet', 'noise', 'bursts']) {
    for (const fault of [
      'complete',
      'interrupt-startup',
      'interrupt-mid',
      'cancel-before-decode',
      'reordered-fetch',
    ]) {
      if (results.length >= Number(process.env.MEDIA_MAX_CASES ?? 150)) break outer;
      const id = `MEDIA-${sampleRate}-${pattern}-${fault}`;
      try {
        const result = await page.evaluate(
          async ({ sampleRate, pattern, fault }) => {
            const playerModule = '/src/lib/realtime/playback.ts';
            const characterModule = '/src/lib/realtime/character.ts';
            const { SpeechPlayer } = await import(playerModule);
            const { LocalCharacter } = await import(characterModule);
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate });
            await Promise.race([
              ctx.resume(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('resume_timeout')), 1000)),
            ]);
            let monitor;
            const createAnalyser = ctx.createAnalyser.bind(ctx);
            ctx.createAnalyser = () => {
              monitor = createAnalyser();
              return monitor;
            };
            const wave = () => {
              const length = Math.round(sampleRate * 0.3);
              const buffer = new ArrayBuffer(44 + length * 2);
              const view = new DataView(buffer);
              const str = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
              str(0, 'RIFF');
              view.setUint32(4, 36 + length * 2, true);
              str(8, 'WAVE');
              str(12, 'fmt ');
              view.setUint32(16, 16, true);
              view.setUint16(20, 1, true);
              view.setUint16(22, 1, true);
              view.setUint32(24, sampleRate, true);
              view.setUint32(28, sampleRate * 2, true);
              view.setUint16(32, 2, true);
              view.setUint16(34, 16, true);
              str(36, 'data');
              view.setUint32(40, length * 2, true);
              let seed = 17;
              for (let i = 0; i < length; i++) {
                const time = i / sampleRate;
                seed = (seed * 16807) % 2147483647;
                let sample =
                  Math.sin(time * Math.PI * 2 * 180) * 0.15 + Math.sin(time * Math.PI * 2 * 360) * 0.06;
                if (pattern === 'quiet') sample *= 0.12;
                if (pattern === 'noise') sample += (seed / 2147483647 - 0.5) * 0.06;
                if (pattern === 'pauses' && time > 0.1 && time < 0.16) sample = 0;
                if (pattern === 'bursts') sample *= Math.sin(time * 50) > 0 ? 1 : 0.03;
                view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
              }
              return buffer;
            };
            const stage = document.createElement('div');
            document.body.append(stage);
            const character = new LocalCharacter();
            character.mount(stage, { reducedMotion: false });
            const events = [];
            const fetches = [];
            const player = new SpeechPlayer(
              {
                context: ctx,
                synthesis: null,
                createUtterance: (text) => new SpeechSynthesisUtterance(text),
                now: () => performance.now(),
                setTimeout: (callback, ms) => window.setTimeout(callback, ms),
                clearTimeout: (handle) => window.clearTimeout(handle),
                fetchSpeech: async (unit, signal) => {
                  fetches.push(signal);
                  await sleep(
                    fault === 'cancel-before-decode'
                      ? 60
                      : fault === 'reordered-fetch' && unit.seq === 0
                        ? 35
                        : 0,
                  );
                  return { kind: 'audio', data: wave() };
                },
              },
              {
                onUnitStart: (unit, route) => {
                  events.push({ seq: unit.seq, route, at: performance.now() });
                  character.setState('speaking');
                },
                onUnitEnd: () => character.setState('listening'),
                onIdle: () => character.setState('listening'),
              },
            );
            const samples = new Float32Array(512);
            const rms = () => {
              monitor.getFloatTimeDomainData(samples);
              return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
            };
            const unit = (seq) => ({
              seq,
              turnId: '00000000-0000-4000-8000-000000000001',
              text: 'Synthetic non-sensitive media fixture.',
            });
            const start = performance.now();
            player.enqueue(unit(0));
            if (fault === 'reordered-fetch') player.enqueue(unit(1));
            let heardAt = null;
            let closedAt = null;
            let syncOffsetMs = null;
            const cancelledEarly = fault === 'cancel-before-decode';
            if (cancelledEarly) {
              player.stop();
              await sleep(100);
            } else {
              const deadline = performance.now() + 1500;
              while (performance.now() < deadline) {
                const level = rms();
                character.setLevels({ veir: player.level(), founder: 0 });
                if (level > 0.003) {
                  heardAt = performance.now();
                  syncOffsetMs = characterRootAudible() ? 0 : null;
                  break;
                }
                await sleep(4);
              }
              if (fault === 'interrupt-startup' || fault === 'interrupt-mid') {
                if (fault === 'interrupt-mid') await sleep(60);
                const stoppedAt = performance.now();
                player.stop();
                character.setState('listening');
                while (performance.now() - stoppedAt < 400) {
                  if (rms() < 0.0001) {
                    closedAt = performance.now() - stoppedAt;
                    break;
                  }
                  await sleep(4);
                }
                await sleep(65);
              } else {
                await sleep(fault === 'reordered-fetch' ? 700 : 350);
              }
            }
            function characterRootAudible() {
              return stage.querySelector('.fa-character')?.dataset.audible === 'true';
            }
            const failures = [];
            if (!cancelledEarly && heardAt === null) failures.push('no_signal_at_real_analyser');
            if (cancelledEarly && events.length) failures.push('cancelled_audio_started');
            if (fault.startsWith('interrupt') && (closedAt === null || closedAt > 200))
              failures.push('interruption_over_200ms');
            if (fault === 'reordered-fetch' && events.map((e) => e.seq).join(',') !== '0,1')
              failures.push('out_of_order_audio');
            if (fault.startsWith('interrupt') && characterRootAudible())
              failures.push('stale_mouth_after_stop');
            if (fault.startsWith('interrupt') && rms() > 0.0001) failures.push('stale_signal_after_stop');
            if (!cancelledEarly && syncOffsetMs === null) failures.push('mouth_not_following_signal');
            player.dispose();
            character.unmount();
            stage.remove();
            await ctx.close();
            if (ctx.state !== 'closed') failures.push('audio_context_not_closed');
            return {
              failures,
              firstSignalMs: heardAt === null ? null : heardAt - start,
              stopMs: closedAt,
              syncOffsetMs,
              sampleRate: ctx.sampleRate,
              outputLatencyEstimate: ctx.outputLatency ?? null,
              audioGraph: true,
              physicalOutput: false,
              events: events.length,
            };
          },
          { sampleRate, pattern, fault },
        );
        results.push({ id, status: result.failures.length ? 'failed' : 'passed', pattern, fault, ...result });
      } catch (error) {
        results.push({ id, status: 'failed', failures: [String(error).slice(0, 200)] });
      }
      if (results.length % 25 === 0)
        process.stdout.write(
          JSON.stringify({
            cases: results.length,
            failed: results.filter((r) => r.status === 'failed').length,
          }) + '\n',
        );
      writeFileSync(`${output}/partial.json`, JSON.stringify(results));
    }
  }
}
for (let i = 0; i < 10; i++) {
  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const tracks = stream.getTracks();
    tracks.forEach((t) => t.stop());
    return { count: tracks.length, ended: tracks.every((t) => t.readyState === 'ended') };
  });
  results.push({
    id: `CAPTURE-RELEASE-${i + 1}`,
    status: result.count > 0 && result.ended ? 'passed' : 'failed',
    fakeDevice: true,
    ...result,
  });
}
const quantile = (data, p) =>
  data.length
    ? [...data].sort((a, b) => a - b)[Math.min(data.length - 1, Math.ceil(data.length * p) - 1)]
    : null;
const stats = (key) => {
  const data = results.map((r) => r[key]).filter((v) => typeof v === 'number');
  return { n: data.length, p50: quantile(data, 0.5), p95: quantile(data, 0.95), p99: quantile(data, 0.99) };
};
const summary = {
  at: new Date().toISOString(),
  browser: await browser.version(),
  host: execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim(),
  node: process.version,
  cases: results.length,
  passed: results.filter((r) => r.status === 'passed').length,
  failed: results.filter((r) => r.status === 'failed').length,
  skipped: 0,
  blocked: 0,
  concurrency: 1,
  signalStart: stats('firstSignalMs'),
  interruptionToGraphSilence: stats('stopMs'),
  audioToMouthSameFrame: stats('syncOffsetMs'),
  boundary:
    'Synthetic WAV → real decodeAudioData → AudioBufferSourceNode → gain → analyser → fake Chromium output. Mouth sampled in the same polling callback. No acoustic loopback, accents, Bluetooth, live ASR/TTS or human listening tested.',
};
writeFileSync(`${output}/results.json`, JSON.stringify({ summary, results }, null, 2));
process.stdout.write(JSON.stringify(summary, null, 2));
await browser.close();
process.exitCode = summary.failed ? 1 : 0;
