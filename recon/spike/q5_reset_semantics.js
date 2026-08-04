// What does spawnPlayer() actually reset, vs merely not break?
// Q1: world geometry (space.cells / territory / trail) - persists or clears?
// Q2: game.cycle - resets or keeps climbing?
// Q3: bot state (including dead bots) - resets or continues?
// Q4: spawn position variety - fixed or varied? does passing args change it?
// Q5 (synthesized from 1-3): recommendation for env.reset()
// Bonus: is there an accessible/seedable RNG?
const { chromium } = require('playwright');
const { installGameHook, installClockHook, snapshotWorld } = require('./hooks');

const TICKS_PER_ROUND = 300;
const MS_PER_TICK = 33;

async function main() {
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

  console.log('======================================================');
  console.log('Q1-3: world geometry / cycle / bot state across 3 rounds');
  console.log('======================================================\n');

  const rounds = [];
  for (let round = 1; round <= 3; round++) {
    const before = await page.evaluate(snapshotWorld);
    await page.evaluate(() => window.__game.spawnPlayer());
    const immediatelyAfterSpawn = await page.evaluate(snapshotWorld);
    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: TICKS_PER_ROUND, ms: MS_PER_TICK });
    const afterTicks = await page.evaluate(snapshotWorld);
    rounds.push({ round, before, immediatelyAfterSpawn, afterTicks });

    console.log(`--- Round ${round} ---`);
    console.log(`BEFORE spawnPlayer():        cycle=${before.cycle} unitCount=${before.unitCount} cellsPointCount=${before.cellsPointCount} nonEmptyCells=${before.nonEmptyCells}`);
    console.log(`IMMEDIATELY AFTER spawnPlayer(): cycle=${immediatelyAfterSpawn.cycle} unitCount=${immediatelyAfterSpawn.unitCount} cellsPointCount=${immediatelyAfterSpawn.cellsPointCount} nonEmptyCells=${immediatelyAfterSpawn.nonEmptyCells}`);
    console.log(`  player: x=${immediatelyAfterSpawn.player.x.toFixed(1)} y=${immediatelyAfterSpawn.player.y.toFixed(1)} percent=${immediatelyAfterSpawn.player.percent}`);
    console.log(`AFTER ${TICKS_PER_ROUND} ticks:          cycle=${afterTicks.cycle} unitCount=${afterTicks.unitCount} cellsPointCount=${afterTicks.cellsPointCount} nonEmptyCells=${afterTicks.nonEmptyCells}`);
    console.log(`  player: x=${afterTicks.player.x.toFixed(1)} y=${afterTicks.player.y.toFixed(1)} percent=${afterTicks.player.percent}`);

    // Bot-level detail: show every non-player unit's alive/percent/baseSquare
    console.log(`  bots after ticks (index, alive, percent, baseSquare):`);
    for (const u of afterTicks.units) {
      if (u.isPlayer) continue;
      console.log(`    [${u.index}] alive=${u.alive} percent=${u.percent != null ? u.percent.toFixed(6) : null} baseSquare=${u.baseSquare != null ? u.baseSquare.toFixed(1) : null}`);
    }
    console.log();
  }

  console.log('======================================================');
  console.log('Cross-round comparison (does spawnPlayer() clear anything?)');
  console.log('======================================================\n');
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const spawnDeltaCells = r.immediatelyAfterSpawn.cellsPointCount - r.before.cellsPointCount;
    const spawnDeltaUnits = r.immediatelyAfterSpawn.unitCount - r.before.unitCount;
    const spawnDeltaCycle = r.immediatelyAfterSpawn.cycle - r.before.cycle;
    console.log(`Round ${r.round}: spawnPlayer() itself changed cellsPointCount by ${spawnDeltaCells}, unitCount by ${spawnDeltaUnits}, cycle by ${spawnDeltaCycle}`);
  }
  console.log();
  console.log(`Cycle across rounds (should keep climbing if never reset): ${rounds.map(r => r.before.cycle).join(' -> ')} -> ${rounds[rounds.length - 1].afterTicks.cycle}`);
  console.log(`cellsPointCount across rounds (persists if it only grows): ${rounds.map(r => r.before.cellsPointCount).join(' -> ')} -> ${rounds[rounds.length - 1].afterTicks.cellsPointCount}`);

  console.log('\n======================================================');
  console.log('Q4: spawn position variety (10 calls, zero ticks between)');
  console.log('======================================================\n');
  const positions = await page.evaluate(() => {
    const g = window.__game;
    const out = [];
    for (let i = 0; i < 10; i++) {
      g.spawnPlayer();
      out.push({ x: g.player.position.x, y: g.player.position.y });
    }
    return out;
  });
  positions.forEach((p, i) => console.log(`  call ${i}: x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}`));
  const uniqueCount = new Set(positions.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size;
  console.log(`Unique positions: ${uniqueCount} / ${positions.length}`);

  console.log('\n--- spawnPlayer(x, y, z) with explicit args ---');
  const explicitArgTest = await page.evaluate(() => {
    const g = window.__game;
    const before = { x: g.player.position.x, y: g.player.position.y };
    let threw = null;
    try {
      g.spawnPlayer(500, 500, undefined);
    } catch (e) { threw = e.message; }
    const after = { x: g.player.position.x, y: g.player.position.y };
    return { before, after, threw };
  });
  console.log(JSON.stringify(explicitArgTest, null, 2));

  console.log('\n--- game.getSpawnPosition() called directly, a few times ---');
  const spawnPositionCalls = await page.evaluate(() => {
    const g = window.__game;
    const out = [];
    for (let i = 0; i < 5; i++) {
      try {
        out.push(g.getSpawnPosition());
      } catch (e) {
        out.push({ error: e.message });
      }
    }
    return out;
  });
  console.log(JSON.stringify(spawnPositionCalls, null, 2));

  console.log('\n======================================================');
  console.log('Bonus: RNG accessibility and seedability');
  console.log('======================================================\n');
  const rngInfo = await page.evaluate(() => {
    const g = window.__game;
    const out = { hasRng: typeof g.rng === 'function', seedField: g.seed };
    if (out.hasRng) {
      out.sampleCalls = [g.rng(), g.rng(), g.rng()];
      out.sampleCallsWithMax = [g.rng(100), g.rng(100), g.rng(100)];
    }
    return out;
  });
  console.log('Native rng:', JSON.stringify(rngInfo, null, 2));

  // Can we override game.rng with our own deterministic generator and get
  // reproducible spawnPlayer() outcomes across two independent overrides
  // seeded identically?
  const reproducibilityTest = await page.evaluate(() => {
    function mulberry32(seed) {
      let a = seed >>> 0;
      return function (max) {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        return max == null ? f : Math.floor(f * max);
      };
    }
    const g = window.__game;
    const runs = [];
    for (let run = 0; run < 2; run++) {
      g.rng = mulberry32(12345); // same seed both runs
      g.spawnPlayer();
      runs.push({ x: g.player.position.x, y: g.player.position.y });
    }
    return runs;
  });
  console.log('\nOverride game.rng with a seeded generator (seed=12345), spawnPlayer() x2:');
  console.log(JSON.stringify(reproducibilityTest, null, 2));
  const reproducible = reproducibilityTest[0].x === reproducibilityTest[1].x && reproducibilityTest[0].y === reproducibilityTest[1].y;
  console.log(`Reproducible: ${reproducible}`);

  await browser.close();
}

main();
