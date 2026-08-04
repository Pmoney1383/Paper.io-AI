// Sanity check before Q1-Q3: does window.__game become available (with a
// live player/units) just from navigating, without ever clicking PLAY? If
// so, Q1-Q3 don't need to touch the ad gate at all and can run headless.
const { chromium } = require('playwright');
const { installGameHook } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return { hasGame: false };
    return {
      hasGame: true,
      hasLoop: typeof g.loop === 'function',
      hasPlayer: !!g.player,
      unitCount: g.units ? g.units.length : null,
      cycle: g.cycle,
      visible: g.visible,
      stopped: g.stopped,
    };
  });
  console.log('Attract-mode game object:', JSON.stringify(info, null, 2));
  await browser.close();
})();
