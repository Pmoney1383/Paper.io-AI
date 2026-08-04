# paper.io RL Agent — Project Plan

Train a neural network via reinforcement learning to play the **live** paper.io browser game, using computer vision for state extraction.

---

## Stack

| Component | Choice | Why |
|---|---|---|
| Browser control | Playwright (Chromium, headless) | Scriptable, CDP access, multi-context |
| Frame capture | **CDP `Page.startScreencast`** @ ~30fps | Push-based stream, not request/response |
| CV | OpenCV + numpy | Color masking, contours, downsampling |
| RL | `stable-baselines3` PPO | Discrete action space, batteries included |
| Compute | RTX 5080 | Mostly idle — bottleneck is the game, not the GPU |
| Parallelism | **4 headless browser contexts** | ~130k steps/hr without pegging CPU |

---

## Key design decisions (settled)

### Capture vs. decision rate
- **Capture at ~30fps** via CDP screencast — smooth, push-based, no repaint stalls.
- **Act at ~10Hz** (every 3rd frame), holding the action in between.
- Do NOT use `page.screenshot()` for the loop — it's request/response over CDP, forces a repaint, PNG-encodes, and realistically yields 5–15fps with 300ms stalls. Debug/one-off frames only.
- Fallback if screencast misbehaves: `mss` (native OS grab, 60fps+, but window position/scaling becomes your problem).
- **Why not act at 30Hz:** at 30fps a single action barely changes the world, so credit assignment gets brutal and the agent learns *worse and slower*. Frame-skip is standard RL practice.

### Why a CNN, and how it emits an action
The CNN is a **feature extractor**, not an action predictor. Full path:

```
40x40x5 grid → [3 conv layers] → flatten → [FC layers] → 4 logits (U/D/L/R) → softmax → sample
```

- Conv stack compresses the spatial grid into features ("enemy trail close on the right, open territory ahead").
- A small fully-connected **policy head** maps those features to 4 scores, one per direction.
- Training: sample from softmax (exploration). Eval: argmax.

**Why not a plain MLP?** At 40×40 an MLP would technically work, but the CNN buys two things:
- *Translation invariance* — an enemy trail 5px to your left looks the same anywhere on the grid, so one learned filter is reused everywhere instead of a separate weight per cell.
- *Spatial locality* — conv kernels bake in "nearby pixels are related"; an MLP has to brute-force learn that.

Result: far fewer parameters, faster convergence, better generalization to unseen territory shapes. This is the canonical Atari-style CNN-PPO setup — nothing exotic.

### Why the occupancy grid instead of raw pixels
Going full CNN-on-raw-pixels turns this into a semantic segmentation project and drags in enemy-identity tracking across frames. Color-mask → downsampled grid gets a working prototype in a week instead of a month.

---

## Phase 0 — Recon (~1 hr)

**Do this before writing a single line of CV code.**

- [ ] Open paper.io, pop the browser console, dig through `window` globals for exposed game state (player coords, territory, enemy positions).
- [ ] **If state is exposed:** `page.evaluate()` it out and the entire CV pipeline evaporates — clean numeric state at 60fps, zero segmentation work. 30 minutes of digging that could save two days.
- [ ] If fully bundled/minified with nothing exposed → proceed with pixels.
- [ ] Identify the canvas element, its resolution, and whether it's 2D canvas or WebGL.
- [ ] Record ~60s of raw frames to disk. **Reuse this footage constantly** for offline CV tuning without needing a live browser.

---

## Phase 1 — Perception (~1 day, the real work)

Build `extract_state(frame) -> dict`, developed against **recorded footage**, not live.

- [ ] Sample actual hex values from your recordings — do not guess colors.
- [ ] Color-mask each entity class:
  - your territory
  - your trail
  - enemy territory
  - enemy trails
  - background / open space
- [ ] Locate your head position + trail via contour detection.
- [ ] Enemies: use a lightweight **per-frame color-clustering pass**. Do NOT try to track enemy identities across frames — for v1 you only need "enemy trail pixels near me" as a collision-risk feature.
- [ ] Territory measurement: color-mask + `cv2.countNonZero`. This is the easy part.
- [ ] Output: **40×40×5 occupancy grid centered on the player**, plus scalars (territory %, alive/dead flag).

**Gate:** overlay the extracted grid back onto the source frame as a debug visualization and eyeball 200 frames. If perception is wrong here, everything downstream is garbage and you won't be able to tell why.

> Known failure mode: color masks breaking when an enemy's territory color sits too close to yours. Budget time for it.

---

## Phase 2 — Environment wrapper (~half day)

Gym-style `PaperIOEnv` with `reset()` / `step(action)`.

- [ ] `reset()`: template-match the death screen → click "play again" → wait for spawn.
- [ ] `step(action)`: send arrow key via Playwright → wait one frame-skip interval → grab latest screencast frame → extract state → compute reward.
- [ ] Action space: **discrete(4)** — matches paper.io's native controls, no continuous control needed.
- [ ] Reward shaping (raw territory alone is far too sparse — you'll die 100× before capturing anything):

| Event | Reward |
|---|---|
| Per step alive | `+0.01` |
| Distance traveled outside own territory | small positive (encourages expansion attempts) |
| New territory claimed (loop closure) | `+0.1 × new_territory_pixels` |
| Death | `-1 - 0.5 × territory_held` |

Scaling the death penalty by territory held makes dying with a big base hurt more than dying instantly.

**Gate:** run a random-action agent for 50 episodes. If `reset()` doesn't succeed 50/50 times, fix that before training anything.

---

## Phase 3 — Agent (~half day to write)

- [ ] PPO from `stable-baselines3`.
- [ ] Small CNN over the 40×40×5 grid — 3 conv layers is plenty, this isn't ImageNet.
- [ ] **Frame-stack 4 observations** so the policy can infer motion/direction.
- [ ] ~150 lines of boilerplate. This is the easy phase.

**Wall-clock reality check:**
- 1 instance @ 10Hz ≈ **36k steps/hour**
- PPO typically wants **1M+ steps** → ~30 hours single-instance
- 4 instances @ ~90% uptime ≈ **130k steps/hour** → **~8 hours**, a workable weekend

---

## Phase 4 — Throughput (pick one, in order of cheapness)

1. **Parallel envs — 4 headless contexts.** Cheapest win, do this first. Bottleneck is CPU (Chrome rendering + per-frame CV), not GPU; the 5080 stays mostly idle during rollout collection. Run headless — no reason to render 4 visible windows.
   - **Start with 1 instance** until Phases 1–2 are solid. Debugging a flaky color mask across 4 parallel streams is miserable.
2. **Offline clone.** Reimplement paper.io mechanics in numpy, train at 10k+ steps/sec, transfer to the live site using the same observation format. Fastest path to a genuinely *good* agent; cost is the sim-to-real gap.
3. **Behavior cloning warmstart.** Record 30 min of your own play, pretrain the policy on `(grid, action)` pairs, then RL on top. Eliminates the random-flailing phase entirely.

---

## Honest scoping

**Phases 0–2 are the project.** Phase 3 is stable-baselines3 boilerplate. The common failure mode is getting excited about the RL and then losing four days to color-mask debugging you didn't plan for.

Build order: **recon → perception → env → agent → scale.** Don't skip the gates.
