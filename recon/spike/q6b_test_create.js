// window.paperio2api = { create, preparing, prepare, start, startGame, game }
// and paperio2api.game === window.__game (confirmed in q6a). Test whether
// calling .create() again produces a genuinely fresh game/world: does
// window.__game (via the push-hook re-capturing) or paperio2api.game change
// identity, and do cellsPointCount/baseSquare/cycle drop to near-zero?
const { chromium } = require('playwright');
const { installGameHook, installClockHook, snapshotWorld } = require('./hooks');

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

  // Let the world build up real state first, same as the last spike.
  await page.evaluate(({ n, ms }) => window.__tickN(n, ms), { n: 300, ms: 33 });
  const before = await page.evaluate(snapshotWorld);
  console.log('BEFORE create(): cycle=%d cellsPointCount=%d unitCount=%d', before.cycle, before.cellsPointCount, before.unitCount);
  console.log('  bot[0] baseSquare=%s', before.units.find(u => !u.isPlayer)?.baseSquare);

  const createResult = await page.evaluate(() => {
    const api = window.paperio2api;
    const oldGameRef = window.__game;
    let threw = null;
    let newGameRef = null;
    try {
      api.create();
      newGameRef = api.game;
    } catch (e) {
      threw = e.message;
    }
    return {
      threw,
      sameGameRefAsBefore: newGameRef === oldGameRef,
      apiGameExists: !!newGameRef,
      windowGameHookStillPointsToOld: window.__game === oldGameRef,
    };
  });
  console.log('\ncreate() result:', JSON.stringify(createResult, null, 2));

  // If create() built a new game, window.__game (captured via our push hook
  // from the FIRST unit ever seen) still points at the OLD instance - that's
  // expected, our hook doesn't auto-refresh. Read state via paperio2api.game
  // directly instead to see the fresh instance's real state.
  const afterCreate = await page.evaluate(() => {
    const g = window.paperio2api.game;
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
    };
  });
  console.log('\nAFTER create(), reading paperio2api.game directly:', JSON.stringify(afterCreate, null, 2));

  await browser.close();
})();
