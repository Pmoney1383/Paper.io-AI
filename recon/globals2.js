const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });

  // Baseline: blank page globals
  const blankPage = await browser.newPage();
  await blankPage.goto('about:blank');
  const blankKeys = await blankPage.evaluate(() => Object.getOwnPropertyNames(window));
  await blankPage.close();
  const blankSet = new Set(blankKeys);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  console.log('Navigating to https://paperio.site/ ...');
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(6000);

  const customKeys = await page.evaluate((blank) => {
    const blankSet = new Set(blank);
    return Object.getOwnPropertyNames(window).filter(k => !blankSet.has(k));
  }, blankKeys);

  console.log('\n=== Custom (non-blank-page) window globals ===');
  console.log(JSON.stringify(customKeys, null, 2));

  // For each custom key, report its type
  const typed = await page.evaluate((keys) => {
    const out = {};
    for (const k of keys) {
      try {
        const v = window[k];
        const t = typeof v;
        if (t === 'object' && v !== null) {
          out[k] = { type: t, ctor: v.constructor ? v.constructor.name : null, keys: Object.keys(v).slice(0, 30) };
        } else if (t === 'function') {
          out[k] = { type: t, name: v.name };
        } else {
          out[k] = { type: t, value: String(v).slice(0, 100) };
        }
      } catch (e) {
        out[k] = { error: String(e) };
      }
    }
    return out;
  }, customKeys);
  console.log('\n=== Details ===');
  console.log(JSON.stringify(typed, null, 2));

  // Canvas / rendering detection
  const canvasInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('canvas')).map(c => {
      let ctxType = 'unknown';
      let webglInfo = null;
      const proto = Object.getPrototypeOf(c);
      // Try to detect which context was already created without creating a new one (avoid "already 2d/webgl" conflicts)
      for (const t of ['2d', 'webgl', 'webgl2', 'experimental-webgl', 'bitmaprenderer']) {
        try {
          const ctx = c.getContext(t);
          if (ctx) { ctxType = t; break; }
        } catch (e) {}
      }
      return {
        id: c.id, className: c.className, width: c.width, height: c.height,
        cssWidth: getComputedStyle(c).width, cssHeight: getComputedStyle(c).height,
        contextType: ctxType
      };
    });
  });
  console.log('\n=== Canvas info ===');
  console.log(JSON.stringify(canvasInfo, null, 2));

  // Check for global game/socket-like keywords anywhere on window (including nested one level)
  const interesting = await page.evaluate(() => {
    const hits = [];
    const re = /(game|player|snake|score|zone|territory|socket|room|world|state|self)/i;
    for (const k of Object.getOwnPropertyNames(window)) {
      if (re.test(k)) hits.push(k);
    }
    return hits;
  });
  console.log('\n=== Keys matching game-related keywords ===');
  console.log(JSON.stringify(interesting, null, 2));

  await page.screenshot({ path: 'recon/loaded.png' });

  // list network requests / scripts loaded
  await browser.close();
})();
