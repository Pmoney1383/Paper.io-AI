"""Throwaway smoke test for PaperIOEnv - random-action rollout, sanity-checks
obs/reward/done shapes and values before wiring into stable-baselines3."""
import numpy as np
from paperio_rl.env import PaperIOEnv


def main():
    env = PaperIOEnv(headless=True)
    print("action_space:", env.action_space)
    print("observation_space:", env.observation_space)

    obs, info = env.reset()
    print("reset obs shape:", obs.shape, "dtype:", obs.dtype, "info:", info)
    assert obs.shape == env.observation_space.shape
    assert env.observation_space.contains(obs), f"obs out of bounds: {obs}"

    total_reward = 0.0
    steps = 0
    terminated = truncated = False
    rng = np.random.default_rng(0)
    while not (terminated or truncated) and steps < 500:
        action = int(rng.integers(0, env.action_space.n))
        obs, reward, terminated, truncated, info = env.step(action)
        assert obs.shape == env.observation_space.shape
        assert env.observation_space.contains(obs), f"obs out of bounds at step {steps}: {obs}"
        assert np.isfinite(reward)
        total_reward += reward
        steps += 1
        if steps % 50 == 0:
            print(f"step {steps}: reward={reward:.4f} percent={info['percent']:.5f} alive={info['alive']} cycle={info['cycle']}")

    print(f"\nEpisode ended after {steps} steps (terminated={terminated}, truncated={truncated})")
    print(f"Total reward: {total_reward:.4f}, final percent: {info['percent']:.5f}")

    # A second reset should work cleanly (this is the part that matters most
    # for training - env.reset() gets called every episode).
    obs2, info2 = env.reset()
    assert env.observation_space.contains(obs2)
    print("\nSecond reset OK:", info2)

    env.close()
    print("\nENV SMOKE TEST PASSED")


if __name__ == "__main__":
    main()
