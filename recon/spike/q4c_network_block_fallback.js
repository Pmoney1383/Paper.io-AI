// Q4 (fallback): if spawnPlayer() doesn't cleanly bypass the ad gate, the
// next-best approach is blocking the ad-network requests at the Playwright
// routing layer (page.route), verified headless, with no extension. This
// targets the interstitial specifically, not general ad noise.
const { chromium } = require('playwright');
const { installGameHook } = require('./hooks');

// Domains observed in Phase 0 recon driving the forced pre-game video
// interstitial (adinplay tag/ad-manager network + its video player).
const BLOCK_PATTERNS = [
  /adinplay\.com/,
  /doubleclick\.net/,
  /googlesyndication\.com/,
  /gameads\.io/,
  /imasdk\.googleapis\.com/,
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGameHook);

  let blockedCount = 0;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (BLOCK_PATTERNS.some((re) => re.test(url))) {
      blockedCount++;
      return route.abort();
    }
    return route.continue();
  });

  console.log('Navigating (headless, no extension, route-level blocking)...');
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);

  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, div, a, span'));
    const exact = all.filter(el => el.children.length === 0 && (el.textContent || '').trim().toUpperCase() === 'PLAY' && el.offsetParent !== null);
    if (exact.length) { exact[0].click(); return true; }
    return false;
  });
  console.log('Clicked PLAY:', clicked, '| ad-network requests blocked so far:', blockedCount);

  const start = Date.now();
  let spawned = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const g = window.__game;
      if (!g || !g.player) return null;
      return { death: g.player.death, cycle: g.cycle };
    });
    if (state && !state.death) {
      spawned = true;
      console.log(`Spawned after ${Date.now() - start}ms (headless, route-blocked)`);
      break;
    }
  }
  if (!spawned) console.log('Did not detect a live player within 10s poll window.');

  console.log('Total ad-network requests blocked:', blockedCount);
  await browser.close();
})();
