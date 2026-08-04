// Diagnose the mismatch (cycle jumps by way more than requested tick count)
// seen when there's a real-wall-clock wait BEFORE the batched tick call.
// Hypothesis: something other than requestAnimationFrame (e.g. a
// setInterval-based background-tab fallback) is also driving game.loop(),
// using real elapsed time our performance.now override doesn't touch.
const { chromium } = require('playwright');
const { installGameHook, installClockHook } = require('./hooks');

async function run(neutralizeTimers, waitMs) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.addInitScript(installClockHook);
  if (neutralizeTimers) {
    await page.addInitScript(() => {
      window.setInterval = () => 0;
      window.setTimeout = () => 0;
    });
  }
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });

  // simulate the "wait for game ready" polling period that real test/env
  // code does - this is real wall-clock waiting.
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => !!(window.__game && window.__game.units && window.__game.units.length));
    if (ready) break;
    await page.waitForTimeout(200);
  }

  const cycleAfterWait = await page.evaluate(() => window.__game.cycle);
  // extra deliberate real wait, to make any leak obvious
  await page.waitForTimeout(waitMs);
  const cycleAfterExtraWait = await page.evaluate(() => window.__game.cycle);

  const N = 500;
  await page.evaluate((n) => window.__tickN(n, 33), N);
  const cycleFinal = await page.evaluate(() => window.__game.cycle);

  await browser.close();
  return {
    neutralizeTimers,
    waitMs,
    cycleAfterWait,
    cycleAfterExtraWait,
    leakDuringExtraWait: cycleAfterExtraWait - cycleAfterWait,
    requestedTicks: N,
    actualTicksDuringBatch: cycleFinal - cycleAfterExtraWait,
  };
}

(async () => {
  console.log('--- Baseline: timers NOT neutralized, 3s extra real wait before batch ---');
  console.log(JSON.stringify(await run(false, 3000), null, 2));

  console.log('\n--- With setInterval/setTimeout neutralized, 3s extra real wait before batch ---');
  console.log(JSON.stringify(await run(true, 3000), null, 2));
})();
