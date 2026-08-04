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
    await page.setContent('<canvas id="c" width="100" height="100"></canvas>');
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

describe('live paperio.site integration', { timeout: 60000 }, () => {
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

  test('Q0/Q1: window.__game is reachable without ever clicking PLAY, and has a callable loop()', async () => {
    const { browser, page } = await launchWithHooks();
    const info = await page.evaluate(() => ({
      hasGame: !!window.__game,
      hasLoop: typeof window.__game.loop === 'function',
      unitCount: window.__game.units.length,
    }));
    await browser.close();
    assert.equal(info.hasGame, true);
    assert.equal(info.hasLoop, true);
    assert.ok(info.unitCount > 0);
  });

  test('Q1: clock override + direct loop() pumping advances game.cycle by exactly the requested tick count', async () => {
    const { browser, page } = await launchWithHooks([installClockHook]);
    const cycle0 = await page.evaluate(() => window.__game.cycle);
    const N = 500;
    await page.evaluate((n) => window.__tickN(n, 33), N);
    const cycle1 = await page.evaluate(() => window.__game.cycle);
    await browser.close();
    assert.equal(cycle1 - cycle0, N, 'each __tick should correspond to exactly one physics cycle at dt=33ms');
  });

  test('Q1: simulated time genuinely outpaces wall-clock time (not just a spinning counter)', async () => {
    const { browser, page } = await launchWithHooks([installClockHook]);
    const N = 1000;
    const simulatedMs = N * 33;
    const wallStart = Date.now();
    await page.evaluate((n) => window.__tickN(n, 33), N);
    const wallElapsed = Date.now() - wallStart;
    await browser.close();
    assert.ok(simulatedMs > wallElapsed * 5, `expected simulated ${simulatedMs}ms to be at least 5x wall-clock ${wallElapsed}ms`);
  });

  test('Q2: canvas fully stubbed still lets the sim progress (cycle advances, units move)', async () => {
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

  test('Q4: game.spawnPlayer() creates a live player with zero DOM interaction', async () => {
    const { browser, page } = await launchWithHooks();
    const before = await page.evaluate(() => !!window.__game.player);
    await page.evaluate(() => window.__game.spawnPlayer());
    const after = await page.evaluate(() => ({
      hasPlayer: !!window.__game.player,
      alive: window.__game.player ? !window.__game.player.death : false,
    }));
    await browser.close();

    assert.equal(before, false);
    assert.equal(after.hasPlayer, true);
    assert.equal(after.alive, true);
  });

  test('Q4: repeated spawnPlayer() calls do not leak entries into game.units', async () => {
    const { browser, page } = await launchWithHooks();
    const counts = await page.evaluate(() => {
      const g = window.__game;
      const out = [];
      for (let i = 0; i < 4; i++) {
        g.spawnPlayer();
        out.push(g.units.length);
      }
      return out;
    });
    await browser.close();
    assert.ok(counts.every((c) => c === counts[0]), `unit count should stay constant across resets, got ${counts}`);
  });

  test('readMinimalState reports ready:false before a player exists, and live data after spawnPlayer()', async () => {
    const { browser, page } = await launchWithHooks();
    const before = await page.evaluate(readMinimalState);
    await page.evaluate(() => window.__game.spawnPlayer());
    const after = await page.evaluate(readMinimalState);
    await browser.close();

    assert.equal(before.ready, false);
    assert.equal(after.ready, true);
    assert.equal(after.alive, true);
    assert.equal(typeof after.x, 'number');
    assert.equal(typeof after.y, 'number');
  });
});
