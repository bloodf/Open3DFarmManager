# Experimental identification observer

`infra/sim/experiments/serial_diagnostic.py` is original MIT diagnostic code. It
observes the pinned simulator's host-side identification responses and captures
serial queue counters before disconnect clears them. It does not open a serial
device, consume PTY bytes, alter firmware, change timeouts or claim readiness.
It is not enabled in Compose or CI. Use it only inside an isolated synthetic
simulator, never against a physical printer or a production Connector.

The failed amd64 acceptance remains unresolved. Existing counters can establish
accepted messages and rejected bytes, but cannot distinguish physical silence,
buffered incomplete frames, malformed frames and sequence rejection completely.
This observer deliberately returns inconclusive classifications where the
available evidence cannot answer that question.

## Exact source gate

Before importing Klipper, the launcher checks both files against SHA-256 hashes
retrieved from upstream revision
`ee2c6fb6b00b2b5d097ef70d0868df7d74943b51`:

| File                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `klippy/serialhdl.py`          | `72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad` |
| `klippy/chelper/serialqueue.c` | `d519a5554233070f2560aff550899fa2402d69de08569df68b1306914823869d` |

A missing or changed file prevents launch and exits with code 78. This checks
the observed source interfaces; it does not attest the image, compiled native
library, complete checkout or firmware. Independently retain the reviewed image
digest, architecture and runtime metadata for each experiment.

The launcher wraps three Python methods in memory and executes the existing
Klippy entrypoint with its original arguments. No upstream implementation is
copied into this repository, and no upstream source file is modified. The
external simulator and its Klipper implementation retain their GPL licensing.

## Isolated invocation

The coordinator must first record disk space, existing resources and task-owned
resource names in an external task ledger. Reuse the existing pinned simulator
experiment procedure and its security restrictions. Mount this helper read-only.
In a disposable external copy of the simulator's Supervisor configuration,
replace only the Klippy executable portion with:

```text
python3 /opt/o3dfm/serial_diagnostic.py observe /path/to/verified/klipper -- ORIGINAL_KLIPPY_ARGUMENTS
```

Resolve the actual Klipper checkout and preserve the original interpreter and
arguments from the pinned configuration. The example path is intentionally not
a repository or host mount. Keep the previous control's launch ordering,
Supervisor restart policy, resources, firmware and readiness deadlines. The
existing optional PTY launcher is a separate intervention and must not be added
or removed silently during comparison.

Capture the child's stderr along with the usual Klippy logs. Observer records
start with `O3DFM_SERIAL_DIAGNOSTIC `. Analyze the captured stream without
starting Klipper:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 infra/sim/experiments/serial_diagnostic.py analyze < /path/to/captured-stderr.log
```

The helper emits at most 4,096 events plus a truncation record. The analyzer
rejects more than 4,097 events, lines over 65,536 characters, or input over
16 Mi characters. Unrelated log lines count toward these input bounds. Keep
the overall experiment log bounded separately. A truncated capture or a session
without both start and result is inconclusive. Observer output failures stop
further writes; preserve stderr independently to detect missing output. An empty
capture contains no classified sessions and is not evidence of silence.

Logging adds runtime overhead and is not a timing-neutral observation. No result
from this wrapper alone establishes the cause of a timing failure. Synthetic
tests exercise wrappers and classification; the bounded container observation
below records the limited runtime evidence.

## Local amd64 observation

The coordinator ran one fresh stock simulator using the pinned amd64 image on
the ARM64 development host under emulation, one CPU, 1 GiB memory, 256 PIDs,
no external network, no published ports and the existing noexec mounts. The
observer and temporary Supervisor configuration were mounted read-only. Klippy
restart/retry was disabled, matching the previous diagnostic controls; the
emulator command, firmware and 90-second readiness budget were unchanged.

The last read-only Moonraker sample at 89.35 seconds reported connected with
state `startup`, not `ready`. The observer recorded seventeen matching 40-byte
dictionary responses, 680 contiguous bytes, with no unmatched responses. The
last observed response was 3.33 seconds after that identification session began.
No terminal dictionary response or session result was captured before collection.
The analyzer correctly reported `inconclusive-incomplete-capture`.

This establishes valid identification traffic during this execution, ruling out
total absence of responses for that observed interval. It does not establish a
timeout, complete dictionary transfer, the cause of the prior native amd64
failure, or simulator acceptance. Host contention and emulation remain relevant
limits; the observation is not a controlled architecture benchmark.

The owned simulator container, fresh volume and newly pulled image were removed.
Temporary upstream/configuration copies were removed after retaining their
hashes. Bounded samples, logs and runtime metadata remain outside the repository.
No other emulator, container, worktree or user data was removed.

## Local ARM64 comparison

A fresh native ARM64 instance used the reviewed same-version manifest
`sha256:4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7`.
The original Supervisor configuration matched the amd64 experiment's recorded
SHA-256. The observer configuration was reconstructed with the same documented
Klippy wrapper, disabled restart/retry and bounded output, but its hash differed
from the prior temporary file. The exact earlier contents no longer exist, so
configuration identity cannot be established. CPU, memory, PID, network, mount
and 90-second controls remained the same. The exact reconstructed config and its
transformation are retained with the local evidence for future comparison.

The observer recorded 3,672 contiguous dictionary bytes and a terminal response;
the session reported success 3.96 seconds after it began. Moonraker samples first
reported ready at 20.53 seconds, then shutdown at 39.68 seconds and through the
last sample at 87.63 seconds. Klippy logged `MCU shutdown: Timer too close`.
This establishes identification and transient readiness in this run, followed by
an observed shutdown; it does not pass stable readiness or prove a cause. The
amd64 capture was incomplete, the images contain architecture-specific artifacts,
configuration identity was not established and host scheduling varied. These
observations cannot isolate architecture, emulation or observer overhead as the
cause of either outcome. Full simulator acceptance remains pending.

The owned simulator container, fresh volume and newly pulled image reference were
removed. Bounded logs, samples, runtime metadata and the exact synthetic config
remain outside the repository for diagnosis. No physical printer was used.

## Reading the result

| Classification                                      | What it establishes                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `valid-incomplete-identification`                   | Matching contiguous dictionary responses advanced, but no terminal empty response arrived before the session ended unsuccessfully.  |
| `identification-complete-not-readiness`             | The observed session completed identification. Full unchanged simulator acceptance is still required.                               |
| `inconclusive-unmatched-responses`                  | Returned offsets did not match the requested contiguous progress.                                                                   |
| `inconclusive-invalid-or-sequence-rejected-traffic` | The existing invalid-byte counter increased. It combines malformed traffic and sequence rejection.                                  |
| `inconclusive-no-identification-progress`           | No accepted dictionary progress was observed. Zero accepted bytes do not prove zero raw RX bytes; ACK-only traffic also lands here. |
| `inconclusive-dictionary-not-loaded`                | A terminal response was observed, but session success was not established.                                                          |
| `inconclusive-incomplete-capture`                   | Capture ended early, was truncated or encountered an observer error.                                                                |

The analyzer reports the last identification response time relative to its session start when that timestamp is available. It does not establish when the observer stopped collecting. Counters are retained alongside classification. Partial dictionary progress may
coexist with invalid traffic; do not interpret the primary classification as
proof that other faults were absent. The pinned
[Python serial reader](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/serialhdl.py)
defines accepted identification offsets. The pinned
[native queue](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/chelper/serialqueue.c)
counts accepted frames separately from invalid bytes. A conclusive raw-traffic
diagnostic would additionally need observation at the native read and frame
validation boundaries; this helper does not invent those measurements.

## Verification and cleanup

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -p 'test_serial_diagnostic.py' -v
```

Tests use in-memory readers, streams and mocked file reads. They do not start
Klipper, Docker, real serial devices or printers and create no temporary files.
These Python checks remain separate from `check:all` and CI. No integration
success is claimed by adding the diagnostic.

After an actual experiment, preserve bounded logs and resource identifiers in
the coordinator's external evidence directory, remove only disposable resources
created for that experiment, and compare the final inventory with its baseline.
Never delete a shared simulator, pre-existing image, worktree or another task's
output. Report retained evidence and remaining resources explicitly.

## Clock and scheduling evidence from the ARM64 shutdown

The retained Klippy log reports identification before the first sampled ready
state. At Klippy monotonic time 12501.6, it warned that the MCU was configured
for 20 MHz but estimated at about 0.97 MHz. The estimate remained near that
value until a clock prediction variance reset at 12512.1; it then moved to
about 1.69 MHz. A filament sensor insertion event was logged at 12518.85,
followed by the shutdown message and an MCU `Timer too close` report. This
sequence does not establish that the insertion event caused shutdown.

The last pre-shutdown statistics reported `print_stall=0`, 242 retransmitted
bytes and zero invalid bytes. The shutdown dump reported a clock estimate of
1,692,104.530 against a configured 20,000,000, with 242 retransmitted bytes
and zero invalid bytes. These are Klippy's measurements and counters, not
measurements of host CPU throttling. `print_stall` does not measure scheduler
stalls. The run did not capture per-period cgroup throttling, emulator CPU time
or host scheduling delays. The clock estimate and reset support investigating
clock/scheduling behavior, but neither a CPU quota cause nor a firmware defect
is established. The intermittent prior results also make a single repeated
run insufficient to discriminate a cause.

## Capture missing CPU quota evidence

For a future isolated synthetic run, mount `cpu_throttle_capture.py` read-only
and start it as a separate process in the simulator's private cgroup namespace
without changing the pinned Supervisor configuration or limits. Verify that
`/proc/self/cgroup` identifies the intended cgroup v2 root before interpreting
`/sys/fs/cgroup/cpu.stat`. Capture stdout and stderr separately in the external
ledger directory. For example, after the container starts:

```sh
docker exec SIMULATOR_CONTAINER python3 /opt/o3dfm/cpu_throttle_capture.py > cpu.jsonl 2> cpu-errors.log
```

The helper emits at most 90 cumulative counter samples, one per second, and
starts no read at or after the end of its own 90-second sampling window. Stop
the capture at the original container readiness deadline if it started later.
Each record brackets the read with
monotonic timestamps, which can be compared with Klippy's monotonic timestamps
in the same container. Calculate deltas between successive samples; counters
alone do not identify which process was delayed or prove why a timer failed.
Missing cgroup v2 counters produce an error rather than a zero value. The extra
process and reads add load, so compare with repeated uninstrumented controls and
retain sampling start and exit status. This capture is diagnostic only and does
not extend the readiness deadline or grant device access.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -p 'test_cpu_throttle_capture.py' -v
```
