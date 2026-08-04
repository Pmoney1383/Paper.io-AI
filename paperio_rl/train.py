"""
Fully automatic entry point: launches N parallel browser-backed envs (the
first visible, the rest headless), creates a fresh PPO model or resumes from
a saved checkpoint, trains, and checkpoints periodically. Nothing manual -
just `python -m paperio_rl.train`.

Defaults: 8 parallel envs, 2,000,000 timesteps, curriculum learning enabled
(bot count ramps 3 -> 15 over the first 40% of timesteps, measured in
lifetime steps so it survives being resumed across multiple sessions).

Usage:
    python -m paperio_rl.train                       # default settings (8 envs, 2M steps)
    python -m paperio_rl.train --timesteps 5000       # short run (smoke/testing)
    python -m paperio_rl.train --n-envs 4             # fewer parallel browsers
    python -m paperio_rl.train --headless-first       # even the first env is headless
    python -m paperio_rl.train --no-curriculum        # full bot count from the start
"""
import argparse
import os

from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback, CallbackList
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import SubprocVecEnv

from paperio_rl.env import PaperIOEnv, DEFAULT_BOTS_COUNT
from paperio_rl.status_callback import StatusCallback
from paperio_rl.curriculum_callback import CurriculumCallback

CHECKPOINT_DIR = os.path.join(os.path.dirname(__file__), "checkpoints")
MODEL_PATH = os.path.join(CHECKPOINT_DIR, "ppo_paperio.zip")
CHECKPOINT_PREFIX = "ppo_paperio"


def make_env(headless: bool):
    def _init():
        # Monitor tracks per-episode reward/length and stuffs it into
        # info["episode"] on the terminal step - that's what populates
        # model.ep_info_buffer, which StatusCallback reads for ep_rew_mean.
        # Without it, episode-level reward is invisible to any reporting.
        return Monitor(PaperIOEnv(headless=headless))
    return _init


def build_vec_env(n_envs: int, headless_first: bool):
    # Only the first env is visible by default (per request) - the rest
    # always run headless regardless, since there's no benefit to more than
    # one visible browser and it just wastes a display.
    fns = [make_env(headless=(headless_first or i > 0)) for i in range(n_envs)]
    return SubprocVecEnv(fns)


def main():
    parser = argparse.ArgumentParser(description="Train a PPO agent to play paperio.site")
    parser.add_argument("--n-envs", type=int, default=8, help="number of parallel browser envs")
    parser.add_argument("--timesteps", type=int, default=2_000_000, help="total training timesteps")
    parser.add_argument("--headless-first", action="store_true", help="run all envs headless (including the first)")
    parser.add_argument("--checkpoint-every", type=int, default=10_000, help="save a checkpoint every N steps")
    parser.add_argument("--status-every", type=int, default=2048, help="print a status line every N steps")
    parser.add_argument("--curriculum-start-bots", type=int, default=3, help="bot count at the start of training")
    parser.add_argument("--curriculum-end-bots", type=int, default=DEFAULT_BOTS_COUNT, help="bot count once the curriculum ramp finishes")
    parser.add_argument("--curriculum-fraction", type=float, default=0.4, help="fraction of --timesteps over which bot count ramps up")
    parser.add_argument("--no-curriculum", action="store_true", help="disable curriculum learning, use full bot count from the start")
    args = parser.parse_args()

    os.makedirs(CHECKPOINT_DIR, exist_ok=True)

    print(f"Launching {args.n_envs} browser env(s) ({'all headless' if args.headless_first else 'first visible, rest headless'})...")
    vec_env = build_vec_env(args.n_envs, args.headless_first)

    if os.path.exists(MODEL_PATH):
        print(f"Found existing checkpoint at {MODEL_PATH}, resuming training.")
        model = PPO.load(MODEL_PATH, env=vec_env)
    else:
        print("No existing checkpoint found, starting a fresh PPO model (MlpPolicy).")
        # net_arch: [64,64] (SB3 default) was too small for a 24-dim obs
        # with real spatial/tactical structure - bumped to 3 hidden layers.
        # ent_coef=0.0 is PPO's default, which means zero incentive to keep
        # exploring once the policy finds ANY safe repeatable behavior - that
        # is exactly how a policy collapses onto "always go straight" and
        # never discovers loop-closing. 0.01 keeps a meaningful amount of
        # exploration pressure throughout training.
        model = PPO(
            "MlpPolicy",
            vec_env,
            verbose=1,
            n_steps=512,
            batch_size=256,
            learning_rate=3e-4,
            ent_coef=0.01,
            policy_kwargs=dict(net_arch=dict(pi=[256, 256, 128], vf=[256, 256, 128])),
        )

    checkpoint_callback = CheckpointCallback(
        save_freq=max(1, args.checkpoint_every // args.n_envs),
        save_path=CHECKPOINT_DIR,
        name_prefix=CHECKPOINT_PREFIX,
    )
    status_callback = StatusCallback(total_timesteps=args.timesteps, print_every_steps=args.status_every)
    callbacks = [checkpoint_callback, status_callback]
    if not args.no_curriculum:
        callbacks.append(CurriculumCallback(
            ramp_timesteps=int(args.timesteps * args.curriculum_fraction),
            start_bots=args.curriculum_start_bots,
            end_bots=args.curriculum_end_bots,
            verbose=1,
        ))
    callback = CallbackList(callbacks)

    try:
        model.learn(total_timesteps=args.timesteps, callback=callback, reset_num_timesteps=False)
    finally:
        print(f"Saving final model to {MODEL_PATH}")
        model.save(MODEL_PATH)
        vec_env.close()


if __name__ == "__main__":
    main()
