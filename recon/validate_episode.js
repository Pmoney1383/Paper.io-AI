const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { installGameHook, readState } = require('./extract_state');

const EXT_PATH = path.join(__dirname, 'ext', 'stands-adblocker');
const USER_DATA_DIR = path.join(__dirname, '.pw-profile');

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
  const page = context.pages()[0] || (await context.newPage());
  await context.addInitScript(installGameHook);

  console.log('Navigating...');
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);

  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, div, a, span'));
    const exact = all.filter(el => el.children.length === 0 && (el.textContent || '').trim().toUpperCase() === 'PLAY' && el.offsetParent !== null);
    if (exact.length) { exact[0].click(); return true; }
    return false;
  });
  console.log('Clicked PLAY:', clicked);
  await page.waitForTimeout(800);

  const samples = [];
  const startTime = Date.now();
  const durationMs = 15000;
  let angle = 0;
  const center = { x: 640, y: 400 };
  const radius = 200;

  while (Date.now() - startTime < durationMs) {
    // Steer in a circle around the canvas center so the player actually
    // carves out territory instead of idling (idling let it die passively
    // in the ad-block smoke test).
    angle += 0.25;
    const mx = center.x + Math.cos(angle) * radius;
    const my = center.y + Math.sin(angle) * radius;
    await page.mouse.move(mx, my);

    const state = await page.evaluate(readState);
    samples.push({ t: Date.now() - startTime, ...state });

    if (state.ready && state.alive === false) {
      console.log(`Died at t=${Date.now() - startTime}ms, final percent=${state.percent}`);
      break;
    }
    await page.waitForTimeout(100);
  }

  fs.writeFileSync(path.join(__dirname, 'episode_samples.json'), JSON.stringify(samples, null, 2));

  const readySamples = samples.filter(s => s.ready);
  console.log(`\nTotal samples: ${samples.length}, ready: ${readySamples.length}`);
  if (readySamples.length) {
    const first = readySamples[0];
    const last = readySamples[readySamples.length - 1];
    console.log('First sample:', JSON.stringify({ t: first.t, x: first.player.x, y: first.player.y, percent: first.percent, alive: first.alive, unitCount: first.units.length }));
    console.log('Last sample:', JSON.stringify({ t: last.t, x: last.player.x, y: last.player.y, percent: last.percent, alive: last.alive, unitCount: last.units.length }));
    const xs = readySamples.map(s => s.player.x);
    const ys = readySamples.map(s => s.player.y);
    console.log('Position range: x[', Math.min(...xs), ',', Math.max(...xs), '] y[', Math.min(...ys), ',', Math.max(...ys), ']');
    const percents = readySamples.map(s => s.percent);
    console.log('Percent range:', Math.min(...percents), '->', Math.max(...percents));
  }

  await page.screenshot({ path: 'recon/episode_end.png' });
  await page.waitForTimeout(1500);
  await context.close();
})();
