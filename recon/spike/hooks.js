// Browser-side instrumentation for the throughput spike. Each function here
// is meant to be passed to page.addInitScript()/page.evaluate() directly —
// kept as plain functions (not a class/module pattern) so they survive
// Playwright's serialize-and-inject boundary without bundling.

// Same Unit-capture trick as recon/extract_state.js: window.__game becomes
// the root game singleton once the first Unit is constructed.
function installGameHook() {
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
}

// Q1: replace performance.now with a manually-advanced virtual clock, and
// neutralize requestAnimationFrame so the engine can't free-run against real
// wall-clock paint ticks while we're driving it by hand. window.__tick(ms)
// advances the virtual clock by ms and, if window.__game exists, invokes its
// loop() directly (loop() is a real, non-obfuscated property name found by
// static analysis of app2.js — it internally subdivides a large dt into
// ~33ms physics steps, so one loop() call can process many ticks' worth of
// simulated time in a single synchronous call).
function installClockHook() {
  window.__now = 0;
  window.__realNow = performance.now.bind(performance);
  performance.now = () => window.__now;
  window.__rafQueue = [];
  window.requestAnimationFrame = (cb) => { window.__rafQueue.push(cb); return window.__rafQueue.length; };
  window.cancelAnimationFrame = () => {};
  window.__tick = function (ms) {
    window.__now += ms;
    if (window.__game && typeof window.__game.loop === 'function') {
      window.__game.loop();
    } else {
      const q = window.__rafQueue;
      window.__rafQueue = [];
      for (const cb of q) { try { cb(window.__now); } catch (e) {} }
    }
  };
  window.__tickN = function (n, ms) {
    for (let i = 0; i < n; i++) window.__tick(ms);
  };
}

// Q2: no-op every CanvasRenderingContext2D drawing method so the game never
// actually paints. Left in place: getContext itself, and any state-query
// methods (measureText, isPointInPath/Stroke, getImageData) — those are
// tested separately for usage, not stubbed, since stubbing a *read* method
// would corrupt behavior rather than just skip wasted work.
function installCanvasStub() {
  const proto = CanvasRenderingContext2D.prototype;
  const drawMethods = [
    'fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'drawImage',
    'fillText', 'strokeText', 'putImageData', 'drawFocusIfNeeded',
    'clip', 'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'arcTo', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'ellipse',
    'setTransform', 'transform', 'translate', 'rotate', 'scale', 'resetTransform',
  ];
  window.__canvasCallCounts = {};
  for (const name of drawMethods) {
    if (typeof proto[name] !== 'function') continue;
    window.__canvasCallCounts[name] = 0;
    const orig = proto[name];
    proto[name] = function (...args) {
      window.__canvasCallCounts[name]++;
      return undefined; // no-op instead of calling orig
    };
  }
  // Instrument (but do not stub) read-back methods, to prove at runtime
  // whether the game ever calls them.
  window.__canvasReadCalls = { getImageData: 0, isPointInPath: 0, isPointInStroke: 0, toDataURL: 0 };
  for (const name of ['getImageData', 'isPointInPath', 'isPointInStroke']) {
    if (typeof proto[name] !== 'function') continue;
    const orig = proto[name];
    proto[name] = function (...args) {
      window.__canvasReadCalls[name]++;
      return orig.apply(this, args);
    };
  }
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    window.__canvasReadCalls.toDataURL++;
    return origToDataURL.apply(this, args);
  };
}

function readMinimalState() {
  const g = window.__game;
  if (!g || !g.player) return { ready: false };
  const p = g.player;
  return {
    ready: true,
    cycle: g.cycle,
    alive: !p.death,
    percent: p.percent,
    x: p.position.x,
    y: p.position.y,
  };
}

// Broader snapshot for reset-semantics investigation: world geometry
// (game.space.cells is a 100x100 spatial-hash grid, each cell holding a
// .points array of registered geometry points - NOT a fill/occupancy grid;
// summing points across cells is a proxy for "how much geometry has
// accumulated"), per-unit state (including dead units, not just count), and
// game.cycle/seed.
function snapshotWorld() {
  const g = window.__game;
  if (!g) return { ready: false };
  const cells = g.space && g.space.cells ? g.space.cells : [];
  let cellsPointCount = 0;
  let nonEmptyCells = 0;
  for (const c of cells) {
    const n = c && c.points ? c.points.length : 0;
    if (n > 0) nonEmptyCells++;
    cellsPointCount += n;
  }
  const units = (g.units || []).map((u, i) => ({
    index: i,
    isPlayer: u === g.player,
    alive: !u.death,
    x: u.position ? u.position.x : null,
    y: u.position ? u.position.y : null,
    percent: u.percent,
    baseSquare: u.base ? u.base.square : null,
    trailPoints: u.track && u.track.simplyline ? u.track.simplyline.length : null,
  }));
  return {
    ready: true,
    cycle: g.cycle,
    seed: g.seed,
    unitCount: g.units ? g.units.length : null,
    cellsPointCount,
    nonEmptyCells,
    units,
    player: g.player ? {
      x: g.player.position.x,
      y: g.player.position.y,
      percent: g.player.percent,
      alive: !g.player.death,
    } : null,
  };
}

// Genuine world reset, found via static analysis of app2.js: the site's own
// "return to menu" flow does
//   api.game.stopped = true; api.create(canvasEl); api.prepare(callback);
// where api === window.paperio2api (window.paperio2api.game is the same
// object as our push-hook-captured window.__game). create() builds a brand
// new spatial hash + border + game instance; prepare() gradually spawns
// bases/bots via a real setInterval (NOT driven by our virtual clock - this
// is genuine wall-clock cost, unlike everything else in this spike) and
// resolves its callback once done. Verified via before/after snapshots:
// cycle and cellsPointCount both drop sharply (not just churn), and every
// bot's baseSquare resets to the same fresh-spawn baseline (~2820).
//
// IMPORTANT: create() replaces the game object, so our push-hook's cached
// window.__game goes stale - this function re-points it at
// window.paperio2api.game after prepare() resolves, then spawns the player
// via the already-confirmed spawnPlayer() pure-function call.
function resetWorld() {
  return new Promise((resolve, reject) => {
    const api = window.paperio2api;
    if (!api) { reject(new Error('window.paperio2api not found')); return; }
    // prepare()'s completion callback depends on a real setInterval, not our
    // virtual clock - normally resolves in ~10-50ms, but has no guarantee.
    // Without a fallback, a stuck callback hangs page.evaluate() forever
    // (the returned promise eventually just gets garbage collected, which
    // surfaces as an opaque Playwright error, not a catchable timeout).
    // Fatal for unattended training, so always resolve one way or another.
    const timeoutId = setTimeout(() => {
      window.__game = api.game;
      try { window.__game.spawnPlayer(); } catch (e) {}
      resolve({ timedOut: true });
    }, 8000);
    try {
      if (api.game) api.game.stopped = true;
      const canvas = document.getElementById('view') || document.querySelector('canvas');
      api.create(canvas);
      api.prepare(() => {
        clearTimeout(timeoutId);
        window.__game = api.game;
        try { window.__game.spawnPlayer(); } catch (e) {}
        resolve({ timedOut: false });
      });
    } catch (e) {
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

module.exports = { installGameHook, installClockHook, installCanvasStub, readMinimalState, snapshotWorld, resetWorld };
