# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This repository currently contains only a project plan (`doc/paperio-rl-plan.md`) — no code has been written yet. There is no build system, package manifest, lint config, or test suite to reference. When implementation begins, this file should be updated with actual commands (install, run, test) and the real module layout.

## What this project is

Train a reinforcement learning agent (PPO via `stable-baselines3`) to play the **live** paper.io browser game, using computer vision to extract game state from screen captures rather than relying on exposed game internals (unless Phase 0 recon finds otherwise).

Full plan and rationale: `doc/paperio-rl-plan.md`. Read it before starting any implementation work — it contains the settled design decisions and reasoning, not just a task list.

## Planned architecture (from the plan doc)

The pipeline has four stages, meant to be built and validated **in order** — each phase gates the next:

1. **Recon** — check whether paper.io exposes game state via `window` globals before committing to a CV pipeline. This can eliminate the entire perception stage if state is exposed.
2. **Perception** (`extract_state(frame) -> dict`) — color-mask the canvas into entity classes (own territory/trail, enemy territory/trails, background), locate the player head via contour detection, and output a 40×40×5 occupancy grid centered on the player plus scalars (territory %, alive/dead). Developed and validated against **recorded footage**, not a live browser.
3. **Environment wrapper** — a Gym-style `PaperIOEnv` (`reset()` / `step(action)`) driving the game via Playwright: discrete(4) action space (arrow keys), frame-skip so actions are taken at ~10Hz against ~30fps capture, and shaped rewards (small per-step-alive bonus, reward for claiming new territory, death penalty scaled by territory held).
4. **Agent** — PPO with a small 3-conv-layer CNN feature extractor over the occupancy grid feeding a policy head (4 logits → softmax), with 4-frame stacking for motion cues.

Key constraints baked into the design (see plan doc for full reasoning):
- Frame capture must use CDP `Page.startScreencast`, **not** `page.screenshot()` — the latter is request/response, stalls the loop, and caps throughput far below what's needed.
- Enemy tracking is per-frame only ("enemy trail pixels near me") — do not implement cross-frame enemy identity tracking for v1.
- Throughput scaling order (cheapest first): parallel headless browser contexts → offline numpy reimplementation of game mechanics → behavior-cloning warmstart from recorded human play.

## Working in this repo right now

Since there's no code yet, most tasks will be scaffolding a new phase from the plan. Follow the build order in the plan doc (recon → perception → env → agent → scale) and don't skip the validation gates it defines (e.g., eyeballing 200 frames of overlaid perception output before moving to the env wrapper; 50/50 successful `reset()` calls before training).
