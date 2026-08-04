# paper.io RL Agent — Project Plan (v2, post-recon)

Train a neural network via reinforcement learning to play **Paper.io 2** (paperio.site).

> **v2 changes:** Phase 0 recon found the game is fully client-side with complete state exposed in JS. **Phase 1 (CV perception) is cut entirely.** Time control is now possible, which collapses the throughput problem. See findings below.

---

## Phase 0 findings — RESOLVED ✅

**paperio.site is Paper.io 2, fully client-side. No game server.**
- Zero `wss://` / WebSocket references in the ~240KB `app2.js` bundle. Only websocket in session is Yandex analytics.
- Entire simulation runs as a plain in-memory object graph.

### Exposed state (replaces everything CV was going to approximate)

Every `Unit` carries `unit.game`, a reference to the root singleton — reachable from anywhere.

| Path | Contents |
|---|---|
| `game.player` | `position {x,y}`, `percent`/`bestPercent` (exact territory %), `death`, `direction` (radians), `track.polyline`/`simplyline` (trail), `base.polygon` (owned territory), `in.polygon` (swept-but-unclaimed) |
| `game.units[]` | 16 units (1 player + `botsCount: 15`), same shape as player, plus bot AI internals: `aggro`, `greed`, `safety`, `def`, `targets`, `maxDanger`, `unitDanger`, `distanceDanger` |
| `game.space` | Arena grid — `width/height: 2000`, `w/h: 100` cells of `size: 20`, spatial-hash `cells[]` |
| `game.border` | Boundary polygon, `radius: 950`, center |
| `game.config` | `unitSpeed: 90`, `baseRadius: 30`, `botsCount: 15`, `trackWidth: 8`, `spawnTimeout: 3000`, bot aggro/greed/safety/def ranges |
| `game.controller` | Both discrete `up/down/left/right` AND continuous `mouse` angle-steering, plus `buttons`/`codes`/`pressedButtons` |
| `game.cycle`, `game.last`, `game.stats.fps` | Loop timing |

### Access bootstrap
No clean `window.game`. Hook `Array.prototype.push` via `page.addInitScript()` **before navigation**, capture the first Unit-shaped object, read `.game` off it, cache as `window.__game`. One-time, reliable. Afterwards `page.evaluate()` is plain object access against a **live reference**, not a copy.

### Rendering
Single `<canvas id="view">`, 2D context (not WebGL), viewport-sized. **Irrelevant now** — we never read pixels.

---

## Consequences (the parts that reshape the plan)

### 1. Time decoupling — the big one
No server means **nothing is authoritative except the tab**. Override `requestAnimationFrame` / `performance.now()` / `Date.now()` via `addInitScript` and drive the loop manually — pump N ticks per `evaluate()` call instead of waiting on wall-clock.

The original ~30hr training estimate assumed being locked to a live server tick. **That constraint doesn't exist.** Combined with stubbing canvas draw calls (pure waste now), a single instance could plausibly hit **100–1000× real-time**.

→ Parallel browsers drop from "main throughput fix" to "nice-to-have, maybe unnecessary."

### 2. Kill the ad gate, don't script around it
Site is heavy with ad-tech (adinplay, doubleclick, rubicon, prebid, gameads.io) and forces a ~30s video interstitial after PLAY.
- Playwright `route()` → abort those domains.
- Better: find the game's start/restart function on the object graph and **call it directly**. `reset()` becomes a function call, not a UI dance.

### 3. Observation space — still a grid, but exact
Tempting to feed a flat state vector now. Don't — a vector of "my position + 15 bot positions" discards **territory shape**, which is the actual game. Spatial structure is what makes the CNN worth using.

Rasterize exactly from `base.polygon` / `in.polygon` / `game.space.cells` instead of approximating from pixels.

**Check first:** if `space.cells` (100×100) is already an ownership grid, it's a single `cv2.resize(..., INTER_NEAREST)` down to 40×40 and you're done — zero geometry work. (`INTER_NEAREST` matters: nearest-neighbor preserves discrete class labels; bilinear blends your territory into an enemy's and produces garbage cells.)

### 4. Bot AI fields are a trap
`aggro`/`greed`/`safety`/`unitDanger` are visible and tempting. **Do not put them in the observation** — that's info a real opponent wouldn't broadcast, and you'd train a policy that can't function without it. Fine to use *offline* for reward shaping or curriculum design.

### 5. Scope honesty
15 fixed-AI bots = "mastering paper.io 2" means beating a **static bot roster**. No opponent adaptation; once you beat them, you're done. Raise `botsCount` for a difficulty curriculum if you want the challenge to scale.

### 6. Seed the RNG
Find it and fix it. Reproducible episodes make RL debugging vastly less painful.

---

## Stack (revised)

| Component | Choice | Why |
|---|---|---|
| Browser control | Playwright (Chromium, headless) | Scriptable, `addInitScript`, multi-context |
| State extraction | **`page.evaluate()` against `window.__game`** | Exact, cheap — replaces screencast + OpenCV |
| Frame capture | ~~CDP screencast~~ | **Cut** — no pixels needed |
| CV | OpenCV (`resize` only, if even that) | Grid downsampling; the masking pipeline is gone |
| RL | `stable-baselines3` PPO | Discrete action space |
| Time control | `rAF`/`Date.now` override + canvas stubbing | Decouples sim from wall-clock |
| Compute | RTX 5080 | Now actually usable — the game was the old bottleneck |

---

## ~~Phase 1 — Perception~~ CUT

Color masking, contour detection, enemy color-clustering, the debug-overlay gate — **all unnecessary.** State is exact and free.

---

## Phase 1 (new) — Environment wrapper

Gym-style `PaperIOEnv` with `reset()` / `step(action)`.

- [ ] `addInitScript`: hook `Array.prototype.push` → cache `window.__game`.
- [ ] `addInitScript`: override `requestAnimationFrame` / `performance.now()` / `Date.now()` for manual tick control.
- [ ] `addInitScript`: stub canvas 2D draw calls (no-op the context methods).
- [ ] `route()` abort on ad domains.
- [ ] `reset()`: call the game's start/restart directly. Hook `game.gameOverCallback` and/or poll `game.player.death` for episode end — **no death-screen template matching needed**.
- [ ] `step(action)`: set `game.controller` input → pump N ticks → read state → build observation → compute reward.
- [ ] **Action space: discrete(4)** (`up/down/left/right`). Continuous `mouse` angle-steering is also available — we get to *choose* rather than being forced by pixel-input limits. Start discrete; it's a smaller space and matches the grid observation.
- [ ] Observation: 40×40×N grid (own territory / own trail / enemy territory / enemy trails / open), frame-stacked ×4.

### Reward shaping
Raw territory is far too sparse — the agent dies ~100× before capturing anything.

| Event | Reward |
|---|---|
| Per step alive | `+0.01` |
| Distance traveled outside own base | small positive (encourages expansion) |
| Territory claimed (loop closure) | `+0.1 × Δpercent` — now **exact**, via `player.percent`, not pixel-counted |
| Death | `-1 - 0.5 × territory_held` |

Scaling death penalty by territory held makes dying with a big base hurt more than dying instantly.

**Gate:** random-action agent, 50 episodes. `reset()` must succeed 50/50 before training anything.

---

## Phase 2 — Agent

- [ ] PPO from `stable-baselines3`.
- [ ] Small CNN over the 40×40×N grid → flatten → FC head → 4 logits → softmax. 3 conv layers is plenty.
- [ ] Frame-stack 4 so the policy can infer motion/direction.
- [ ] ~150 lines of boilerplate.

**Why a CNN:** it's a *feature extractor*, not an action predictor. Conv stack compresses the grid into features ("enemy trail close on the right, open territory ahead"); a small FC **policy head** maps those to 4 direction scores. Sample from softmax when training, argmax at eval.
Over a plain MLP it buys *translation invariance* (one filter reused everywhere vs. a separate weight per cell) and *spatial locality* (baked into conv kernels; an MLP brute-forces it). Fewer params, faster convergence, better generalization to unseen territory shapes.

---

## Phase 3 — Throughput

**Try in this order — you may stop after step 1.**

1. **Time acceleration** (see Consequence #1). Ticks-per-second, not steps-per-hour. Measure actual speedup before adding complexity.
2. **Batch `evaluate()` calls.** IPC round-trips are the remaining per-step cost — pump multiple ticks and return a batched observation in one call rather than one call per tick.
3. **Parallel contexts (4).** Only if 1+2 aren't enough. Headless, obviously.
4. ~~Offline numpy clone~~ — **moot.** The game *is* local now; a reimplementation buys nothing and adds sim-to-real gap.
5. **Behavior cloning warmstart.** Still valid — record 30 min of your own play, pretrain on `(grid, action)` pairs, RL on top. Skips the random-flailing phase.

---

## Revised scoping

The original doc said "Phases 0–2 are the project, Phase 3 is boilerplate." **Recon invalidated that.** The hard part (perception) evaporated, and the throughput ceiling lifted with it.

What's left: env wrapper (tick control + reset plumbing is now the fiddliest bit), then mostly standard PPO tuning and reward shaping.

Build order: **env wrapper → verify reset reliability → agent → measure time-accel ceiling → scale only if needed.**
