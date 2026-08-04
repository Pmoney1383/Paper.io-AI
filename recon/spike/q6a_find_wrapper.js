// Static analysis of app2.js found: window[X] = wrapperObject, where
// wrapperObject is the return value of a factory closure that builds a
// brand-new spatial hash grid, border, and `game` instance, and exposes a
// .create() method to do it all again. Find X at runtime by scanning window
// for an object shaped like { create: fn, game: <the same object as our
// window.__game>, preparing, ... }.
const { chromium } = require('playwright');
const { installGameHook } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => !!(window.__game && window.__game.units && window.__game.units.length));
    if (ready) break;
    await page.waitForTimeout(200);
  }

  const found = await page.evaluate(() => {
    const hits = [];
    for (const k of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[k];
        if (v && typeof v === 'object' && typeof v.create === 'function' && 'game' in v) {
          hits.push({
            key: k,
            isSameGame: v.game === window.__game,
            keys: Object.keys(v),
          });
        }
      } catch (e) { /* cross-origin frame or similar - skip */ }
    }
    return hits;
  });

  console.log('Candidates found on window:', JSON.stringify(found, null, 2));
  await browser.close();
})();
