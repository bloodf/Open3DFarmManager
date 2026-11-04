# Simulator readiness diagnosis

Follow-up to the [container checkpoint](CONTAINER-VALIDATION-CHECKPOINT.md), executed on 2026-11-04. The failure remains an integration blocker; no readiness criterion, deadline, workflow, image digest or security restriction was relaxed.

## Minimal reproduction

A single container used the pinned image `ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47` on native x86_64, with **only upstream default printer and Moonraker configuration**. No project configuration was mounted. It had a fresh named data volume, no external network (`--network none`), no published ports, one CPU, 1 GiB memory, 256 PIDs and the existing noexec temporary mounts.

A read-only `/server/info` query inside the container sampled readiness for 90 seconds. At 89.7 seconds, `klippy_connected` was true and `klippy_state` was `startup`. Readiness never passed. The virtual MCU identification failed; no printer command was sent.

This reproduces the failure without the project's four-tool fixture, webcam configuration, HTTP client, SSH forwarding or concurrent second printer. It does **not** distinguish an image defect from host/runtime/resource interactions. The measured CPU quota throttled 878 of 912 periods. The prior two-CPU experiment with project fixtures also failed, but that does not prove CPU performance is irrelevant.

## What the logs establish

The previous native run repeatedly logged an identification timeout and missing MCU communication. The U1 log also shows an uncaught `TypeError` when a callback uses a null `serialqueue`. That exception is a downstream failure after the timeout; it is not evidence of the original cause.

The [upstream serial implementation at the logged revision](https://github.com/Klipper3d/klipper/blob/ee2c6fb/klippy/serialhdl.py) waits for identification, disconnects on timeout and clears its serial queue. This supports investigation of the callback/disconnect lifecycle, but no upstream code was patched or copied into the MIT project.

The [Klipper simulator guidance](https://github.com/Klipper3d/klipper/blob/ee2c6fb/docs/Debugging.md#testing-with-simulavr) calls out the CPU cost of AVR emulation. The [emulator driver](https://github.com/Klipper3d/klipper/blob/ee2c6fb/scripts/avrsim.py) offers optional pacing. Neither source proves which condition caused this reproduction. Changing emulator speed, MCU timing or internal identification timeouts would require separate evidence and must not substitute for passing the original acceptance gate.

## Verification and cleanup

Six regression cases now reject shutdown, error, disconnected-but-ready, wrong-type and missing-field responses. The simulator module passed 14 tests; the complete Bun suite passed 154 tests. Lint and typecheck passed. Existing Node, browser and build checkpoints were not rerun for this test-only addition.

The diagnostic used project label `o3dfm-diag-20261104-2240`, container suffix `-stock` and volume suffix `-data`. Its container, volume and newly pulled image were removed. All pre-existing container, image, volume and network inventories were preserved, with zero additions remaining. No host files or networks were created remotely. Compact logs, sampled states, exact resource IDs and the reproduction script are retained locally for the unresolved investigation.

Next work is to isolate the upstream firmware/emulator identification behavior under measured host conditions, or evaluate a separately licensed, reproducibly pinned alternative simulator. The root cause of the initial identification timeout remains unresolved. Do not mark E0 complete or publish changes that trigger unapproved remote container execution.

The [image provenance and architecture follow-up](SIMULATOR-IMAGE-PROVENANCE.md) verifies the pinned sources, separates experimental Linux-MCU fixes from this AVR image, and records one native ARM64 stock success followed by a failed project-fixture pair. No replacement was adopted.

The [startup-order measurement](SIMULATOR-STARTUP-MEASUREMENTS.md) records successful controls before and after a failed pair, with a repeatable ordering correlation that still requires a controlled intervention before claiming causality.
