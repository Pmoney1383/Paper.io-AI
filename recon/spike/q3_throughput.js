// Q3: real ticks/sec ceiling, per-call state-read overhead, and whether
// batching ticks+reads in one page.evaluate() call beats one call per tick.
const { chromium } = require('playwright');
const { installGameHook, installClockHook, installCanvasStub, readMinimalState } = require('./hooks');

async function setup() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.addInitScript(installClockHook);
  await page.addInitScript(installCanvasStub);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => !!(window.__game && window.__game.units && window.__game.units.length));
    if (ready) break;
    await page.waitForTimeout(200);
  }
  return { browser, page };
}

async function timeIt(label, fn) {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  console.log(`${label}: ${elapsed}ms`, result !== undefined ? JSON.stringify(result) : '');
  return elapsed;
}

(async () => {
  const { browser, page } = await setup();
  const MS_PER_TICK = 33;

  console.log('=== Test A: pure IPC round-trip overhead (no-op eval) ===');
  const N_NOOP = 500;
  const noopElapsed = await timeIt(`${N_NOOP}x separate page.evaluate(() => 1)`, async () => {
    for (let i = 0; i < N_NOOP; i++) await page.evaluate(() => 1);
  });
  console.log(`-> ${(noopElapsed / N_NOOP).toFixed(3)}ms/call round-trip overhead\n`);

  console.log('=== Test B: N ticks, one page.evaluate call PER tick ===');
  const N_TICKS_PERCALL = 500;
  const cycleB0 = await page.evaluate(() => window.__game.cycle);
  const perCallElapsed = await timeIt(`${N_TICKS_PERCALL}x separate page.evaluate(tick)`, async () => {
    for (let i = 0; i < N_TICKS_PERCALL; i++) await page.evaluate((ms) => window.__tick(ms), MS_PER_TICK);
  });
  const cycleB1 = await page.evaluate(() => window.__game.cycle);
  const perCallTps = N_TICKS_PERCALL / (perCallElapsed / 1000);
  console.log(`-> ${perCallTps.toFixed(0)} ticks/sec (one page.evaluate per tick); cycle delta = ${cycleB1 - cycleB0} (expect ~${N_TICKS_PERCALL})\n`);

  console.log('=== Test C: N ticks batched into ONE page.evaluate call ===');
  const N_TICKS_BATCH = 20000;
  const cycleC0 = await page.evaluate(() => window.__game.cycle);
  const batchElapsed = await timeIt(`1x page.evaluate(tickN(${N_TICKS_BATCH}))`, async () => {
    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: N_TICKS_BATCH, ms: MS_PER_TICK });
  });
  const cycleC1 = await page.evaluate(() => window.__game.cycle);
  const stoppedC = await page.evaluate(() => window.__game.stopped);
  const cycleDeltaC = cycleC1 - cycleC0;
  const batchTps = N_TICKS_BATCH / (batchElapsed / 1000);
  const batchTpsActual = cycleDeltaC / (batchElapsed / 1000);
  console.log(`-> ${batchTps.toFixed(0)} ticks/sec claimed (calls/sec); cycle delta = ${cycleDeltaC} (expect ~${N_TICKS_BATCH})`);
  console.log(`-> ${batchTpsActual.toFixed(0)} ticks/sec ACTUAL (cycle-verified); game.stopped = ${stoppedC}`);
  if (cycleDeltaC < N_TICKS_BATCH * 0.9) {
    console.log(`!! WARNING: cycle delta (${cycleDeltaC}) is far below requested tick count (${N_TICKS_BATCH}) - loop() is short-circuiting after some point, this batched number is NOT real throughput.\n`);
  } else {
    console.log('cycle delta matches requested ticks - genuine throughput confirmed.\n');
  }

  console.log('=== Test D: per-call state-read cost ===');
  const N_READS = 500;
  const readElapsed = await timeIt(`${N_READS}x page.evaluate(readMinimalState)`, async () => {
    for (let i = 0; i < N_READS; i++) await page.evaluate(readMinimalState);
  });
  console.log(`-> ${(readElapsed / N_READS).toFixed(3)}ms/call for tick+read combined overhead vs ${(noopElapsed / N_NOOP).toFixed(3)}ms/call baseline no-op\n`);

  console.log('=== Test E: tick+read interleaved, one call each (realistic env.step() shape) ===');
  const N_STEP = 500;
  const cycleE0 = await page.evaluate(() => window.__game.cycle);
  const stepElapsed = await timeIt(`${N_STEP}x (tick then read, 2 calls each)`, async () => {
    for (let i = 0; i < N_STEP; i++) {
      await page.evaluate((ms) => window.__tick(ms), MS_PER_TICK);
      await page.evaluate(readMinimalState);
    }
  });
  const cycleE1 = await page.evaluate(() => window.__game.cycle);
  const stepTps = N_STEP / (stepElapsed / 1000);
  console.log(`-> ${stepTps.toFixed(0)} env-steps/sec if tick and read are separate calls; cycle delta = ${cycleE1 - cycleE0} (expect ~${N_STEP})\n`);

  console.log('=== Test F: tick+read fused into a single page.evaluate call (batched step) ===');
  const N_FUSED = 500;
  const cycleF0 = await page.evaluate(() => window.__game.cycle);
  const fusedElapsed = await timeIt(`${N_FUSED}x fused tick+read in one call`, async () => {
    for (let i = 0; i < N_FUSED; i++) {
      await page.evaluate((ms) => {
        window.__tick(ms);
        const g = window.__game;
        const p = g.player;
        return p ? { alive: !p.death, percent: p.percent, x: p.position.x, y: p.position.y, cycle: g.cycle } : { ready: false };
      }, MS_PER_TICK);
    }
  });
  const cycleF1 = await page.evaluate(() => window.__game.cycle);
  const fusedTps = N_FUSED / (fusedElapsed / 1000);
  console.log(`-> ${fusedTps.toFixed(0)} env-steps/sec if tick+read are fused into one call; cycle delta = ${cycleF1 - cycleF0} (expect ~${N_FUSED})\n`);

  await browser.close();

  console.log('=== Summary ===');
  console.log(`IPC round-trip overhead:            ${(noopElapsed / N_NOOP).toFixed(3)} ms/call`);
  console.log(`Ticks/sec, 1 call per tick:          ${perCallTps.toFixed(0)}`);
  console.log(`Ticks/sec, batched (1 call for ${N_TICKS_BATCH}): ${batchTps.toFixed(0)}`);
  console.log(`Batching speedup:                    ${(batchTps / perCallTps).toFixed(1)}x`);
  console.log(`env-steps/sec, tick+read as 2 calls:  ${stepTps.toFixed(0)}`);
  console.log(`env-steps/sec, tick+read fused:       ${fusedTps.toFixed(0)}`);
  console.log(`Fusing speedup:                       ${(fusedTps / stepTps).toFixed(1)}x`);
  console.log(`\nAt ${MS_PER_TICK}ms simulated per tick, batched ticks/sec of ${batchTps.toFixed(0)} = ${(batchTps * MS_PER_TICK / 1000).toFixed(1)}x real-time simulated-seconds-per-wall-second on this single headless instance.`);
})();
