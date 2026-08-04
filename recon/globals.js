const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const requests = [];
  page.on('websocket', ws => {
    console.log('WEBSOCKET:', ws.url());
    ws.on('framereceived', event => {
      if (requests.length < 10) {
        requests.push(event.payload);
        console.log('WS frame received (first 200 bytes):', String(event.payload).slice(0, 200));
      }
    });
    ws.on('framesent', event => {
      if (requests.length < 20) {
        console.log('WS frame sent (first 200 bytes):', String(event.payload).slice(0, 200));
      }
    });
  });

  console.log('Navigating to https://paperio.site/ ...');
  await page.goto('https://paperio.site/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Dump top-level window keys not present in a blank page
  const info = await page.evaluate(() => {
    const blankGlobals = new Set([
      'window','self','document','name','location','customElements','history','navigation',
      'locationbar','menubar','personalbar','scrollbars','statusbar','toolbar','status','closed',
      'frames','length','top','opener','parent','frameElement','navigator','origin','external',
      'screen','innerWidth','innerHeight','scrollX','pageXOffset','scrollY','pageYOffset',
      'visualViewport','screenX','screenY','outerWidth','outerHeight','devicePixelRatio',
      'clientInformation','screenLeft','screenTop','styleMedia','onsearch','trustedTypes',
      'performance','onappinstalled','onbeforeinstallprompt','crypto','indexedDB',
      'sessionStorage','localStorage','onbeforexrselect','onabort','onbeforeinput','onbeforematch',
      'onbeforetoggle','onblur','oncancel','oncanplay','oncanplaythrough','onchange','onclick',
      'onclose','oncontentvisibilityautostatechange','oncontextlost','oncontextmenu',
      'oncontextrestored','oncuechange','ondblclick','ondrag','ondragend','ondragenter',
      'ondragleave','ondragover','ondragstart','ondrop','ondurationchange','onemptied','onended',
      'onerror','onfocus','onformdata','oninput','oninvalid','onkeydown','onkeypress','onkeyup',
      'onload','onloadeddata','onloadedmetadata','onloadstart','onmousedown','onmouseenter',
      'onmouseleave','onmousemove','onmouseout','onmouseover','onmouseup','onmousewheel',
      'onpause','onplay','onplaying','onprogress','onratechange','onreset','onresize','onscroll',
      'onsecuritypolicyviolation','onseeked','onseeking','onselect','onslotchange','onstalled',
      'onsubmit','onsuspend','ontimeupdate','ontoggle','onvolumechange','onwaiting',
      'onwebkitanimationend','onwebkitanimationiteration','onwebkitanimationstart',
      'onwebkittransitionend','onwheel','onauxclick','ongotpointercapture','onlostpointercapture',
      'onpointerdown','onpointermove','onpointerrawupdate','onpointerup','onpointercancel',
      'onpointerover','onpointerout','onpointerenter','onpointerleave','onselectstart',
      'onselectionchange','onanimationend','onanimationiteration','onanimationstart',
      'onanimationcancel','ontransitionrun','ontransitionstart','ontransitionend',
      'ontransitioncancel','onafterprint','onbeforeprint','onbeforeunload','onhashchange',
      'onlanguagechange','onmessage','onmessageerror','onoffline','ononline','onpagehide',
      'onpageshow','onpopstate','onrejectionhandled','onstorage','onunhandledrejection',
      'onunload','isSecureContext','crossOriginIsolated','scheduler','alert','confirm','prompt',
      'print','postMessage','captureEvents','releaseEvents','requestAnimationFrame',
      'cancelAnimationFrame','requestIdleCallback','cancelIdleCallback','queueMicrotask',
      'createImageBitmap','structuredClone','fetch','btoa','atob','setTimeout','clearTimeout',
      'setInterval','clearInterval','getComputedStyle','matchMedia','moveTo','moveBy','resizeTo',
      'resizeBy','scroll','scrollTo','scrollBy','open','showOpenFilePicker','showSaveFilePicker',
      'showDirectoryPicker','getScreenDetails','queryLocalFonts','showDirectoryPicker','close',
      'focus','blur','onpageswap','onpagereveal','speechSynthesis','onscrollend','chrome',
      'trustedTypes','caches','cookieStore','launchQueue','documentPictureInPicture',
      'getDigitalGoodsService','originAgentCluster','credentialless','fence','sharedStorage',
      'ondevicemotion','ondeviceorientation','ondeviceorientationabsolute','onidlestatechange',
      'GPU','WebAssembly','Reflect','Proxy'
    ]);
    const keys = Object.getOwnPropertyNames(window).filter(k => !blankGlobals.has(k) && !k.startsWith('webkit'));
    return keys.sort();
  });

  console.log('\n=== Non-standard window globals ===');
  console.log(info);

  // Check canvases
  const canvases = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('canvas')).map(c => ({
      id: c.id,
      className: c.className,
      width: c.width,
      height: c.height,
      cssWidth: c.style.width,
      cssHeight: c.style.height,
      is2d: !!(c.getContext && c.__contextType) || null,
    }));
  });
  console.log('\n=== Canvases ===');
  console.log(JSON.stringify(canvases, null, 2));

  await page.screenshot({ path: 'recon/initial_load.png' });
  console.log('\nScreenshot saved to recon/initial_load.png');
  console.log('\nLeaving browser open for 90s for manual play / inspection...');
  await page.waitForTimeout(90000);

  await browser.close();
})();
