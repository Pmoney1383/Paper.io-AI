// Goal 2: real reset-inclusive throughput across a realistic multi-episode
// training loop (20 episodes of reset -> 2000 ticks -> reset), using the
// confirmed resetWorld() mechanism (api.create() + api.prepare() +
// spawnPlayer()). Cycle-verified per episode, reset cost measured
// separately from tick cost, and world-geometry-after-reset tracked across
// all 20 resets to check for any leak/degradation over repeated cycles.
const { chromium } = require('playwright');
const { installGameHook, installClockHook, resetWorld, snapshotWorld } = require('./hooks');

const N_EPISODES = 20;
const TICKS_PER_EPISODE = 2000;
const MS_PER_TICK = 33;

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

  const episodes = [];
  const totalStart = Date.now();

  for (let ep = 0; ep < N_EPISODES; ep++) {
    const resetStart = Date.now();
    let resetError = null;
    try {
      await page.evaluate(resetWorld);
    } catch (e) {
      resetError = e.message;
    }
    const resetElapsed = Date.now() - resetStart;

    const postReset = await page.evaluate(() => {
      const g = window.__game;
      if (!g) return { ready: false };
      const cells = g.space && g.space.cells ? g.space.cells : [];
      let cellsPointCount = 0;
      for (const c of cells) cellsPointCount += (c && c.points ? c.points.length : 0);
      return {
        ready: true,
        cycle: g.cycle,
        unitCount: g.units ? g.units.length : null,
        cellsPointCount,
        hasPlayer: !!g.player,
        hasLoop: typeof g.loop === 'function',
      };
    });

    const cycle0 = postReset.ready ? postReset.cycle : null;
    const tickStart = Date.now();
    await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: TICKS_PER_EPISODE, ms: MS_PER_TICK });
    const tickElapsed = Date.now() - tickStart;
    const cycle1 = await page.evaluate(() => window.__game.cycle);

    episodes.push({
      ep,
      resetError,
      resetElapsedMs: resetElapsed,
      postReset,
      tickElapsedMs: tickElapsed,
      cycleDelta: cycle1 - cycle0,
    });

    console.log(`Episode ${ep}: reset=${resetElapsed}ms (cellsPointCount=${postReset.cellsPointCount}, unitCount=${postReset.unitCount}, hasLoop=${postReset.hasLoop}${resetError ? ', ERROR=' + resetError : ''}) | ${TICKS_PER_EPISODE} ticks in ${tickElapsed}ms, cycleDelta=${cycle1 - cycle0}`);
  }

  const totalElapsed = Date.now() - totalStart;
  await browser.close();

  console.log('\n=== Summary ===');
  const totalTicksRequested = N_EPISODES * TICKS_PER_EPISODE;
  const totalCycleDelta = episodes.reduce((s, e) => s + e.cycleDelta, 0);
  const totalResetMs = episodes.reduce((s, e) => s + e.resetElapsedMs, 0);
  const totalTickMs = episodes.reduce((s, e) => s + e.tickElapsedMs, 0);
  const anyErrors = episodes.filter((e) => e.resetError);
  const anyLostLoop = episodes.filter((e) => !e.postReset.hasLoop);

  console.log(`Total wall time (${N_EPISODES} episodes, reset+ticks): ${totalElapsed}ms`);
  console.log(`  Total reset time: ${totalResetMs}ms (avg ${(totalResetMs / N_EPISODES).toFixed(1)}ms/reset)`);
  console.log(`  Total tick time:  ${totalTickMs}ms (avg ${(totalTickMs / N_EPISODES).toFixed(1)}ms/episode-of-ticks)`);
  console.log(`Requested ticks: ${totalTicksRequested}, actual cycle delta sum: ${totalCycleDelta} (ratio ${(totalCycleDelta / totalTicksRequested).toFixed(3)})`);
  console.log(`Throughput INCLUDING reset overhead: ${(totalCycleDelta / (totalElapsed / 1000)).toFixed(0)} ticks/sec`);
  console.log(`Throughput EXCLUDING reset overhead (tick time only): ${(totalCycleDelta / (totalTickMs / 1000)).toFixed(0)} ticks/sec`);
  console.log(`Reset-only cost: avg ${(totalResetMs / N_EPISODES).toFixed(1)}ms, min ${Math.min(...episodes.map(e => e.resetElapsedMs))}ms, max ${Math.max(...episodes.map(e => e.resetElapsedMs))}ms`);
  console.log(`Errors during reset: ${anyErrors.length}/${N_EPISODES}`);
  console.log(`Episodes where game.loop was missing after reset: ${anyLostLoop.length}/${N_EPISODES}`);

  console.log('\ncellsPointCount immediately after each reset (checking for leak across repeated resets):');
  console.log(episodes.map((e) => e.postReset.cellsPointCount).join(', '));
  console.log('\nunitCount immediately after each reset:');
  console.log(episodes.map((e) => e.postReset.unitCount).join(', '));
})();
