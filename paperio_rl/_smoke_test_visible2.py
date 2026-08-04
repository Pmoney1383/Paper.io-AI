"""Retake the visible-env screenshot, cropped to the center where the camera
follows the player, to confirm rendering visually (not just via pixel probe)."""
import numpy as np
from paperio_rl.env import PaperIOEnv


def main():
    env = PaperIOEnv(headless=False)
    rng = np.random.default_rng(0)
    for i in range(60):
        action = int(rng.integers(0, 4))
        obs, reward, terminated, truncated, info = env.step(action)
        if terminated or truncated:
            env.reset()

    env._page.screenshot(path="paperio_rl/_visible_full.png")
    env._page.screenshot(path="paperio_rl/_visible_center_crop.png", clip={"x": 440, "y": 200, "width": 400, "height": 400})
    print("saved. info:", info)
    env.close()


if __name__ == "__main__":
    main()
