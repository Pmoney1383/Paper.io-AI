"""Tests for paperio_rl.env.PaperIOEnv. Hits the live paperio.site - slow,
network-dependent, same tradeoff as tests/hooks.test.js's live suite. Run
with: .venv/Scripts/python.exe -m unittest tests.test_paperio_env -v
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from paperio_rl.env import (
    PaperIOEnv,
    MAX_EPISODE_TICKS,
    TICKS_PER_STEP,
    OBS_DIM,
    ALIVE_BONUS,
    DEATH_PENALTY_BASE,
    DEATH_PENALTY_TERRITORY_SCALE,
    TRAIL_PENALTY_SCALE,
    TRAIL_FREE_POINTS,
)


class TestPaperIOEnv(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = PaperIOEnv(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.env.close()

    def test_spaces(self):
        self.assertEqual(self.env.action_space.n, 4)
        self.assertEqual(self.env.observation_space.shape, (OBS_DIM,))

    def test_reset_returns_valid_observation(self):
        obs, info = self.env.reset()
        self.assertEqual(obs.shape, self.env.observation_space.shape)
        self.assertTrue(self.env.observation_space.contains(obs), f"obs out of bounds: {obs}")
        self.assertTrue(info["alive"])

    def test_step_returns_valid_transition(self):
        self.env.reset()
        obs, reward, terminated, truncated, info = self.env.step(0)
        self.assertEqual(obs.shape, self.env.observation_space.shape)
        self.assertTrue(self.env.observation_space.contains(obs))
        self.assertTrue(np.isfinite(reward))
        self.assertIsInstance(terminated, bool)
        self.assertIsInstance(truncated, bool)
        self.assertIn("percent", info)
        self.assertIn("cycle", info)

    def test_alive_bonus_present_each_step_while_alive(self):
        self.env.reset()
        _, reward, terminated, _, _ = self.env.step(1)
        if not terminated:
            # reward = alive bonus + territory delta (usually ~0 for one step
            # without a closed loop) - trail is still short at this point
            # (well under TRAIL_FREE_POINTS), so the trail penalty shouldn't
            # have kicked in yet.
            self.assertGreaterEqual(reward, -0.001)

    def test_death_applies_penalty_scaled_by_territory(self):
        # Run an episode to natural termination (bounded by MAX_EPISODE_TICKS)
        # and confirm that IF it terminates via death, the final reward
        # reflects the death penalty formula (plus that step's trail
        # penalty), not just the alive bonus.
        self.env.reset()
        terminated = truncated = False
        rng = np.random.default_rng(1)
        last_reward = None
        last_percent = 0.0
        last_trail_len = 0
        steps = 0
        max_steps = MAX_EPISODE_TICKS // TICKS_PER_STEP + 1
        while not (terminated or truncated) and steps < max_steps:
            action = int(rng.integers(0, 4))
            _, last_reward, terminated, truncated, info = self.env.step(action)
            last_percent = info["percent"]
            last_trail_len = info["trailLen"] or 0
            steps += 1
        if terminated:
            expected = (
                ALIVE_BONUS
                - TRAIL_PENALTY_SCALE * max(0, last_trail_len - TRAIL_FREE_POINTS)
                + DEATH_PENALTY_BASE
                - DEATH_PENALTY_TERRITORY_SCALE * last_percent
            )
            self.assertAlmostEqual(last_reward, expected, places=4)

    def test_reset_after_episode_gives_fresh_world(self):
        # Two resets in a row should both succeed and both report alive:True
        # with near-zero starting percent (a fresh spawn, not leftover state).
        _, info1 = self.env.reset()
        _, info2 = self.env.reset()
        self.assertTrue(info1["alive"])
        self.assertTrue(info2["alive"])
        self.assertLess(info1["percent"], 0.01)
        self.assertLess(info2["percent"], 0.01)


if __name__ == "__main__":
    unittest.main()
