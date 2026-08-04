"""
PaperIOEnv: a Gymnasium env driving the live paperio.site game via Playwright.

Built entirely on mechanisms verified in recon/spike/*.js and tests/hooks.test.js:
  - state is read directly from the exposed game object graph, no CV needed.
  - performance.now/requestAnimationFrame overrides decouple simulation time
    from wall-clock time (game.loop() called directly, ~60x+ speedup).
  - window.paperio2api.create()+prepare() is a genuine world reset (unlike
    spawnPlayer() alone, which leaves world state accumulating indefinitely).
  - discrete arrow-key steering (verified empirically: ArrowRight/Down/Left/Up
    map to direction 0, pi/2, pi, 3pi/2 respectively).

Observation: fixed-size feature vector (not pixels/CNN - see OBSERVE_JS in
hooks.py), computed in-browser: player position/heading/percent, distance to
arena border, a vector back to where the current trail started (the only way
the policy can know which direction leads home - without it, closing a loop
isn't a learnable behavior, not just an unlikely one), current trail length,
and the K nearest other units' relative position + alive flag.

Reward shaping: territory gain is the dominant signal (large positive reward
scaled by percent captured), the alive bonus is small (staying alive with no
progress should not look like a good strategy), an escalating penalty grows
with how long the current trail has been open (discourages running in one
direction indefinitely - the reward degrades the longer a loop stays
unclosed), and death carries a heavier penalty scaled by territory held.
"""
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from playwright.sync_api import sync_playwright

from paperio_rl import hooks

URL = "https://paperio.site/"
K_NEAREST = 5
OBS_DIM = 9 + K_NEAREST * 3  # 6 base + homeDx/homeDy/trailLenNorm + K*(dx,dy,alive)
TICKS_PER_STEP = 3          # frame-skip: ~10Hz decisions at 33ms/tick (~30fps-equivalent sim rate)
MS_PER_TICK = 33
MAX_EPISODE_TICKS = 2000    # safety cap (~66s simulated) so a passive agent can't run forever
READY_POLL_ATTEMPTS = 40
READY_POLL_INTERVAL_MS = 200

# action index -> key. Order chosen to match Discrete(4) with a stable,
# documented mapping (0=up, 1=right, 2=down, 3=left).
ARROW_KEYS = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]

ALIVE_BONUS = 0.005
TERRITORY_REWARD_SCALE = 100.0
DEATH_PENALTY_BASE = -2.0
DEATH_PENALTY_TERRITORY_SCALE = 1.0
# Escalating cost for keeping a trail open: -TRAIL_PENALTY_SCALE per trail
# point beyond TRAIL_FREE_POINTS. A straight line that never turns back
# racks this up every step with nothing to offset it, which a pure alive
# bonus never punished before.
TRAIL_PENALTY_SCALE = 0.003
TRAIL_FREE_POINTS = 10


class PaperIOEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, headless: bool = True, nav_timeout_ms: int = 60000):
        super().__init__()
        self.headless = headless
        self.nav_timeout_ms = nav_timeout_ms

        self.action_space = spaces.Discrete(len(ARROW_KEYS))
        self.observation_space = spaces.Box(low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32)

        self._playwright = None
        self._browser = None
        self._page = None
        self._held_key = None
        self._ticks_this_episode = 0
        self._last_percent = 0.0

        self._launch()

    def _launch(self):
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=self.headless)
        self._page = self._browser.new_page(viewport={"width": 1280, "height": 800})
        self._page.add_init_script(hooks.INSTALL_GAME_HOOK)
        self._page.add_init_script(hooks.INSTALL_CLOCK_HOOK)
        if self.headless:
            # Rendering is pure waste for a browser nobody looks at (verified
            # zero effect on simulation correctness in the throughput spike).
            # For a visible instance we skip this so there's actually
            # something on screen.
            self._page.add_init_script(hooks.INSTALL_CANVAS_STUB)
        self._page.goto(URL, wait_until="load", timeout=self.nav_timeout_ms)
        self._wait_for_game_ready()
        if not self.headless:
            # We drive the game entirely through window.__game / paperio2api,
            # never through the UI - so the menu overlay (name field, PLAY
            # button, banner ad) never gets dismissed on its own, since
            # nothing ever tells it to. It's a pure display issue (training
            # works identically underneath); hide it so the canvas is
            # actually visible instead of a static ad-covered menu screen.
            # Bring the canvas to the front instead of hiding everything
            # else: #view is nested inside a wrapper div, not a direct body
            # child, so "hide every body child except #view" also hides the
            # wrapper #view itself lives in (opacity is inherited/composited
            # from ancestors), leaving the canvas invisible even though it's
            # excluded by the selector. z-index avoids needing to know the
            # DOM structure at all - just stack the canvas on top of
            # whatever the menu/ad overlay is.
            self._page.add_style_tag(content="""
                #view { position: fixed !important; top: 0 !important; left: 0 !important; z-index: 2147483647 !important; opacity: 1 !important; }
            """)

    def _wait_for_game_ready(self):
        for _ in range(READY_POLL_ATTEMPTS):
            if self._page.evaluate(hooks.GAME_READY_JS):
                return
            self._page.wait_for_timeout(READY_POLL_INTERVAL_MS)
        raise RuntimeError("paperio.site game object never became ready")

    def _release_held_key(self):
        if self._held_key is not None:
            try:
                self._page.keyboard.up(self._held_key)
            except Exception:
                pass
            self._held_key = None

    def _read_obs(self):
        result = self._page.evaluate(hooks.OBSERVE_JS, K_NEAREST)
        if result is None:
            return np.zeros(OBS_DIM, dtype=np.float32), {"alive": False, "percent": 0.0, "cycle": None, "trailLen": 0}
        obs = np.asarray(result["obs"], dtype=np.float32)
        info = {"alive": result["alive"], "percent": result["percent"], "cycle": result["cycle"], "trailLen": result["trailLen"]}
        return obs, info

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self._release_held_key()
        self._page.evaluate(hooks.RESET_WORLD_JS)
        self._ticks_this_episode = 0
        if not self.headless:
            self._page.evaluate(hooks.NUDGE_REPAINT_JS)
        obs, info = self._read_obs()
        self._last_percent = info["percent"]
        return obs, info

    def step(self, action):
        key = ARROW_KEYS[int(action)]
        if key != self._held_key:
            self._release_held_key()
            self._page.keyboard.down(key)
            self._held_key = key

        self._page.evaluate(hooks.TICK_N_JS, {"n": TICKS_PER_STEP, "ms": MS_PER_TICK})
        self._ticks_this_episode += TICKS_PER_STEP
        if not self.headless:
            # See hooks.NUDGE_REPAINT_JS - without this the visible window
            # never actually shows anything past the very first frame, since
            # requestAnimationFrame (what the browser's compositor waits on
            # to repaint) is neutralized everywhere else for speed.
            self._page.evaluate(hooks.NUDGE_REPAINT_JS)

        obs, info = self._read_obs()
        percent = info["percent"]
        alive = info["alive"]
        trail_len = info["trailLen"] or 0

        reward = ALIVE_BONUS
        reward += (percent - self._last_percent) * TERRITORY_REWARD_SCALE
        reward -= TRAIL_PENALTY_SCALE * max(0, trail_len - TRAIL_FREE_POINTS)
        self._last_percent = percent

        terminated = not alive
        truncated = self._ticks_this_episode >= MAX_EPISODE_TICKS

        if terminated:
            reward += DEATH_PENALTY_BASE - DEATH_PENALTY_TERRITORY_SCALE * percent
            self._release_held_key()

        return obs, float(reward), terminated, truncated, info

    def close(self):
        self._release_held_key()
        try:
            if self._browser:
                self._browser.close()
        except Exception:
            pass
        try:
            if self._playwright:
                self._playwright.stop()
        except Exception:
            pass
        self._browser = None
        self._page = None
        self._playwright = None
