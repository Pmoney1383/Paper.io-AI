const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const wsUrls = new Set();
  page.on('websocket', ws => wsUrls.add(ws.url()));

  const jsRequests = [];
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('javascript') || res.url().endsWith('.js')) {
      jsRequests.push(res.url());
    }
  });

  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(6000);

  console.log('=== WebSocket URLs ===');
  console.log([...wsUrls]);

  console.log('\n=== JS files loaded ===');
  console.log(jsRequests);

  console.log('\n=== <script> tags in DOM ===');
  const scriptSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script')).map(s => s.src || '(inline, len=' + s.textContent.length + ')')
  );
  console.log(scriptSrcs);

  await browser.close();
})();
