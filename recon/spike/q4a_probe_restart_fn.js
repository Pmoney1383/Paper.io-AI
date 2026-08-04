// Q4 (attempt 1): does window.__game (or something reachable from it) expose
// a direct start/restart/spawn function we could call instead of clicking
// PLAY and sitting through the ad gate?
const { chromium } = require('playwright');
const { installGameHook } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  const report = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return { hasGame: false };

    function methodNames(obj) {
      const names = new Set();
      let o = obj;
      let depth = 0;
      while (o && depth < 4) {
        for (const k of Object.getOwnPropertyNames(o)) {
          try { if (typeof obj[k] === 'function') names.add(k); } catch (e) {}
        }
        o = Object.getPrototypeOf(o);
        depth++;
      }
      return Array.from(names);
    }

    const gameMethods = methodNames(g);
    const re = /start|restart|spawn|reset|new|begin|play|respawn/i;
    const candidates = gameMethods.filter(m => re.test(m));

    // Also check window.__game.player's methods, and any manager objects
    // that might own the "create a new round" responsibility.
    const playerMethods = g.player ? methodNames(g.player) : [];
    const playerCandidates = playerMethods.filter(m => re.test(m));

    return {
      hasGame: true,
      allGameMethods: gameMethods.sort(),
      restartCandidates: candidates,
      allPlayerMethods: playerMethods.sort(),
      playerRestartCandidates: playerCandidates,
    };
  });

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
