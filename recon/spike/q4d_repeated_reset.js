// Q4 follow-up: does calling spawnPlayer() repeatedly (simulating many RL
// episode resets) leak entries into game.units, or does the engine properly
// replace/reuse the player slot? Also check game.kill()/gameOver() as the
// "end episode early" counterpart to spawnPlayer() as "start episode".
const { chromium } = require('playwright');
const { installGameHook } = require('./hooks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);

  const results = await page.evaluate(() => {
    const g = window.__game;
    const log = [];
    for (let i = 0; i < 5; i++) {
      g.spawnPlayer();
      log.push({
        iter: i,
        unitCount: g.units.length,
        playerAlive: !g.player.death,
        playerX: g.player.position.x,
        playerY: g.player.position.y,
      });
    }
    return log;
  });

  console.log('Repeated spawnPlayer() calls (no kill in between):');
  console.log(JSON.stringify(results, null, 2));

  const killTest = await page.evaluate(() => {
    const g = window.__game;
    const out = { hasKill: typeof g.kill === 'function', hasGameOver: typeof g.gameOver === 'function' };
    try {
      g.kill(g.player);
      out.killThrew = false;
      out.deathAfterKill = g.player.death;
    } catch (e) {
      out.killThrew = true;
      out.killError = e.message;
    }
    // respawn after kill
    try {
      g.spawnPlayer();
      out.aliveAfterRespawn = !g.player.death;
      out.unitCountAfterRespawn = g.units.length;
    } catch (e) {
      out.respawnError = e.message;
    }
    return out;
  });
  console.log('\nkill() + spawnPlayer() cycle:');
  console.log(JSON.stringify(killTest, null, 2));

  await browser.close();

  console.log('\n=== Verdict ===');
  const counts = results.map(r => r.unitCount);
  const stable = counts.every(c => c === counts[0]);
  console.log(stable
    ? `unitCount stayed constant at ${counts[0]} across 5 spawnPlayer() calls - no leak, safe for repeated reset().`
    : `unitCount changed across calls (${counts.join(', ')}) - spawnPlayer() may be leaking unit entries, needs a cleanup step in reset().`);
})();
