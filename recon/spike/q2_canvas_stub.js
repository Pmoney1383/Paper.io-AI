// Q2: can rendering be eliminated?
// Stub every CanvasRenderingContext2D drawing method to a no-op, run the
// attract-mode sim for a while (driven by the real clock this time — we only
// want to isolate the canvas variable, not compound it with Q1), and check:
//   1. does simulation still progress (cycle count advances, units move)?
//   2. were any pixel-readback methods (getImageData/isPointInPath/
//      isPointInStroke/toDataURL) ever called?
const { chromium } = require('playwright');
const { installGameHook, installCanvasStub } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.addInitScript(installCanvasStub);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });

  // wait for game + at least one unit
  let before = null;
  for (let i = 0; i < 40; i++) {
    before = await page.evaluate(() => {
      const g = window.__game;
      if (!g || !g.units || !g.units.length) return null;
      const u = g.units[0];
      return { x: u.position.x, y: u.position.y, cycle: g.cycle };
    });
    if (before) break;
    await page.waitForTimeout(250);
  }
  if (!before) throw new Error('game never appeared with canvas stubbed');

  await page.waitForTimeout(3000);

  const after = await page.evaluate(() => {
    const g = window.__game;
    const u = g.units[0];
    return { x: u.position.x, y: u.position.y, cycle: g.cycle, percent: g.player ? g.player.percent : null, unitCount: g.units.length };
  });

  const readCalls = await page.evaluate(() => window.__canvasReadCalls);
  const drawCallCounts = await page.evaluate(() => window.__canvasCallCounts);
  const totalDrawCallsSuppressed = Object.values(drawCallCounts).reduce((a, b) => a + b, 0);

  const dist = Math.hypot(after.x - before.x, after.y - before.y);

  await browser.close();

  console.log('=== Canvas-stubbed run ===');
  console.log('Before:', before);
  console.log('After:', after);
  console.log('Distance moved with canvas fully stubbed:', dist.toFixed(2), 'px');
  console.log('Cycles advanced:', after.cycle - before.cycle);
  console.log('unitCount stayed at', after.unitCount, '(expect 15+ - confirms bot AI/spawning kept working)');
  console.log('\nDraw calls suppressed (no-oped) over 3s:', totalDrawCallsSuppressed);
  console.log('Pixel-readback calls actually invoked (should all be 0):', JSON.stringify(readCalls));

  console.log('\n=== Verdict ===');
  const simOk = dist > 0 && (after.cycle - before.cycle) > 0;
  const noReadback = Object.values(readCalls).every(v => v === 0);
  console.log(simOk ? 'Simulation progressed normally with canvas fully stubbed.' : 'Simulation appears BROKEN with canvas stubbed.');
  console.log(noReadback ? 'No pixel-readback calls detected - canvas is write-only from the engine\'s perspective.' : 'WARNING: pixel-readback calls detected, stubbing draw methods is not safe as-is.');
})();
