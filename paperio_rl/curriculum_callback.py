"""Curriculum learning: start episodes with fewer bots so the agent can learn
the basic "venture out, turn back, close the loop" pattern without also
having to dodge a full bot population at the same time, then ramp bot count
up to the real difficulty over the course of training.

Verified mechanism (see hooks.SET_BOTS_COUNT_JS): window.__game.config is the
same object every resetWorld() reads botsCount from, so mutating it before a
reset changes the next episode's bot population - confirmed empirically
(set to 3, reset, world had exactly 3 units).
"""
from stable_baselines3.common.callbacks import BaseCallback


class CurriculumCallback(BaseCallback):
    """Progress is measured against model.num_timesteps directly (absolute
    lifetime steps trained), NOT steps taken within this .learn() call. With
    reset_num_timesteps=False (how train.py resumes checkpoints),
    num_timesteps already carries over across resumed sessions - so ramp
    progress does too. Getting this wrong would mean every resume of a long
    run silently resets bot count back down to start_bots, discarding
    whatever difficulty the agent had already grown into.
    """

    def __init__(self, ramp_timesteps: int, start_bots: int, end_bots: int, verbose: int = 0):
        super().__init__(verbose)
        self.ramp_timesteps = max(1, ramp_timesteps)
        self.start_bots = start_bots
        self.end_bots = end_bots
        self._last_applied = None

    def _on_training_start(self):
        self._apply_for_progress()

    def _on_step(self) -> bool:
        self._apply_for_progress()
        return True

    def _apply_for_progress(self):
        progress = min(1.0, self.num_timesteps / self.ramp_timesteps)
        target = round(self.start_bots + progress * (self.end_bots - self.start_bots))
        if target != self._last_applied:
            self._apply(target)

    def _apply(self, n: int):
        self._last_applied = n
        self.training_env.env_method("set_bots_count", n)
        if self.verbose:
            print(f"[curriculum] botsCount -> {n} (at {self.num_timesteps} lifetime timesteps)")
