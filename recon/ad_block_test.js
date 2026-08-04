const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = path.join(__dirname, 'ext', 'stands-adblocker');
const USER_DATA_DIR = path.join(__dirname, '.pw-profile');

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  const page = context.pages()[0] || (await context.newPage());

  // Bootstrap access to the game singleton, same trick as before.
  await context.addInitScript(() => {
    window.__candidates = [];
    const origPush = Array.prototype.push;
    let pushCount = 0;
    Array.prototype.push = function (...args) {
      if (this === window.__candidates) return origPush.apply(this, args);
      pushCount++;
      if (pushCount < 300000 && !window.__game) {
        try {
          if (args.length && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Node)) {
            const item = args[0];
            if (item.game && item.position && item.track) {
              window.__game = item.game;
            }
          }
        } catch (e) {}
      }
      return origPush.apply(this, args);
    };
  });

  console.log('Navigating...');
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, div, a, span'));
    const exact = all.filter(el => el.children.length === 0 && (el.textContent || '').trim().toUpperCase() === 'PLAY' && el.offsetParent !== null);
    if (exact.length) { exact[0].click(); return true; }
    return false;
  });
  console.log('Clicked PLAY:', clicked);

  // Poll for window.__game to appear and for player.death to be false (i.e. actually spawned),
  // timing how long it takes. If the ad is blocked, this should be fast (a few seconds),
  // not ~30s.
  const start = Date.now();
  let spawned = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      if (!window.__game || !window.__game.player) return { hasGame: !!window.__game };
      return { hasGame: true, death: window.__game.player.death, cycle: window.__game.cycle, percent: window.__game.player.percent };
    });
    console.log(`[t=${Date.now() - start}ms]`, JSON.stringify(state));
    if (state && state.death === false) {
      spawned = true;
      break;
    }
  }
  if (!spawned) console.log('Did not detect a live (death:false) frame within poll window.');

  await page.screenshot({ path: 'recon/adblock_after_play.png' });
  console.log('Screenshot saved.');

  await page.waitForTimeout(3000);
  await context.close();
})();
