// Q4 (attempt 1, continued): can we call window.__game.spawnPlayer() directly
// to start a round, entirely bypassing the PLAY button and its ad gate?
const { chromium } = require('playwright');
const { installGameHook } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);

  const before = await page.evaluate(() => ({
    hasPlayer: !!window.__game.player,
    arity: window.__game.spawnPlayer.length,
    fnSource: window.__game.spawnPlayer.toString().slice(0, 300),
  }));
  console.log('Before spawnPlayer() call:', JSON.stringify(before, null, 2));

  const callResult = await page.evaluate(() => {
    try {
      const ret = window.__game.spawnPlayer();
      return { threw: false, returned: JSON.stringify(ret) };
    } catch (e) {
      return { threw: true, error: e.message, stack: e.stack.slice(0, 500) };
    }
  });
  console.log('\nCall result:', JSON.stringify(callResult, null, 2));

  await page.waitForTimeout(500);

  const after = await page.evaluate(() => {
    const g = window.__game;
    if (!g.player) return { hasPlayer: false };
    return {
      hasPlayer: true,
      alive: !g.player.death,
      x: g.player.position.x,
      y: g.player.position.y,
      percent: g.player.percent,
      unitCount: g.units.length,
    };
  });
  console.log('\nAfter spawnPlayer() call:', JSON.stringify(after, null, 2));

  await page.screenshot({ path: 'recon/spike/q4b_after_spawn.png' });
  await browser.close();

  console.log('\n=== Verdict ===');
  console.log(after.hasPlayer && after.alive ? 'spawnPlayer() successfully created a live player unit with ZERO DOM interaction and ZERO ad exposure.' : 'spawnPlayer() did not produce a live player - needs further investigation.');
})();
