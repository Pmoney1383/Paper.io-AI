// Q1: can the sim be decoupled from wall-clock time?
//
// Method: measure how far a bot unit travels (px) per real elapsed ms in two
// conditions:
//   (a) baseline - untouched engine, real rAF, real performance.now
//   (b) override - performance.now is a manually-advanced virtual clock,
//       rAF is neutralized, and we drive the sim via window.__tickN(n, ms)
//       calling game.loop() directly.
// If (b)'s px-traveled-per-real-elapsed-ms is meaningfully greater than
// (a)'s, the clock is genuinely decoupled, not just spinning a counter.
const { chromium } = require('playwright');
const { installGameHook, installClockHook } = require('./hooks');

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

async function waitForUnit(page) {
  for (let i = 0; i < 40; i++) {
    const u = await page.evaluate(() => {
      const g = window.__game;
      if (!g || !g.units || !g.units.length) return null;
      const u = g.units[0];
      return { x: u.position.x, y: u.position.y };
    });
    if (u) return u;
    await page.waitForTimeout(250);
  }
  throw new Error('window.__game.units[0] never appeared');
}

async function runBaseline() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });

  const p0 = await waitForUnit(page);
  const cycle0 = await page.evaluate(() => window.__game.cycle);
  const wallStart = Date.now();
  await page.waitForTimeout(3000);
  const wallElapsed = Date.now() - wallStart;
  const p1 = await page.evaluate(() => {
    const u = window.__game.units[0];
    return { x: u.position.x, y: u.position.y };
  });
  const cycle1 = await page.evaluate(() => window.__game.cycle);

  await browser.close();
  const d = dist(p0, p1);
  return { wallElapsedMs: wallElapsed, distancePx: d, pxPerRealMs: d / wallElapsed, cycleDelta: cycle1 - cycle0, cyclesPerRealMs: (cycle1 - cycle0) / wallElapsed };
}

async function runOverride() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.addInitScript(installClockHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });

  const p0 = await waitForUnit(page);
  const cycle0 = await page.evaluate(() => window.__game.cycle);

  const N = 3000;    // number of ticks
  const MS = 33;      // simulated ms per tick (~30fps step)
  const simulatedMs = N * MS;

  const wallStart = Date.now();
  await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: N, ms: MS });
  const wallElapsed = Date.now() - wallStart;

  const p1 = await page.evaluate(() => {
    const u = window.__game.units[0];
    return { x: u.position.x, y: u.position.y };
  });
  const cycle1 = await page.evaluate(() => window.__game.cycle);

  await browser.close();
  const d = dist(p0, p1);
  return {
    wallElapsedMs: wallElapsed,
    simulatedMs,
    distancePx: d,
    pxPerRealMs: d / wallElapsed,
    pxPerSimulatedMs: d / simulatedMs,
    speedupVsWallClock: simulatedMs / wallElapsed,
    cycleDelta: cycle1 - cycle0,
    cyclesPerRealMs: (cycle1 - cycle0) / wallElapsed,
  };
}

(async () => {
  console.log('--- Baseline (real wall-clock, untouched engine) ---');
  const baseline = await runBaseline();
  console.log(JSON.stringify(baseline, null, 2));

  console.log('\n--- Override (virtual clock, direct loop() pumping) ---');
  const override = await runOverride();
  console.log(JSON.stringify(override, null, 2));

  console.log('\n--- Verdict ---');
  console.log(`Baseline: ${baseline.pxPerRealMs.toFixed(4)} px / real-ms`);
  console.log(`Override: ${override.pxPerRealMs.toFixed(4)} px / real-ms`);
  console.log(`Simulated-time speedup vs wall-clock: ${override.speedupVsWallClock.toFixed(1)}x`);
  console.log(`\nBaseline cycles/real-ms: ${baseline.cyclesPerRealMs.toFixed(4)} (${baseline.cycleDelta} cycles / ${baseline.wallElapsedMs}ms)`);
  console.log(`Override cycles/real-ms: ${override.cyclesPerRealMs.toFixed(4)} (${override.cycleDelta} cycles / ${override.wallElapsedMs}ms)`);
  console.log(`Cycle-count speedup: ${(override.cyclesPerRealMs / baseline.cyclesPerRealMs).toFixed(1)}x (this is the noise-free proof: cycle is a monotonic fixed-timestep tick counter, unaffected by a wandering bot's path doubling back on itself)`);
})();
