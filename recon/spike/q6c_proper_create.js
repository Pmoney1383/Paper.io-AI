// Static analysis found the SITE'S OWN full-world-rebuild sequence (runs
// when navigating back to the menu):
//   api.game.stopped = true;
//   api.create(view.canvas);   // <- the arg we were missing; view.canvas is
//                                  probably the <canvas id="view"> element
//   api.prepare(() => { ... }); // gradually spawns bases/bots via setInterval
// Replicate it properly this time, with the real canvas element as the arg,
// and verify with real before/after numbers.
const { chromium } = require('playwright');
const { installGameHook, installClockHook, snapshotWorld } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.addInitScript(installClockHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => !!(window.__game && window.__game.units && window.__game.units.length));
    if (ready) break;
    await page.waitForTimeout(200);
  }

  await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 300, ms: 33 });
  const before = await page.evaluate(snapshotWorld);
  console.log('BEFORE reset: cycle=%d cellsPointCount=%d unitCount=%d', before.cycle, before.cellsPointCount, before.unitCount);
  console.log('  bot[0] baseSquare=%s', before.units.find(u => !u.isPlayer)?.baseSquare);

  const attempt = await page.evaluate(() => {
    const api = window.paperio2api;
    const canvas = document.getElementById('view') || document.querySelector('canvas');
    const oldGame = api.game;
    let threw = null;
    try {
      oldGame.stopped = true;
      api.create(canvas);
    } catch (e) {
      threw = 'create: ' + e.message;
    }
    return { threw, canvasFound: !!canvas, newGameIsDifferentObject: api.game !== oldGame };
  });
  console.log('\nReset attempt:', JSON.stringify(attempt, null, 2));

  if (!attempt.threw) {
    // Give prepare() a moment to run its setInterval-driven base/bot spawn,
    // then read state directly off paperio2api.game (our push-hook still
    // points at the OLD instance - that's a separate, expected limitation).
    const prepareResult = await page.evaluate(() => new Promise((resolve) => {
      window.paperio2api.prepare(() => resolve('prepare callback fired'));
      setTimeout(() => resolve('timed out waiting for prepare callback'), 5000);
    }));
    console.log('prepare() result:', prepareResult);

    const afterPrepare = await page.evaluate(() => {
      const g = window.paperio2api.game;
      const cells = g.space && g.space.cells ? g.space.cells : [];
      let cellsPointCount = 0;
      for (const c of cells) cellsPointCount += (c && c.points ? c.points.length : 0);
      return {
        cycle: g.cycle,
        unitCount: g.units ? g.units.length : null,
        cellsPointCount,
        hasPlayer: !!g.player,
        botBaseSquares: (g.units || []).map(u => u.base ? u.base.square : null),
      };
    });
    console.log('\nAFTER create()+prepare():', JSON.stringify(afterPrepare, null, 2));
  }

  await browser.close();
})();
