# Simulator evidence summary

This note summarizes the bounded serial, Moonraker state, Klippy, and cgroup
CPU captures retained for the simulator diagnosis. The experiment procedures
and their safety limits are documented in
[`infra/sim/experiments/README.md`](../infra/sim/experiments/README.md) and
[`SIMULATOR-SERIAL-DIAGNOSTIC.md`](SIMULATOR-SERIAL-DIAGNOSTIC.md). No result
here changes the default simulator harness or establishes full acceptance.

## Observations

| Run                     | MCU identification                                                                                                        | Moonraker state                                                                          | CPU counters                                                                                                                       | Result                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| amd64 emulated on ARM64 | 17 matching 40-byte dictionary responses (680 contiguous bytes); no terminal response or session result before collection | Connected, `startup` at the last sample near the 90-second deadline                      | Not captured                                                                                                                       | Valid identification traffic occurred, but the capture is incomplete. It does not establish why the earlier amd64 harness failed.                              |
| ARM64, shutdown run     | 3,672 contiguous dictionary bytes and terminal response; identification succeeded                                         | First sampled `ready` at 20.53 s, then `shutdown` by 39.68 s and through the last sample | Not captured                                                                                                                       | Transient readiness followed by `MCU shutdown: Timer too close`. This run cannot attribute the shutdown to CPU throttling.                                     |
| ARM64, CPU-observed run | 3,672 contiguous bytes, terminal response, success about 3.96 s after session start                                       | First sampled `ready` at 23.62 s; last sample remained `ready` at 89.83 s                | 77 samples over about 76 s; deltas: `nr_periods` +760, `nr_throttled` +553, `throttled_usec` +34,046,653, `usage_usec` +75,765,669 | Quota throttling was measured in this run, which had no observed Timer-too-close shutdown. The capture started after container startup and adds observer load. |

## What the evidence supports

- MCU identification is not uniformly absent: both ARM64 captures completed it,
  and the incomplete amd64 capture contains valid matching response progress.
- The shutdown run contains a timer failure after identification and transient
  readiness. Its Klippy clock estimates changed substantially and it logged a
  clock prediction variance reset. Those are relevant timing observations, not
  measurements of host scheduling delay.
- The CPU-observed run proves that cgroup quota throttling occurred during
  that run. Its aggregate counters cover all processes in the container and
  provide no per-process delay or event-level alignment with Klippy timers.
- Throttling is therefore correlated with the general experimental conditions,
  but these captures do not show whether it coincided with or caused the
  shutdown. In particular, the failing run has no CPU counters and the run
  with CPU counters did not have the observed shutdown.
- The captures do not measure emulator CPU time, host or VM scheduler latency,
  nor all serial read/frame-validation boundaries. They cannot isolate
  architecture, emulation, observer overhead, or a firmware defect as cause.

## Limits and next useful evidence

The amd64 and ARM64 experiments are not a controlled architecture comparison:
the amd64 capture is incomplete, architecture-specific runtime artifacts may
differ, the reconstructed ARM64 observer configuration did not have established
identity with the earlier temporary config, and host scheduling varied. A
single passing or failing execution is not enough to rule out intermittent
behavior. The sampled Moonraker state is bounded in time and is not full
simulator acceptance.

To test the scheduling hypothesis, repeated failing and non-failing runs need
the same bounded cgroup CPU capture, with monotonic timestamps aligned to the
Klippy logs, while preserving the existing security and readiness limits.
Include uninstrumented controls because the observer adds load. This would
improve temporal correlation; counters alone would still not prove which
process was delayed or establish causation.

The current evidence does not justify relaxing readiness, changing firmware
timeouts, or promoting an experimental launcher to the default harness.
