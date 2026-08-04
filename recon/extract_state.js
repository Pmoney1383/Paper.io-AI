// Phase 1 replacement: pull exact game state directly from the page's live
// object graph instead of reconstructing it from pixels. See doc/paperio-rl-plan.md
// and the Phase 0/1 recon findings for how window.__game gets bootstrapped.

// Injected once via page/context.addInitScript before navigation. Hooks
// Array.prototype.push to catch the first Unit instance ever constructed
// (identifiable by having .game + .position + .track own properties) and
// caches its .game backref as window.__game, which is the root game
// singleton reachable from any unit.
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

// Runs inside page.evaluate(). Reads window.__game and returns a plain,
// JSON-serializable snapshot of the state an RL env needs each step.
function readState() {
  const g = window.__game;
  if (!g || !g.player) return { ready: false };

  const p = g.player;
  const alive = !p.death; // death is `undefined` while alive, `true` on death — never `false`

  function point(pt) {
    return pt ? { x: pt.x, y: pt.y } : null;
  }
  function polyline(points, maxLen) {
    if (!points) return [];
    const arr = Array.isArray(points) ? points : [];
    const step = maxLen && arr.length > maxLen ? Math.ceil(arr.length / maxLen) : 1;
    const out = [];
    for (let i = 0; i < arr.length; i += step) out.push(point(arr[i]));
    return out;
  }
  function unitSnapshot(u) {
    return {
      isPlayer: u === g.player,
      alive: !u.death,
      x: u.position.x,
      y: u.position.y,
      direction: u.direction,
      percent: u.percent,
      baseSquare: u.base ? u.base.square : null,
    };
  }

  return {
    ready: true,
    cycle: g.cycle,
    alive,
    percent: p.percent,
    bestPercent: p.bestPercent,
    player: {
      x: p.position.x,
      y: p.position.y,
      direction: p.direction,
      baseSquare: p.base ? p.base.square : null,
      trail: polyline(p.track && p.track.simplyline, 60),
    },
    units: (g.units || []).map(unitSnapshot),
    arena: {
      width: g.space ? g.space.width : null,
      height: g.space ? g.space.height : null,
      borderRadius: g.border ? g.border.radius : null,
      borderCenter: g.border ? point(g.border.center) : null,
    },
  };
}

module.exports = { installGameHook, readState };
