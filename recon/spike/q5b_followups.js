// Two gaps left by q5_reset_semantics.js:
//   1. The RNG-reproducibility check reused one session across two
//      spawnPlayer() calls, so world state (not just RNG) differed between
//      them - not a clean test. Redo with two FRESH, isolated sessions.
//   2. No bot happened to die during that run, so "does a dead bot's state
//      persist/reset across spawnPlayer()?" is untested. Force a kill and
//      check.
const { chromium } = require('playwright');
const { installGameHook, installClockHook, snapshotWorld } = require('./hooks');

function mulberry32Source() {
  return function mulberry32(seed) {
    let a = seed >>> 0;
    return function (max) {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return max == null ? f : Math.floor(f * max);
    };
  };
}

async function freshSpawnWithSeed(seed) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => !!(window.__game && window.__game.units && window.__game.units.length));
    if (ready) break;
    await page.waitForTimeout(200);
  }
  const result = await page.evaluate(({ seed, mulberry32Str }) => {
    const mulberry32 = eval(`(${mulberry32Str})`);
    const g = window.__game;
    g.rng = mulberry32(seed);
    g.spawnPlayer();
    return { x: g.player.position.x, y: g.player.position.y, cycle: g.cycle };
  }, { seed, mulberry32Str: mulberry32Source().toString() });
  await browser.close();
  return result;
}

async function deadBotPersistence() {
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

  // Let bots build up some real state first.
  await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 300, ms: 33 });

  const beforeKill = await page.evaluate(snapshotWorld);
  const targetIndex = beforeKill.units.findIndex((u) => !u.isPlayer && u.alive);

  const killResult = await page.evaluate((idx) => {
    const g = window.__game;
    const target = g.units[idx];
    const before = { alive: !target.death, percent: target.percent, baseSquare: target.base ? target.base.square : null };
    g.kill(target);
    const after = { alive: !target.death, percent: target.percent, baseSquare: target.base ? target.base.square : null };
    return { targetIndex: idx, before, after };
  }, targetIndex);

  const afterKillSnapshot = await page.evaluate(snapshotWorld);

  // Now spawn the player (simulating an env.reset()) and see what happened
  // to that specific dead unit's slot.
  await page.evaluate(() => window.__game.spawnPlayer());
  const afterSpawnSnapshot = await page.evaluate(snapshotWorld);

  await browser.close();

  return { targetIndex, killResult, beforeKillUnitCount: beforeKill.unitCount, afterKillUnitCount: afterKillSnapshot.unitCount, afterSpawnUnitCount: afterSpawnSnapshot.unitCount, targetUnitAfterKill: afterKillSnapshot.units[targetIndex], targetUnitAfterSpawn: afterSpawnSnapshot.units[targetIndex] };
}

(async () => {
  console.log('=== RNG reproducibility, properly isolated (fresh session per trial) ===\n');
  const runA = await freshSpawnWithSeed(12345);
  const runB = await freshSpawnWithSeed(12345);
  const runC = await freshSpawnWithSeed(99999);
  console.log('Run A (seed=12345):', JSON.stringify(runA));
  console.log('Run B (seed=12345):', JSON.stringify(runB));
  console.log('Run C (seed=99999):', JSON.stringify(runC));
  const aEqualsB = runA.x === runB.x && runA.y === runB.y;
  const aEqualsC = runA.x === runC.x && runA.y === runC.y;
  console.log(`\nSame seed (A vs B) reproducible: ${aEqualsB}`);
  console.log(`Different seed (A vs C) differs: ${!aEqualsC}`);

  console.log('\n=== Dead bot persistence across spawnPlayer() ===\n');
  const deadBot = await deadBotPersistence();
  console.log(JSON.stringify(deadBot, null, 2));
})();
