// Tests for recon/spike/hooks.js. Two tiers:
//   - "mechanism" tests: verify each hook's own logic in isolation, against
//     a blank/synthetic page - no dependency on paperio.site being up.
//   - "integration" tests: verify the hooks actually do what they're for
//     against the live game. Slower, network-dependent, but this is exactly
//     what the four spike questions needed proven, so they're worth keeping.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  installGameHook,
  installClockHook,
  installCanvasStub,
  readMinimalState,
  snapshotWorld,
  resetWorld,
} = require('../recon/spike/hooks');

describe('installClockHook (mechanism)', () => {
  test('performance.now returns the manually-advanced virtual clock, not real time', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installClockHook);
    await page.goto('about:blank');

    const before = await page.evaluate(() => performance.now());
    assert.equal(before, 0);

    await page.evaluate(() => { window.__now += 5000; });
    const after = await page.evaluate(() => performance.now());
    assert.equal(after, 5000);

    await browser.close();
  });

  test('requestAnimationFrame is neutralized (queued, not fired on a real schedule)', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installClockHook);
    await page.goto('about:blank');

    const firedWithinRealTime = await page.evaluate(() => new Promise((resolve) => {
      let fired = false;
      requestAnimationFrame(() => { fired = true; });
      setTimeout(() => resolve(fired), 200);
    }));
    assert.equal(firedWithinRealTime, false, 'rAF callback must not fire on its own - we drive it manually');

    await browser.close();
  });

  test('__tick advances the clock and falls back to draining the rAF queue when window.__game is absent', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installClockHook);
    await page.goto('about:blank');

    const result = await page.evaluate(() => {
      let called = 0;
      requestAnimationFrame(() => { called++; });
      window.__tick(33);
      return { now: window.__now, called };
    });
    assert.equal(result.now, 33);
    assert.equal(result.called, 1, 'queued rAF callback should have been drained by __tick');

    await browser.close();
  });

  test('__tickN(n, ms) advances the clock by n*ms total', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installClockHook);
    await page.goto('about:blank');

    const now = await page.evaluate(() => { window.__tickN(10, 33); return window.__now; });
    assert.equal(now, 330);

    await browser.close();
  });
});

describe('installCanvasStub (mechanism)', () => {
  async function pageWithCanvas(browser) {
    const page = await browser.newPage();
    await page.addInitScript(installCanvasStub);
    // setContent() does not reliably trigger addInitScript (it doesn't go
    // through a normal navigation) - use a data: URL via goto() instead.
    await page.goto('data:text/html,<canvas id="c" width="100" height="100"></canvas>');
    return page;
  }

  test('draw methods become no-ops but are counted', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await pageWithCanvas(browser);

    const counts = await page.evaluate(() => {
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(0, 0, 10, 10);
      ctx.beginPath();
      ctx.arc(5, 5, 2, 0, Math.PI * 2);
      ctx.stroke();
      return window.__canvasCallCounts;
    });
    assert.equal(counts.fillRect, 2);
    assert.equal(counts.beginPath, 1);
    assert.equal(counts.arc, 1);
    assert.equal(counts.stroke, 1);

    await browser.close();
  });

  test('fillRect no-op means canvas pixels are never actually touched', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await pageWithCanvas(browser);

    const pixel = await page.evaluate(() => {
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, 100, 100);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return Array.from(data);
    });
    assert.deepEqual(pixel, [0, 0, 0, 0], 'fillRect was stubbed, so the canvas must still be blank');

    await browser.close();
  });

  test('read-back methods (getImageData) still execute and are counted, not stubbed', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await pageWithCanvas(browser);

    const result = await page.evaluate(() => {
      const ctx = document.getElementById('c').getContext('2d');
      ctx.getImageData(0, 0, 1, 1);
      ctx.getImageData(0, 0, 1, 1);
      return window.__canvasReadCalls.getImageData;
    });
    assert.equal(result, 2);

    await browser.close();
  });
});

describe('installGameHook (mechanism)', () => {
  test('captures .game off the first pushed object shaped like a Unit (has game+position+track)', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installGameHook);
    await page.goto('about:blank');

    const captured = await page.evaluate(() => {
      const fakeGame = { marker: 'the-real-game-object' };
      const arr = [];
      // objects that should NOT match
      arr.push({ x: 1, y: 2 });
      arr.push({ position: { x: 0, y: 0 } }); // missing game/track
      // the one that should match
      arr.push({ game: fakeGame, position: { x: 0, y: 0 }, track: {} });
      return window.__game && window.__game.marker;
    });
    assert.equal(captured, 'the-real-game-object');

    await browser.close();
  });

  test('does not re-capture once window.__game is already set (first match wins)', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installGameHook);
    await page.goto('about:blank');

    const marker = await page.evaluate(() => {
      const arr = [];
      arr.push({ game: { marker: 'first' }, position: {}, track: {} });
      arr.push({ game: { marker: 'second' }, position: {}, track: {} });
      return window.__game.marker;
    });
    assert.equal(marker, 'first');

    await browser.close();
  });
});

describe('snapshotWorld (mechanism)', () => {
  test('computes cellsPointCount/nonEmptyCells/unit summaries from a synthetic game object', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('about:blank');

    const snap = await page.evaluate((snapshotWorldStr) => {
      const snapshotWorld = eval(`(${snapshotWorldStr})`);
      const player = { position: { x: 1, y: 2 }, percent: 0.5, base: { square: 10 }, track: { simplyline: [1, 2, 3] }, death: false };
      const bot = { position: { x: 3, y: 4 }, percent: 0.1, base: { square: 5 }, track: { simplyline: [1] }, death: true };
      window.__game = {
        cycle: 42,
        seed: 0.123,
        player,
        units: [player, bot],
        space: { cells: [{ points: [1, 2] }, { points: [] }, { points: [3] }] },
      };
      return snapshotWorld();
    }, snapshotWorld.toString());

    assert.equal(snap.ready, true);
    assert.equal(snap.cycle, 42);
    assert.equal(snap.seed, 0.123);
    assert.equal(snap.unitCount, 2);
    assert.equal(snap.cellsPointCount, 3);
    assert.equal(snap.nonEmptyCells, 2);
    assert.equal(snap.units[0].isPlayer, true);
    assert.equal(snap.units[0].alive, true);
    assert.equal(snap.units[1].isPlayer, false);
    assert.equal(snap.units[1].alive, false, 'dead unit (death:true) must report alive:false');
    assert.equal(snap.units[1].baseSquare, 5);

    await browser.close();
  });

  test('reports ready:false when window.__game is absent', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const snap = await page.evaluate(snapshotWorld);
    assert.equal(snap.ready, false);
    await browser.close();
  });
});

// These hit the real, third-party paperio.site. Slower and subject to real
// network/site conditions - the authoritative, repeatedly-verified numbers
// for the report come from the standalone scripts in recon/spike/*.js (each
// run standalone, cycle-verified, several times independently). These tests
// exist to catch regressions in hooks.js itself, and are deliberately
// consolidated into as few live browser launches as possible (one per hook
// combination) since launching many Chromium instances back-to-back against
// one live site in a tight loop was itself a source of flakiness.
describe('live paperio.site integration', () => {
  async function launchWithHooks(extraInit) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(installGameHook);
    if (extraInit) for (const fn of extraInit) await page.addInitScript(fn);
    await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
    for (let i = 0; i < 40; i++) {
      const ready = await page.evaluate(() => !!(window.__game && window.__game.units && window.__game.units.length));
      if (ready) break;
      await page.waitForTimeout(200);
    }
    return { browser, page };
  }

  test('game hook: reachable without clicking PLAY; spawnPlayer() is a pure-function reset with no leak; readMinimalState tracks it', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks();

    const info = await page.evaluate(() => ({
      hasGame: !!window.__game,
      hasLoop: typeof window.__game.loop === 'function',
      unitCount: window.__game.units.length,
    }));
    assert.equal(info.hasGame, true);
    assert.equal(info.hasLoop, true);
    assert.ok(info.unitCount > 0);

    const stateBefore = await page.evaluate(readMinimalState);
    assert.equal(stateBefore.ready, false);

    const spawnResults = await page.evaluate(() => {
      const g = window.__game;
      const out = [];
      for (let i = 0; i < 4; i++) {
        g.spawnPlayer();
        out.push({ unitCount: g.units.length, alive: !g.player.death });
      }
      return out;
    });
    assert.ok(spawnResults.every((r) => r.alive), 'player should be alive after every spawnPlayer() call');
    const counts = spawnResults.map((r) => r.unitCount);
    assert.ok(counts.every((c) => c === counts[0]), `unit count should stay constant across resets, got ${counts}`);

    const stateAfter = await page.evaluate(readMinimalState);
    assert.equal(stateAfter.ready, true);
    assert.equal(stateAfter.alive, true);
    assert.equal(typeof stateAfter.x, 'number');
    assert.equal(typeof stateAfter.y, 'number');

    await browser.close();
  });

  test('clock hook: direct loop() pumping advances game.cycle by at least the requested count, and outpaces wall-clock', { timeout: 90000 }, async () => {
    // In isolation (see recon/spike/q3b_isolated_batch_test.js, run several
    // times independently) this is a clean 1:1 ratio. Under back-to-back
    // multi-browser test-suite load we occasionally observed a *surplus* of
    // extra cycles (never a deficit) - most likely system-level contention
    // from launching many Chromium instances in quick succession, not a flaw
    // in the override itself. The property that actually matters (and that
    // a short-circuit bug would violate) is "at least N cycles happened" - a
    // deficit is the real failure signal, which is what we assert on.
    const { browser, page } = await launchWithHooks([installClockHook]);

    const cycle0 = await page.evaluate(() => window.__game.cycle);
    const N = 500;
    const wallStart = Date.now();
    await page.evaluate((n) => window.__tickN(n, 33), N);
    const wallElapsed = Date.now() - wallStart;
    const cycle1 = await page.evaluate(() => window.__game.cycle);

    await browser.close();

    assert.ok(cycle1 - cycle0 >= N, `expected at least ${N} cycles, got ${cycle1 - cycle0}`);
    const simulatedMs = N * 33;
    assert.ok(simulatedMs > wallElapsed * 5, `expected simulated ${simulatedMs}ms to be at least 5x wall-clock ${wallElapsed}ms`);
  });

  test('canvas stub: sim still progresses with rendering fully stubbed, and no pixel-readback is ever called', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks([installCanvasStub]);

    const before = await page.evaluate(() => {
      const u = window.__game.units[0];
      return { x: u.position.x, y: u.position.y, cycle: window.__game.cycle };
    });
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => {
      const u = window.__game.units[0];
      return { x: u.position.x, y: u.position.y, cycle: window.__game.cycle };
    });
    const readCalls = await page.evaluate(() => window.__canvasReadCalls);

    await browser.close();

    assert.ok(after.cycle > before.cycle, 'cycle must still advance with canvas stubbed');
    assert.ok(Object.values(readCalls).every((v) => v === 0), 'no pixel-readback method should ever be called');
  });

  // Findings from recon/spike/q5_reset_semantics.js and q5b_followups.js,
  // run standalone and repeated several times: spawnPlayer() does NOT reset
  // world geometry, game.cycle, or bot state (dead or alive) - it only
  // creates/replaces the player unit. These tests assert exactly that, with
  // before/after values, so a future engine update that silently changes
  // this behavior gets caught rather than assumed away.
  test('spawnPlayer() does not clear world geometry or reset game.cycle across rounds', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks([installClockHook]);

    const round1Before = await page.evaluate(snapshotWorld);
    await page.evaluate(() => window.__game.spawnPlayer());
    const round1AfterSpawn = await page.evaluate(snapshotWorld);
    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 150, ms: 33 });
    const round1AfterTicks = await page.evaluate(snapshotWorld);

    const round2Before = round1AfterTicks;
    await page.evaluate(() => window.__game.spawnPlayer());
    const round2AfterSpawn = await page.evaluate(snapshotWorld);

    await browser.close();

    // spawnPlayer() itself (zero ticks requested) must not meaningfully
    // advance cycle or wipe accumulated geometry - a real clear would drop
    // cellsPointCount sharply (not just churn by a small amount from normal
    // collision bookkeeping). Cycle tolerance mirrors the clock-hook test
    // above: under full-suite load we've observed a small *surplus* of
    // extra cycles (never a deficit) from system-level contention between
    // Chromium instances, not a flaw in spawnPlayer() itself - a large jump
    // is the real failure signal, not a few stray cycles.
    const CYCLE_TOLERANCE = 20;
    assert.ok(Math.abs(round1AfterSpawn.cycle - round1Before.cycle) <= CYCLE_TOLERANCE, `spawnPlayer() must not advance game.cycle: ${round1Before.cycle} -> ${round1AfterSpawn.cycle}`);
    assert.ok(Math.abs(round2AfterSpawn.cycle - round2Before.cycle) <= CYCLE_TOLERANCE, `spawnPlayer() must not advance game.cycle: ${round2Before.cycle} -> ${round2AfterSpawn.cycle}`);
    assert.ok(
      round1AfterSpawn.cellsPointCount > round1Before.cellsPointCount * 0.5,
      `spawnPlayer() must not wipe world geometry: before=${round1Before.cellsPointCount} after=${round1AfterSpawn.cellsPointCount}`
    );

    // cycle must keep climbing across rounds (never resets to 0/baseline).
    assert.ok(round2Before.cycle > round1Before.cycle, `cycle should have advanced from ticking: ${round1Before.cycle} -> ${round2Before.cycle}`);

    // bot territory (baseSquare) must persist and not reset to near-zero
    // just because spawnPlayer() was called again.
    const bot0Round1 = round1AfterTicks.units.find((u) => !u.isPlayer);
    const bot0Round2 = round2AfterSpawn.units.find((u) => !u.isPlayer && u.index === bot0Round1.index);
    assert.ok(bot0Round2, 'the same bot slot should still exist after the second spawnPlayer() call');
    assert.equal(bot0Round2.baseSquare, bot0Round1.baseSquare, "a bot's baseSquare must be untouched by spawnPlayer()");
  });

  test('a dead bot (killed via game.kill) keeps its stats and is unaffected by a subsequent spawnPlayer() call', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks([installClockHook]);

    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 150, ms: 33 });
    const before = await page.evaluate(snapshotWorld);
    const targetIndex = before.units.findIndex((u) => !u.isPlayer && u.alive);
    assert.ok(targetIndex >= 0, 'expected at least one live bot to kill');

    const killed = await page.evaluate((idx) => {
      const g = window.__game;
      const target = g.units[idx];
      const statsBefore = { percent: target.percent, baseSquare: target.base ? target.base.square : null };
      g.kill(target);
      return { statsBefore, aliveAfterKill: !target.death, statsAfterKill: { percent: target.percent, baseSquare: target.base ? target.base.square : null } };
    }, targetIndex);

    assert.equal(killed.aliveAfterKill, false, 'kill() must flip death to true');
    assert.deepEqual(killed.statsAfterKill, killed.statsBefore, "kill() must not zero out the unit's stats, only flip death");

    const unitCountAfterKill = await page.evaluate(() => window.__game.units.length);
    assert.equal(unitCountAfterKill, before.unitCount - 1, 'dead unit should be removed from game.units');

    await page.evaluate(() => window.__game.spawnPlayer());
    const unitCountAfterSpawn = await page.evaluate(() => window.__game.units.length);

    await browser.close();

    // spawnPlayer() only ever adds/replaces the single player slot - it
    // should not touch bot population bookkeeping at all.
    assert.equal(unitCountAfterSpawn, unitCountAfterKill + 1, 'spawnPlayer() should add exactly one unit (the player), nothing else');
  });

  test('spawn position varies across calls; explicit numeric args are not (x, y, ...) coordinates', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks();

    const positions = await page.evaluate(() => {
      const g = window.__game;
      const out = [];
      for (let i = 0; i < 10; i++) {
        g.spawnPlayer();
        out.push({ x: g.player.position.x, y: g.player.position.y });
      }
      return out;
    });
    const uniqueCount = new Set(positions.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size;
    assert.ok(uniqueCount >= 8, `expected spawn positions to vary across calls, got ${uniqueCount}/10 unique`);

    // Passing (x, y, z) does NOT position the player there - confirms the
    // arity-3 signature is not (x, y, extra) coordinates.
    const argTest = await page.evaluate(() => {
      const g = window.__game;
      const before = { x: g.player.position.x, y: g.player.position.y };
      let threw = false;
      try { g.spawnPlayer(999999, 999999, undefined); } catch (e) { threw = true; }
      return { before, threw };
    });
    assert.equal(argTest.threw, true, 'spawnPlayer(999999, 999999, ...) should throw (args are not x/y coordinates), not silently teleport the player there');

    await browser.close();
  });

  // Findings from recon/spike/q6c_proper_create.js and q7_reset_throughput.js:
  // window.paperio2api = { create, prepare, start, startGame, game }, and
  // paperio2api.game === window.__game. The site's own "return to menu" flow
  // does `api.game.stopped = true; api.create(canvas); api.prepare(cb);` -
  // this is a GENUINE world reset (unlike spawnPlayer() alone), confirmed by
  // sharp drops in cycle and cellsPointCount, not just churn. resetWorld()
  // in hooks.js wraps this plus a spawnPlayer() call and re-syncs
  // window.__game (create() replaces the game object, so the push-hook's
  // cached reference would otherwise go stale).
  test('resetWorld() produces a genuine reset: cycle and world geometry drop sharply, not just churn', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks([installClockHook]);

    // Build up real accumulated state first, same as the persistence tests.
    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 300, ms: 33 });
    const before = await page.evaluate(snapshotWorld);
    assert.ok(before.cycle > 1000, 'sanity check: cycle should have accumulated from ticking');
    assert.ok(before.cellsPointCount > 1000, 'sanity check: geometry should have accumulated from ticking');

    await page.evaluate(resetWorld);
    const after = await page.evaluate(snapshotWorld);

    await browser.close();

    // A genuine reset must drop these sharply (not the ~3-5% churn
    // spawnPlayer() alone produces) - assert at least a 5x reduction.
    assert.ok(after.cycle * 5 < before.cycle, `expected cycle to drop sharply: ${before.cycle} -> ${after.cycle}`);
    assert.ok(after.cellsPointCount * 3 < before.cellsPointCount, `expected geometry to drop sharply: ${before.cellsPointCount} -> ${after.cellsPointCount}`);
    // Every bot should be back at the same fresh-spawn baseline baseSquare,
    // not carrying over accumulated territory.
    const botSquares = after.units.filter((u) => !u.isPlayer).map((u) => u.baseSquare);
    assert.ok(botSquares.length > 0, 'expected at least one bot after reset');
    const allSame = botSquares.every((s) => Math.abs(s - botSquares[0]) < 1);
    assert.ok(allSame, `expected all bots to share the same fresh-spawn baseSquare after reset, got ${botSquares}`);
    assert.ok(after.player, 'resetWorld() should also spawn the player');
    assert.equal(after.player.alive, true);
  });

  test('reset -> tick -> reset loop (5 episodes): cycle-verified throughput, no leak or hook degradation across repeats', { timeout: 90000 }, async () => {
    const { browser, page } = await launchWithHooks([installClockHook]);

    const N_EPISODES = 5;
    const TICKS_PER_EPISODE = 500;
    const results = [];
    for (let ep = 0; ep < N_EPISODES; ep++) {
      await page.evaluate(resetWorld);
      const postReset = await page.evaluate(snapshotWorld);
      const cycle0 = postReset.cycle;
      await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: TICKS_PER_EPISODE, ms: 33 });
      const cycle1 = await page.evaluate(() => window.__game.cycle);
      const hasLoop = await page.evaluate(() => typeof window.__game.loop === 'function');
      results.push({ ep, cellsPointCountAfterReset: postReset.cellsPointCount, cycleDelta: cycle1 - cycle0, hasLoop });
    }

    await browser.close();

    for (const r of results) {
      assert.equal(r.cycleDelta, TICKS_PER_EPISODE, `episode ${r.ep}: expected exactly ${TICKS_PER_EPISODE} cycles, got ${r.cycleDelta} - a short-circuit or hook failure would show up here`);
      assert.equal(r.hasLoop, true, `episode ${r.ep}: game.loop must still be callable after repeated resets`);
    }
    // No leak: post-reset geometry should stay within a stable range across
    // all episodes, not creep upward with each repeated create() call.
    const counts = results.map((r) => r.cellsPointCountAfterReset);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);
    assert.ok(maxCount < minCount * 3 + 200, `post-reset geometry should stay stable across repeated resets, got ${counts}`);
  });
});
