"""Diagnose why the visible canvas shows only flat background color."""
from playwright.sync_api import sync_playwright
from paperio_rl import hooks

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.add_init_script(hooks.INSTALL_GAME_HOOK)
    page.add_init_script(hooks.INSTALL_CLOCK_HOOK)
    # instrument (not stub) canvas calls this time
    page.add_init_script("""
        (function() {
            const proto = CanvasRenderingContext2D.prototype;
            window.__drawCalls = {};
            for (const name of ['fillRect','strokeRect','clearRect','fill','stroke','arc','drawImage','beginPath','moveTo','lineTo']) {
                const orig = proto[name];
                if (!orig) continue;
                proto[name] = function(...args) {
                    window.__drawCalls[name] = (window.__drawCalls[name]||0)+1;
                    return orig.apply(this, args);
                };
            }
        })();
    """)
    page.goto("https://paperio.site/", wait_until="load", timeout=60000)
    for _ in range(40):
        if page.evaluate(hooks.GAME_READY_JS):
            break
        page.wait_for_timeout(200)

    page.evaluate(hooks.RESET_WORLD_JS)

    info = page.evaluate("""
        () => {
            const g = window.__game;
            const c = document.getElementById('view') || document.querySelector('canvas');
            return {
                scale: g.scale, angle: g.angle, origin: g.origin,
                visible: g.visible, stopped: g.stopped,
                canvasWidth: c.width, canvasHeight: c.height,
                canvasCssWidth: getComputedStyle(c).width, canvasCssHeight: getComputedStyle(c).height,
                playerPos: g.player ? {x: g.player.position.x, y: g.player.position.y} : null,
            };
        }
    """)
    print("game/canvas info:", info)

    page.evaluate(hooks.TICK_N_JS, {"n": 60, "ms": 33})
    calls = page.evaluate("() => window.__drawCalls")
    print("draw calls after 60 ticks:", calls)

    # sample actual pixel colors at a few points to see if ANYTHING non-background got drawn
    pixel_check = page.evaluate("""
        () => {
            const c = document.getElementById('view');
            const ctx = c.getContext('2d');
            const w = c.width, h = c.height;
            const samples = [];
            for (const [x,y] of [[w/2,h/2],[w/4,h/4],[w*0.75,h*0.75],[10,10]]) {
                const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
                samples.push({x,y, rgba:[d[0],d[1],d[2],d[3]]});
            }
            return { canvasSize: [w,h], samples };
        }
    """)
    print("pixel samples:", pixel_check)

    browser.close()
