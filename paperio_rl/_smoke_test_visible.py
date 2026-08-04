"""Verify the visible-env rendering fix: overlay/ads hidden, canvas actually
draws real gameplay. Screenshots before and after some steps."""
import numpy as np
from paperio_rl.env import PaperIOEnv


def main():
    env = PaperIOEnv(headless=False)
    env._page.screenshot(path="paperio_rl/_visible_after_reset.png")
    print("Screenshot 1 saved (right after reset)")

    rng = np.random.default_rng(0)
    for i in range(60):
        action = int(rng.integers(0, 4))
        obs, reward, terminated, truncated, info = env.step(action)
        if terminated or truncated:
            env.reset()

    env._page.screenshot(path="paperio_rl/_visible_after_steps.png")
    print("Screenshot 2 saved (after 60 random steps)")
    print("info:", info)

    env.close()


if __name__ == "__main__":
    main()
