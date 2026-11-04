# Bounded PTY prerequisite validation

The original MIT [experimental launcher](../infra/sim/experiments/README.md) is available for opt-in simulator tests. It has a 30-second monotonic admission deadline, verifies a TTY without consuming data, and replaces itself with the original command without a shell. Failure is nonzero; it emits no readiness result. It is not wired into Compose, CI, production or a Connector.

The pinned ARM64 simulator already provides Python. Its GPL image, Supervisor configuration and Klipper executable remain external; only our original helper and tests are committed. The temporary upstream-derived configuration was extracted from the reviewed image, mounted read-only and removed after testing. No image digest, architecture default, firmware timing or privileges changed in the repository. Native amd64 validation remains pending.

## Repeated controls and faults

Six isolated SV06 cases used fresh storage, one CPU, 1 GiB, 256 PIDs, noexec temporary mounts, no external networking and no published ports. Both controls and interventions disabled Klippy automatic restart and startup retries in the temporary configuration, so failure could not be hidden by relaunching. All cases retained the connected/ready criterion and 90-second budget. No printer command was sent.

| Case                         | First readiness | Identification timeouts | Result                         |
| ---------------------------- | --------------- | ----------------------- | ------------------------------ |
| Control 1                    | 49.5 s          | 6                       | Passed                         |
| Bounded guard 1              | 32.0 s          | 0                       | Passed                         |
| Missing PTY/emulator         | Never           | No Klippy launch        | Failed closed                  |
| Control 2                    | 19.4 s          | 0                       | Passed                         |
| Bounded guard 2              | 27.2 s          | 0                       | Passed                         |
| Silent synthetic PTY, no MCU | Never           | 16                      | Failed original readiness gate |

The missing-PTY case emitted exactly one `SIM_PTY_WAIT_FAILED: timeout`, left Supervisor's program in `EXITED`, produced no Klippy log and never became ready. The silent-PTY case admitted the launcher and started Klippy, but remained in startup with no MCU identification. This demonstrates why PTY availability must not replace firmware readiness. Fault-result assertions checked every sampled state for false readiness.

Both unguarded controls passed in this round, so these results do not establish that the guard is necessary or universally faster. Together with prior mixed controls, they support an opt-in candidate and its failure behavior, not a complete causal explanation or production fix. Sampling latency, host scheduling and small sample size remain limitations. Full two-printer, four-tool, camera and Spoolman acceptance has not been run with this bounded launcher.

## Verification and cleanup

Ten Python standard-library tests passed, covering missing devices, invalid timeouts, non-TTY files, permission errors, deadline rechecks, descriptor cleanup, literal argument forwarding, launch errors and propagation of a real child exit status. A synthetic PTY test explicitly demonstrates availability without firmware. Python tests are separate from the unchanged CI suite. Existing application checks were not rerun because no application code changed.

Project label: `o3dfm-pty-bounded-20261104`. Six simulator containers and volumes, one temporary configuration-inspection container and the pulled image were removed. No dedicated networks were created. Temporary configuration, dummy-PTY fixture and execution script were removed after preserving evidence. Final inventories matched their baselines in all four Docker resource categories; label queries found no owned resources remaining. No broad prune or deletion of pre-existing data occurred.
