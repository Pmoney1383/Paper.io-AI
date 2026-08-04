// Q3 follow-up: Q3's Test C claimed 20000 ticks in 4ms but cycle only
// advanced by 5 - a short-circuit, not real throughput. Test B in the same
// run also showed a mismatch (3880 cycles for 500 requested ticks). Both
// tests ran sequentially in one page session after Test A, so isolate: does
// a single large batched __tickN call, in a FRESH process, with ONLY the
// clock+canvas hooks (no prior test history on the page), produce a clean
// 1:1 cycle-to-tick ratio like Q1 did without the canvas stub?
const { chromium } = require('playwright');
const { installGameHook, installClockHook, installCanvasStub } = require('./hooks');

async function testBatch(n, label) {
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

  const cycle0 = await page.evaluate(() => window.__game.cycle);
  const t0 = Date.now();
  await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n, ms: 33 });
  const wallElapsed = Date.now() - t0;
  const cycle1 = await page.evaluate(() => window.__game.cycle);
  const stopped = await page.evaluate(() => window.__game.stopped);
  const updating = await page.evaluate(() => window.__game.preparing);

  await browser.close();

  const cycleDelta = cycle1 - cycle0;
  console.log(`[${label}] requested=${n} cycleDelta=${cycleDelta} wallMs=${wallElapsed} stopped=${stopped} preparing=${updating} ratio=${(cycleDelta / n).toFixed(3)}`);
  return { n, cycleDelta, wallElapsed };
}

(async () => {
  // Small batch first (fresh process each time - no session cross-contamination)
  await testBatch(500, 'n=500 fresh');
  await testBatch(3000, 'n=3000 fresh (same size as Q1)');
  await testBatch(20000, 'n=20000 fresh (same size as Q3 Test C)');
})();
