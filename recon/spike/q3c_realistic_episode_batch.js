// Q3 headline number: throughput for a batch size matching a realistic RL
// episode length (a paper.io round rarely runs past a minute or two of
// simulated time), fresh process, cycle-verified.
const { chromium } = require('playwright');
const { installGameHook, installClockHook, installCanvasStub } = require('./hooks');

async function testBatch(n) {
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
  // spawn an actual player, since that's the real usage pattern (not just bots)
  await page.evaluate(() => window.__game.spawnPlayer());

  const cycle0 = await page.evaluate(() => window.__game.cycle);
  const t0 = Date.now();
  await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n, ms: 33 });
  const wallElapsed = Date.now() - t0;
  const cycle1 = await page.evaluate(() => window.__game.cycle);
  const finalState = await page.evaluate(() => {
    const g = window.__game;
    return { alive: !g.player.death, percent: g.player.percent };
  });

  await browser.close();
  const cycleDelta = cycle1 - cycle0;
  return { n, cycleDelta, wallElapsed, ratio: cycleDelta / n, ticksPerSec: cycleDelta / (wallElapsed / 1000), finalState };
}

(async () => {
  // ~2000 ticks * 33ms = 66 simulated seconds, a realistic single-round length
  const r = await testBatch(2000);
  console.log(JSON.stringify(r, null, 2));
  console.log(`\n${r.ticksPerSec.toFixed(0)} ticks/sec (cycle-verified, ratio=${r.ratio.toFixed(3)}) for a realistic ${(2000 * 33 / 1000).toFixed(0)}s-episode-length batch, with player spawned via direct function call (no PLAY click, no ad).`);
})();
