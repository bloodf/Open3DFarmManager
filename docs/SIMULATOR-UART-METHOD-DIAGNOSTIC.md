# Experimental UART method observation

`infra/sim/experiments/uart_method_diagnostic.py` is original MIT code using only
Python's standard library. It is an opt-in experiment, absent from Compose and CI.
No emulator was executed to implement or test it. Native amd64 is now available;
the prior lack of native access is obsolete. The native nonprivileged control
remained in startup with identification timeouts. Neither that result nor this
helper establishes a root cause or full simulator acceptance.

## Reviewed source and license boundary

The wrapper checks the actual supplied `avrsim.py` bytes before executing them.
The required SHA-256 is
`a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c`,
from [Klipper revision ee2c6fb6b00b2b5d097ef70d0868df7d74943b51](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/scripts/avrsim.py).
A mismatch or oversized source fails before import or execution. The wrapper
executes the same validated in-memory bytes, installs method wrappers, and calls
that script's `main()` with the original arguments. It does not accept arbitrary
commands. This gate attests one source file, not the image, firmware or loaded
`pysimulavr` native library. The native library revision remains unverified.

The reviewed upstream files carry GPLv3 notices. Their implementation is not
copied into this MIT repository. The externally supplied simulator retains its
own license. No new dependency or third-party implementation is distributed.

## What each event means

The driver creates a nonblocking PTY master, configures raw terminal attributes,
and links the slave for Klippy. `TerminalIO.read()` removes master bytes and
returns them to the D0 transmission queue. Firmware D1 sampling produces a byte
passed to `TerminalIO.write()`. The wrapper calls each original method exactly
once and returns its original object or propagates its original exception. It
never opens or reads another PTY descriptor, changes terminal attributes, retries,
adds sleeps, changes timeouts, intercepts syscalls, or changes security controls.

| Observation                    | Established fact                                                   | Remaining gap                                                                       |
| ------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Nonempty `read` return and hex | Bytes removed from master by the original method                   | D0 transmission, firmware reception and command acceptance                          |
| Empty `bytes` read return      | Original method returned empty bytes                               | Why the read was empty                                                              |
| Empty `str` read return        | Upstream swallowed an `OSError`                                    | EAGAIN versus other errno; the latter also stops the simulator clock                |
| Write argument hex             | Decoder passed these bytes to the original method                  | Exact syscall count, short write and delivery                                       |
| Normal write return            | Method returned without raising                                    | The method discards `os.write` count; `None` is not a zero or successful-byte count |
| Propagated exception           | Original method raised this exception type and, for OSError, errno | Errors swallowed inside upstream read are invisible                                 |

Events bracket calls with monotonic nanoseconds, process CPU nanoseconds and
simulation ticks when available. Clock failure produces null, without replacing
the method's result or exception. Simulation ticks come from
`SystemClock.Instance().GetCurrentTime()`; the driver defines a 1 GHz simulation
clock. This is not verification of native clock implementation. Process CPU time
aggregates threads and cannot measure scheduler starvation. Comparing timestamps
across processes requires verifying their common clock domain.

The stream prefix is `O3DFM_UART_METHOD `. A start records the source gate. Read
records contain `returned_bytes` and `returned_hex`; write records contain
`argument_bytes`, `argument_hex`, `syscall_count: null` and `delivery: unknown`.
Exceptions describe only exceptions escaping the method. No payload, exception
message, private path or file descriptor is included in exception metadata.

Capture emits at most 4,096 events plus one fixed-size footer and retains at most
65,536 payload bytes across events. Repeated empty reads of each type are counted
in the footer after their first event. Oversized method payloads and records
beyond the bounds are dropped and counted. Payload snapshots do not mutate the
argument. Output failure disables further output; a missing footer is incomplete.
There is no timer or background process. The separately authorized coordinator
must stop collection at the unchanged original experiment deadline.

Analyzer input is capped at 4 Mi characters, 65,536 characters per line and 4,097
records, including the footer. Unrelated lines count toward input limits. A
missing start/end, abnormal exit or dropped event is inconclusive. An empty
capture never establishes silence. `complete-method-capture` means only that a
source-gated wrapper reached its normal footer with no recorded drops; it does
not establish healthy clocks, delivery, dictionary loading or readiness. A
silently damaged capture cannot be ruled out by this format alone; independently
retain process status and complete bounded stderr.

## Proposed discriminating experiment, not authorized by this document

1. Schedule a native amd64 uninstrumented control and instrumented execution
   using image manifest
   `sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47`
   and simulator revision `e272bcd1060dad6cee1598d6debdaa5d5afae3c7`.
   Reuse the exact separately retained private nonprivileged launcher/config,
   UID 1000, one CPU, 1 GiB, 256 PIDs, dropped capabilities, no-new-privileges,
   no network, no ports and no devices. Record ownership before starting.
2. In the instrumented configuration, replace only the emulator executable
   portion with the helper below, preserving interpreter, original arguments,
   startup order/delay, restart settings, firmware and original 90-second bound.
   Keep helpers read-only and capture stderr in bounded external evidence.
   No native execution has occurred in this implementation task.
3. Correlate returned master bytes, decoder write attempts and existing accepted
   identification events. Repeated controls are needed because observation adds
   clock reads, allocation, JSON and output overhead. This is passive only with
   respect to deliberately modifying serial bytes, not timing.
4. If streams are insufficient, separately review native host I/O and
   frame/sequence probes, bounded D0/D1 traces and per-thread scheduling capture.
   Verify exact native libraries, signal identities, clock alignment and trace
   permissions without adding capabilities or weakening isolation.

Invocation shape for the later approved configuration only:

```text
python3 /opt/o3dfm/uart_method_diagnostic.py observe /path/to/verified/avrsim.py -- ORIGINAL_EMULATOR_ARGS
```

Analyze an externally captured stream without starting the emulator:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 infra/sim/experiments/uart_method_diagnostic.py analyze < CAPTURE
```

| Hypothesis                | Discriminating observation still required                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Request not written       | Native host syscall return and matching master return; absent method bytes alone do not decide this                                |
| Firmware response absent  | D0 delivery/firmware receive plus D1 activity; absent decoder calls alone do not prove silence                                     |
| PTY loss                  | Matched endpoint identity and host/master syscall returns; method write return cannot detect short writes                          |
| Decoding or baud mismatch | Verified firmware UART settings and bounded D0/D1 bit trace compared with decoder method bytes                                     |
| Scheduler starvation      | Verified per-thread runnable/scheduling intervals aligned to simulation and identification; process/cgroup totals are insufficient |

The pinned [host queue](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/chelper/serialqueue.c)
and [frame checker](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/chelper/msgblock.c)
separate raw reads, incomplete input, frame validation and sequence rejection.
This wrapper observes none of those native boundaries and performs no frame,
CRC or dictionary decoding. [Firmware UART initialization](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/src/avr/serial.c)
is another independent boundary. Do not infer any of them from method counts.

## Local verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -p 'test_uart_method_diagnostic.py' -v
```

Fixtures are original synthetic classes and in-memory streams. They verify exact
return/exception behavior, hidden-errno and write-count limits, clock/output
failure, source rejection before execution, argument forwarding and bounds.
They start no emulator, container, SSH session, device or service and write no
bytecode or temporary files. Native integration and `bun run check:all` remain
pending; these experimental Python checks are not part of that unchanged gate.
