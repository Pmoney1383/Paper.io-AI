"""
Python port of recon/spike/hooks.js, verified across many spikes against the
live paperio.site engine. Each constant is raw JS source: the INSTALL_*
constants are IIFEs meant for page.add_init_script(script=...), the rest are
JS arrow-function expressions meant for page.evaluate(js).

See doc/ for the plan and recon/spike/*.js + tests/hooks.test.js (Node) for
the original spikes that established every one of these mechanisms:
  - window.__game is reachable by hooking Array.prototype.push to catch the
    first Unit ever constructed and reading its .game backref.
  - performance.now + requestAnimationFrame can be overridden to decouple
    simulation time from wall-clock time; window.__game.loop() can then be
    called directly to advance the sim (~60x+ verified speedup).
  - CanvasRenderingContext2D drawing methods can be fully stubbed with zero
    effect on simulation correctness (confirmed zero pixel-readback calls).
  - window.paperio2api.create(canvas) + .prepare(callback) is a genuine
    world reset (spatial hash, border, bot territory, game.cycle all reset -
    NOT just spawnPlayer(), which only replaces the player unit and leaves
    world state accumulating indefinitely).
"""

INSTALL_GAME_HOOK = """
(function () {
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
})();
"""

INSTALL_CLOCK_HOOK = """
(function () {
  window.__now = 0;
  window.__realNow = performance.now.bind(performance);
  performance.now = () => window.__now;
  window.__realRAF = window.requestAnimationFrame.bind(window);
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
})();
"""

INSTALL_CANVAS_STUB = """
(function () {
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
    proto[name] = function (...args) {
      window.__canvasCallCounts[name]++;
      return undefined;
    };
  }
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
})();
"""

# page.evaluate(js) expressions below - each is a JS function expression.

READ_MINIMAL_STATE_JS = """
() => {
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
"""

SNAPSHOT_WORLD_JS = """
() => {
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
    direction: u.direction,
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
      direction: g.player.direction,
      percent: g.player.percent,
      alive: !g.player.death,
    } : null,
    border: g.border ? { radius: g.border.radius, centerX: g.border.center.x, centerY: g.border.center.y } : null,
    arenaWidth: g.space ? g.space.width : null,
    arenaHeight: g.space ? g.space.height : null,
  };
}
"""

# Genuine world reset (see hooks.js for the full derivation/verification
# notes). window.paperio2api = { create, preparing, prepare, start,
# startGame, game }; paperio2api.game === window.__game. The site's own
# "return to menu" flow does:
#   api.game.stopped = true; api.create(canvasEl); api.prepare(callback);
# create() builds a brand new spatial hash + border + game instance;
# prepare() gradually spawns bases/bots via a REAL setInterval (not driven by
# our virtual clock - genuine wall-clock cost, ~10-50ms typically) and
# resolves its callback once done. A timeout fallback is included because an
# unattended training loop cannot tolerate reset() hanging indefinitely if
# that callback is ever missed.
RESET_WORLD_JS = """
() => {
  return new Promise((resolve, reject) => {
    const api = window.paperio2api;
    if (!api) { reject(new Error('window.paperio2api not found')); return; }
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
"""

TICK_JS = "(ms) => window.__tick(ms)"
TICK_N_JS = "({ n, ms }) => window.__tickN(n, ms)"
GAME_READY_JS = "() => !!(window.__game && window.__game.units && window.__game.units.length)"

# Curriculum learning lever: window.__game.config is the SAME object every
# create() call reads botsCount from (it's captured once in a closure at
# page bootstrap, not re-supplied per call) - mutating it before the next
# resetWorld() changes bot population in the next world. Verified: set to 3,
# reset, and the resulting world had exactly 3 units.
SET_BOTS_COUNT_JS = "(n) => { if (window.__game && window.__game.config) window.__game.config.botsCount = n; }"

# Draw calls land on the canvas's own bitmap immediately, but the BROWSER's
# on-screen compositor only repaints when something asks for a real
# animation frame - which we intentionally starve everywhere else in this
# file for speed. For a visible instance meant to be watched, nudge one real
# paint via the native (pre-override) rAF so the window actually updates.
NUDGE_REPAINT_JS = "() => new Promise((r) => window.__realRAF(r))"

# Fixed-size feature-vector observation, computed entirely in-browser (avoids
# marshaling the full units[] array over IPC every step). Returns null if
# there's no live player (e.g. mid-reset), which the env treats as terminal.
# Layout: [playerX, playerY, sin(dir), cos(dir), percent, borderDist,
#          homeDx, homeDy, trailLenNorm,
#          then K * (dx, dy, alive) for the K nearest other units by distance]
#
# homeDx/homeDy/trailLenNorm matter a lot: without them the network has no
# way to know which direction leads back to its own territory, so it has no
# basis for ever learning to turn around and close a loop - "run in a
# straight line forever" is the only thing it CAN learn without this. It's
# the vector from the player to the start of its current trail (where it
# left owned territory) - zero vector when there's no open trail (i.e. the
# player is standing on/inside their own base right now).
OBSERVE_JS = """
(K) => {
  const g = window.__game;
  if (!g || !g.player) return null;
  const p = g.player;
  const arenaR = g.border ? g.border.radius : 950;
  const cx = g.border ? g.border.center.x : (g.space ? g.space.width / 2 : 1000);
  const cy = g.border ? g.border.center.y : (g.space ? g.space.height / 2 : 1000);
  const dx0 = p.position.x - cx, dy0 = p.position.y - cy;
  const distFromCenter = Math.sqrt(dx0 * dx0 + dy0 * dy0);
  const borderDist = Math.max(0, Math.min(1, (arenaR - distFromCenter) / arenaR));

  const others = (g.units || [])
    .filter((u) => u !== p && !u.death)
    .map((u) => {
      const dx = u.position.x - p.position.x;
      const dy = u.position.y - p.position.y;
      return { dx, dy, dist: Math.sqrt(dx * dx + dy * dy) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, K);

  const NORM = 500;
  const clip = (v) => Math.max(-1, Math.min(1, v));

  const trail = p.track && p.track.simplyline ? p.track.simplyline : [];
  let homeDx = 0, homeDy = 0;
  if (trail.length > 0) {
    homeDx = trail[0].x - p.position.x;
    homeDy = trail[0].y - p.position.y;
  }
  const trailLenNorm = Math.min(1, trail.length / 60);

  const obs = [
    clip((p.position.x / (g.space ? g.space.width : 2000)) * 2 - 1),
    clip((p.position.y / (g.space ? g.space.height : 2000)) * 2 - 1),
    Math.sin(p.direction || 0),
    Math.cos(p.direction || 0),
    p.percent,
    borderDist,
    clip(homeDx / NORM),
    clip(homeDy / NORM),
    trailLenNorm,
  ];
  for (let i = 0; i < K; i++) {
    if (i < others.length) {
      obs.push(clip(others[i].dx / NORM), clip(others[i].dy / NORM), 1);
    } else {
      obs.push(0, 0, 0);
    }
  }
  return { obs, alive: !p.death, percent: p.percent, cycle: g.cycle, trailLen: trail.length };
}
"""
