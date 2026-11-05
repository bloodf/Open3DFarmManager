# Simulator acceptance follow-up

A native ARM64 isolated control on 2026-11-04 did not reach sampled Klipper readiness within the existing 90-second window. This is a diagnostic failure, not full simulator acceptance. The earlier native amd64 full harness also failed readiness, as recorded in [its result](SIMULATOR-AMD64-HARNESS-RESULT.md). Neither architecture has a complete passing acceptance result.

## Control and result

The local Docker engine reported `aarch64`. The control used the previously reviewed ARM64 manifest `sha256:4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7`, fresh storage, the image's unmodified Supervisor and example printer configuration, one CPU, 1 GiB, 256 PIDs, noexec temporary mounts, no network or published ports. A read-only CPU capture helper ran separately in the private cgroup. There was no serial observer, PTY launcher, physical printer, or printer command. The retained sampling script queried Moonraker approximately every three seconds until 90 seconds from container start.

Every successful status sample from 13.81 through 88.21 seconds reported `startup`; earlier requests did not return a valid status. The log collected after the window contains 14 identification timeouts followed by an MCU dictionary load and a clock-estimate warning. That later log does not establish readiness within the deadline and is not counted as success. No continuous readiness observation was made between samples.

The private cgroup reported `0::/` and `cpu.max` of `100000 100000`. Across 86 samples spanning approximately 85 seconds, `nr_periods` increased by 850, `nr_throttled` by 813, `throttled_usec` by 64,179,453, and `usage_usec` by 84,752,127. These aggregate container counters demonstrate throttling during this run; they do not identify delayed processes or establish causation. This failure also differs from the earlier observed post-readiness `Timer too close` shutdown.

This control removes the serial observer used in the prior CPU-observed run, but it also uses the unmodified Supervisor configuration rather than that run's diagnostic configuration. Host scheduling was uncontrolled and the CPU capture adds load. It therefore does not isolate observer overhead or establish the cause. Together with the [evidence summary](SIMULATOR-EVIDENCE-SUMMARY.md), it supports continued investigation of emulator progress and scheduling, not a firmware timeout change or promotion of the experimental PTY launcher.

## Acceptance and cleanup

The two-printer, four-tool, camera and Spoolman acceptance was not run in this follow-up: this single-printer control failed the existing readiness window and no validated reliability change was available. No conclusion about those later assertions follows from it. Native amd64 access for a new isolated run was not established in this task's available context; the prior native amd64 failure remains the latest documented full-harness result.

The owned simulator container, fresh volume and ARM64 image reference, absent from the initial local image inventory, were removed. No network was created. Bounded logs, cgroup samples, runtime metadata and the sampling script remain in the external task evidence directory. No pre-existing resources were removed. Compose, firmware timing, resource limits and readiness criteria remain unchanged.
