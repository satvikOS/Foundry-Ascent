"""That a piece of work grows linearly with its input (packages/ai/src/testing/linear-time.ts, for the graders).

CPU time of this thread, never wall-clock time: other processes on the machine (a parallel test run, a shared CI
runner) stretch the one but not the other. Both sizes are warmed up and sampled interleaved, so a burst of load or a
garbage collection slows one sample, not one size; the least sample of each size counts. Each sample repeats the work
until the small one takes about `sample_s`, so the clock's resolution and fixed costs are small next to it: there is
no absolute allowance in the ratio, which must stay below `factor ** exponent` (22.6 for a factor of 8: well above
linear, 8, and well below quadratic, 64). A ratio at or above it is measured again, up to `attempts` times in all, as
a super-linear cost is above it every time and a sample slowed by the machine is not.
"""

from __future__ import annotations

import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class Scaling:
    small: float
    large: float
    ratio: float
    bound: float
    runs: int


def measure_scaling(
    prepare: Callable[[int], Callable[[], object]],
    size: int,
    *,
    factor: int = 8,
    exponent: float = 1.5,
    sample_s: float = 0.025,
    samples: int = 5,
) -> Scaling:
    """The CPU time of the work `prepare(size)` returns (its input built outside the timing), at `size` and at
    `factor * size`."""
    small_work = prepare(size)
    large_work = prepare(size * factor)
    for _ in range(2):
        small_work()
        large_work()
    runs = 1

    def sample(work: Callable[[], object]) -> float:
        started = time.thread_time()
        for _ in range(runs):
            work()
        return time.thread_time() - started

    # Twice the runs until a sample of the small input takes `sample_s` (one run, still warming up, can be slow).
    while runs < 65_536 and sample(small_work) < sample_s:
        runs *= 2
    small = large = float("inf")
    for _ in range(samples):
        small = min(small, sample(small_work))
        large = min(large, sample(large_work))
    return Scaling(small, large, large / max(small, 1e-6), factor**exponent, runs)


def assert_linear_time(
    prepare: Callable[[int], Callable[[], object]],
    size: int,
    *,
    factor: int = 8,
    exponent: float = 1.5,
    attempts: int = 2,
    budget_s: float | None = None,
) -> Scaling:
    """Asserts the work `prepare(size)` returns takes about `factor` times as long at `factor * size`, never
    `factor ** 2` (one round per item, or a regular expression that backtracks over what it read). `budget_s`: the
    most CPU time one run of the small input may take, as a window that bounds what is read makes both sizes cost the
    same however slow each is (a regular expression that backtracks exponentially within the window)."""
    scaling = measure_scaling(prepare, size, factor=factor, exponent=exponent)
    for _ in range(1, attempts):
        if scaling.ratio < scaling.bound:
            break
        scaling = measure_scaling(prepare, size, factor=factor, exponent=exponent)
    report = (
        f"{scaling.runs} run(s) at size {size} took {scaling.small * 1000:.1f} ms of CPU and at {size * factor} "
        f"{scaling.large * 1000:.1f} ms: {scaling.ratio:.1f} times as long (bound {scaling.bound:.1f})"
    )
    if os.environ.get("LINEAR_TIME_REPORT") == "1":
        print(f"linear-time: {report}", file=sys.stderr)
    assert scaling.ratio < scaling.bound, report
    if budget_s is not None:
        assert scaling.small / scaling.runs < budget_s, report
    return scaling
