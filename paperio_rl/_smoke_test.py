"""Throwaway smoke test for hooks.py - not part of the package, just a quick
sanity check that the Python port of the JS hooks behaves like the Node
originals before building the full gym env on top of them.
"""
import time
from playwright.sync_api import sync_playwright
from paperio_rl import hooks


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.add_init_script(hooks.INSTALL_GAME_HOOK)
        page.add_init_script(hooks.INSTALL_CLOCK_HOOK)
        page.goto("https://paperio.site/", wait_until="load", timeout=60000)

        for _ in range(40):
            if page.evaluate(hooks.GAME_READY_JS):
                break
            page.wait_for_timeout(200)
        else:
            raise RuntimeError("game never became ready")
        print("game ready")

        before = page.evaluate(hooks.SNAPSHOT_WORLD_JS)
        print("before reset:", before["cycle"], before["cellsPointCount"], before["unitCount"])

        result = page.evaluate(hooks.RESET_WORLD_JS)
        print("reset result:", result)

        after = page.evaluate(hooks.SNAPSHOT_WORLD_JS)
        print("after reset:", after["cycle"], after["cellsPointCount"], after["unitCount"], "hasPlayer=", after["player"] is not None)

        assert after["cycle"] < before["cycle"], "reset should drop cycle"

        # cycle-verify ticking
        cycle0 = page.evaluate("() => window.__game.cycle")
        t0 = time.time()
        page.evaluate(hooks.TICK_N_JS, {"n": 500, "ms": 33})
        elapsed = time.time() - t0
        cycle1 = page.evaluate("() => window.__game.cycle")
        print(f"ticked 500, cycle delta={cycle1 - cycle0}, wall={elapsed*1000:.1f}ms")
        assert cycle1 - cycle0 == 500, "cycle delta should exactly match requested ticks"

        state = page.evaluate(hooks.READ_MINIMAL_STATE_JS)
        print("state after ticking:", state)

        browser.close()
        print("\nSMOKE TEST PASSED")


if __name__ == "__main__":
    main()
