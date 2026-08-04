// Before wiring a discrete(4) action space into the gym env: does
// dispatching real keyboard events (ArrowUp/Down/Left/Right) via Playwright
// actually change game.player.direction / position, or does the game only
// respond to mouse-based steering? Verify empirically.
const { chromium } = require('playwright');
const { installGameHook, installClockHook, resetWorld } = require('./hooks');

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
  await page.evaluate(resetWorld);

  const before = await page.evaluate(() => ({ x: window.__game.player.position.x, y: window.__game.player.position.y, direction: window.__game.player.direction }));
  console.log('Before any key:', JSON.stringify(before));

  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  for (const key of keys) {
    await page.keyboard.down(key);
    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 30, ms: 33 });
    const state = await page.evaluate(() => ({
      x: window.__game.player.position.x,
      y: window.__game.player.position.y,
      direction: window.__game.player.direction,
      alive: !window.__game.player.death,
      cycle: window.__game.cycle,
    }));
    await page.keyboard.up(key);
    console.log(`After holding ${key} for 30 ticks:`, JSON.stringify(state));
    if (!state.alive) {
      console.log('  Player died - respawning to continue test');
      await page.evaluate(() => window.__game.spawnPlayer());
    }
  }

  await browser.close();
})();
