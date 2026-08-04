"""A terminal status reporter for training runs: prints step count, steps/sec,
ETA, recent episode reward, and the latest PPO loss values at a regular
cadence - separate from SB3's own verbose=1 per-update dump, which only fires
every n_steps*n_envs samples and doesn't show ETA or episode reward.
"""
import time
import numpy as np
from stable_baselines3.common.callbacks import BaseCallback


def _format_duration(seconds):
    if not np.isfinite(seconds):
        return "?"
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


class StatusCallback(BaseCallback):
    def __init__(self, total_timesteps: int, print_every_steps: int = 2048, verbose: int = 0):
        super().__init__(verbose)
        self.total_timesteps = total_timesteps
        self.print_every_steps = print_every_steps
        self._start_time = None
        self._start_step = 0
        self._last_print_step = 0

    def _on_training_start(self):
        self._start_time = time.time()
        self._start_step = self.num_timesteps
        self._last_print_step = self.num_timesteps
        print(f"\nStarting from step {self._start_step}, target {self.total_timesteps} additional timesteps.\n")

    def _on_step(self) -> bool:
        if self.num_timesteps - self._last_print_step >= self.print_every_steps:
            self._print_status()
            self._last_print_step = self.num_timesteps
        return True

    def _on_training_end(self):
        self._print_status(final=True)

    def _print_status(self, final: bool = False):
        elapsed = time.time() - self._start_time
        done_this_run = self.num_timesteps - self._start_step
        target_this_run = self.total_timesteps
        fps = done_this_run / elapsed if elapsed > 0 else 0.0
        remaining = max(0, target_this_run - done_this_run)
        eta = remaining / fps if fps > 0 else float("inf")
        pct = 100.0 * done_this_run / target_this_run if target_this_run else 100.0

        ep_rew_mean = None
        ep_len_mean = None
        if len(self.model.ep_info_buffer) > 0:
            ep_rew_mean = np.mean([ep["r"] for ep in self.model.ep_info_buffer])
            ep_len_mean = np.mean([ep["l"] for ep in self.model.ep_info_buffer])

        nv = self.model.logger.name_to_value
        loss = nv.get("train/loss")
        value_loss = nv.get("train/value_loss")
        entropy_loss = nv.get("train/entropy_loss")

        tag = "FINAL" if final else "status"
        parts = [
            f"[{tag}] step {self.num_timesteps}/{self._start_step + target_this_run} ({pct:5.1f}%)",
            f"{fps:6.1f} steps/s",
            f"elapsed {_format_duration(elapsed)}",
            f"ETA {_format_duration(eta)}",
        ]
        if ep_rew_mean is not None:
            parts.append(f"ep_rew_mean {ep_rew_mean:+.3f}")
        if ep_len_mean is not None:
            parts.append(f"ep_len_mean {ep_len_mean:.0f}")
        if loss is not None:
            parts.append(f"loss {loss:.4f}")
        if value_loss is not None:
            parts.append(f"value_loss {value_loss:.4f}")
        if entropy_loss is not None:
            parts.append(f"entropy_loss {entropy_loss:.3f}")

        print(" | ".join(parts))
