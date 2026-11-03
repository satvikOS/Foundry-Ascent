/** Five-minute real media-graph lifecycle soak; not acoustic, provider, battery or thermal validation. */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve('../../docs/upgrade/evidence/media/soak.json');
mkdirSync(resolve(out, '..'), { recursive: true });
const browser = await chromium.launch({
  args: ['--disable-audio-output', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.route('**/upgrade-media-harness', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Foundry synthetic media harness</title>',
  }),
);
await page.goto('http://127.0.0.1:5173/upgrade-media-harness');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const samples = [];
async function sample(at) {
  samples.push({
    at,
    dom: await cdp.send('Memory.getDOMCounters'),
    metrics: (await cdp.send('Performance.getMetrics')).metrics.filter((m) =>
      ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'TaskDuration'].includes(m.name),
    ),
  });
}
await cdp.send('HeapProfiler.collectGarbage');
await sample('baseline-forced-GC');
const timer = setInterval(() => {
  void sample('during-soak').catch(() => undefined);
}, 30000);
const result = await page.evaluate(async () => {
  const playbackPath = '/src/lib/realtime/playback.ts';
  const characterPath = '/src/lib/realtime/character.ts';
  const { SpeechPlayer } = await import(playbackPath);
  const { LocalCharacter } = await import(characterPath);
  const stage = document.createElement('div');
  stage.style.cssText = 'width:320px;height:340px';
  document.body.append(stage);
  const audio = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
  await audio.resume();
  const wave = () => {
    const buffer = new ArrayBuffer(44 + 12000);
    const d = new DataView(buffer);
    const str = (at, s) => [...s].forEach((c, i) => d.setUint8(at + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    d.setUint32(4, 12036, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    d.setUint32(16, 16, true);
    d.setUint16(20, 1, true);
    d.setUint16(22, 1, true);
    d.setUint32(24, 24000, true);
    d.setUint32(28, 48000, true);
    d.setUint16(32, 2, true);
    d.setUint16(34, 16, true);
    str(36, 'data');
    d.setUint32(40, 12000, true);
    for (let i = 0; i < 6000; i++) d.setInt16(44 + i * 2, Math.sin((i / 24000) * Math.PI * 360) * 4000, true);
    return buffer;
  };
  const frameTimes = [];
  let prior = performance.now();
  let frame = 0;
  let player = null;
  let character = null;
  const animate = (now) => {
    frameTimes.push(now - prior);
    prior = now;
    character?.setLevels({ veir: player?.level() ?? 0, founder: 0 });
    frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cycles = 60;
  const started = performance.now();
  let starts = 0;
  let disposed = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    character = new LocalCharacter();
    character.mount(stage, { reducedMotion: cycle % 10 === 0 });
    player = new SpeechPlayer(
      {
        context: audio,
        synthesis: null,
        createUtterance: (t) => new SpeechSynthesisUtterance(t),
        now: () => performance.now(),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id),
        fetchSpeech: async () => ({ kind: 'audio', data: wave() }),
      },
      {
        onUnitStart: () => {
          starts++;
          character?.setState('speaking');
        },
        onUnitEnd: () => character?.setState('listening'),
        onIdle: () => character?.setState('listening'),
      },
    );
    for (let unit = 0; unit < 5; unit++) {
      player.enqueue({
        seq: unit,
        turnId: '00000000-0000-4000-8000-000000000001',
        text: 'Synthetic lifecycle fixture.',
      });
      await sleep(350);
    }
    if (cycle % 3 === 0) player.stop();
    await sleep(3250);
    player.dispose();
    player = null;
    disposed++;
    character.unmount();
    character = null;
    // No intentionally retained references to old players, SVG nodes or AudioBuffer sources.
    if (stage.childElementCount !== 0) throw new Error('presentation_node_leak');
  }
  cancelAnimationFrame(frame);
  stage.remove();
  await audio.close();
  frameTimes.sort((a, b) => a - b);
  const percentile = (p) => frameTimes[Math.ceil(frameTimes.length * p) - 1] ?? null;
  return {
    cycles,
    starts,
    disposed,
    elapsedMs: performance.now() - started,
    frames: frameTimes.length,
    frameIntervalMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    boundary:
      '60 player/character start-dispose cycles, 300 real decoded audio units, one reused AudioContext closed at end. Fake Chromium output; no physical hardware or provider validation.',
  };
});
clearInterval(timer);
await cdp.send('HeapProfiler.collectGarbage');
await sample('after-soak-forced-GC');
writeFileSync(
  out,
  JSON.stringify(
    {
      startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
      finishedAt: new Date().toISOString(),
      browser: browser.version(),
      host: process.arch,
      result,
      samples,
    },
    null,
    2,
  ),
);
process.stdout.write(JSON.stringify(result));
await browser.close();
