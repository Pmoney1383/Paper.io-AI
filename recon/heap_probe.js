const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Instrument BEFORE any page script runs: tag every array ever pushed to,
  // and keep a weak registry of "interesting" containers (objects with a `units`
  // array and a `space` property, matching the addUnit/addPlayer pattern we found
  // in app2.js).
  await page.addInitScript(() => {
    window.__candidates = [];
    const origPush = Array.prototype.push;
    let pushCount = 0;
    Array.prototype.push = function (...args) {
      if (this === window.__candidates) return origPush.apply(this, args);
      pushCount++;
      if (pushCount < 300000) {
        try {
          if (args.length && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Node)) {
            const item = args[0];
            const keys = Object.keys(item);
            if (keys.length > 0 && keys.length < 40) {
              origPush.call(window.__candidates, { keys, sample: item });
            }
          }
        } catch (e) {}
      }
      return origPush.apply(this, args);
    };
  });

  console.log('Navigating...');
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'recon/before_click.png' });

  // Try to find and click the exact "PLAY" button (leaf element, exact text match)
  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, div, a, span'));
    const exact = all.filter(el => el.children.length === 0 && (el.textContent || '').trim().toUpperCase() === 'PLAY' && el.offsetParent !== null);
    const pool = exact.length ? exact : all.filter(el => /^play$/i.test((el.textContent || '').trim()) && el.offsetParent !== null);
    if (pool.length) {
      const rect = pool[0].getBoundingClientRect();
      pool[0].click();
      return { text: pool[0].textContent, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
    }
    return null;
  });
  console.log('Clicked element:', JSON.stringify(clicked));
  await page.waitForTimeout(2000);

  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'recon/mid_click.png' });
  console.log('Waiting out possible ad interstitial...');
  await page.waitForTimeout(32000);
  await page.screenshot({ path: 'recon/after_ad.png' });
  // steer to trigger movement/updates
  await page.mouse.move(700, 300).catch(() => {});
  await page.waitForTimeout(1000);
  await page.mouse.move(500, 500).catch(() => {});
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'recon/after_click.png' });

  // Now inspect candidates for shapes that look like game units (x,y, hp, angle, etc.)
  const summary = await page.evaluate(() => {
    const seen = new Map();
    for (const c of window.__candidates) {
      const key = c.keys.slice().sort().join(',');
      if (!seen.has(key)) seen.set(key, { count: 0, sample: c.sample });
      seen.get(key).count++;
    }
    return Array.from(seen.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 40)
      .map(([key, v]) => ({ keys: key, count: v.count, sample: safeStringify(v.sample) }));

    function safeStringify(obj) {
      try {
        return JSON.stringify(obj, (k, v) => {
          if (typeof v === 'function') return '[fn]';
          if (typeof v === 'object' && v !== null && v.constructor && v.constructor.name === 'HTMLCanvasElement') return '[canvas]';
          return v;
        }).slice(0, 500);
      } catch (e) {
        return '[unstringifiable]';
      }
    }
  });

  console.log('\n=== Candidate pushed-object shapes (by key-set), top 40 ===');
  console.log(JSON.stringify(summary, null, 2));

  const unitLike = await page.evaluate(() => {
    const re = /isPlayer|nick|angle|radius|alive|botLevel|score|territory/i;
    const hits = [];
    const seenKeys = new Set();
    for (const c of window.__candidates) {
      if (c.keys.some(k => re.test(k))) {
        const keyStr = c.keys.slice().sort().join(',');
        if (seenKeys.has(keyStr)) continue;
        seenKeys.add(keyStr);
        let sample;
        try {
          sample = JSON.stringify(c.sample, (k, v) => (typeof v === 'function' ? '[fn]' : v)).slice(0, 800);
        } catch (e) { sample = '[unstringifiable]'; }
        hits.push({ keys: c.keys, sample });
      }
      if (hits.length > 20) break;
    }
    return hits;
  });
  console.log('\n=== Unit-like candidates (isPlayer/nick/angle/radius/...) ===');
  console.log(JSON.stringify(unitLike, null, 2));

  const unitDump = await page.evaluate(() => {
    for (let i = window.__candidates.length - 1; i >= 0; i--) {
      const c = window.__candidates[i];
      if (c.keys.includes('unit') && c.sample && c.sample.unit) {
        const u = c.sample.unit;
        const own = Object.getOwnPropertyNames(u);
        const proto = Object.getPrototypeOf(u);
        const protoMethods = proto ? Object.getOwnPropertyNames(proto) : [];
        let vals = {};
        for (const k of own) {
          try {
            const v = u[k];
            if (typeof v === 'object' && v !== null) {
              vals[k] = '{' + Object.keys(v).join(',') + '}';
            } else if (typeof v === 'function') {
              vals[k] = '[fn]';
            } else {
              vals[k] = v;
            }
          } catch (e) { vals[k] = '[err]'; }
        }
        return { ownProps: own, protoMethods, vals };
      }
    }
    return null;
  });
  console.log('\n=== Sample Unit object (own props + values) ===');
  console.log(JSON.stringify(unitDump, null, 2));

  const gameDump = await page.evaluate(() => {
    function shallow(obj, depth = 1) {
      if (obj === null || typeof obj !== 'object') return obj;
      const out = {};
      for (const k of Object.getOwnPropertyNames(obj)) {
        try {
          const v = obj[k];
          if (typeof v === 'function') { out[k] = '[fn]'; continue; }
          if (Array.isArray(v)) { out[k] = `[array len=${v.length}]` + (v.length ? ' first=' + JSON.stringify(shallow(v[0], depth - 1)).slice(0, 200) : ''); continue; }
          if (typeof v === 'object' && v !== null) {
            out[k] = depth > 0 ? shallow(v, depth - 1) : '{' + Object.keys(v).join(',') + '}';
            continue;
          }
          out[k] = v;
        } catch (e) { out[k] = '[err]'; }
      }
      return out;
    }
    for (let i = window.__candidates.length - 1; i >= 0; i--) {
      const c = window.__candidates[i];
      if (c.keys.includes('unit') && c.sample && c.sample.unit && c.sample.unit.game) {
        const g = c.sample.unit.game;
        return {
          player: shallow(g.player, 1),
          space: shallow(g.space, 1),
          border: shallow(g.border, 0),
          config: shallow(g.config, 1),
          unitsLen: g.units ? g.units.length : null,
          botsLen: g.bots ? g.bots.length : null,
          direction: g.direction,
          mouse: shallow(g.mouse, 0),
          keyboard: shallow(g.keyboard, 0),
        };
      }
    }
    return null;
  });
  console.log('\n=== game.player / game.space / game.border / game.config ===');
  console.log(JSON.stringify(gameDump, null, 2));

  console.log('\nLeaving browser open 10s for manual play...');
  await page.waitForTimeout(10000);

  await browser.close();
})();
