# Simulator readiness result

Executed on 2026-11-12 on a native x86_64 Docker host (24 cores, cgroup v2,
shared with unrelated workloads; load average 6 to 73 during the runs). This
closes the readiness investigation started in
[SIMULATOR-READINESS-DIAGNOSIS.md](SIMULATOR-READINESS-DIAGNOSIS.md). The
readiness criterion, 90-second deadlines, Klipper firmware, Klippy timeouts,
CPU/memory/PID limits and container security settings are unchanged. No
physical printer was involved.

## Root cause

The pinned `virtual-klipper-printer` image builds simulavr without
optimisation. Its build files carry only `-Wall -std=gnu++11` (no `-O` flag,
empty `CMAKE_BUILD_TYPE`). The candidate digest from Renovate PR #98
(`27ea11e…`) has the same defect (`-fPIC -std=gnu++11`).

Two failures follow from that, one per architecture report:

1. **Identify timeout (amd64).** Measured with a diagnostic client that ran
   Klipper's own `SerialReader` against the emulator PTY with a 120-second
   wait, the stock emulator ran the 20 MHz MCU at **0.037× real time**. A
   complete identify (3,672 dictionary bytes, 93 request/response round trips)
   took **9.3 s**. Klippy waits a fixed 5 s for the whole identify
   (`serialhdl._start_session`), so every attempt timed out (17 per printer)
   until Klippy gave up with `Unable to connect`. The MCU was answering, just
   too slowly. Faster cores (the ARM64 hosts in earlier reports, about 3.96 s)
   land just under the limit, which explains the intermittent results seen
   upstream and in earlier reports.
2. **`Timer too close` after ready (ARM64, and amd64 once optimised).** With
   simulavr rebuilt at `-O3` (Release), identify succeeded on every attempt.
   Unpaced emulation then ran at 0.13–0.33× real time depending on host load.
   Klippy's clock sync fits the MCU frequency it sees right after connect
   (for example 2.6 MHz). When host contention drops, the emulator speeds up,
   the MCU clock runs ahead of the host's prediction and scheduled commands
   arrive late: `MCU 'mcu' shutdown: Timer too close`.

## Hypotheses tested

| Hypothesis                                         | Evidence                                                                                                                                                    | Verdict                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Firmware/emulator never answers identify           | Diagnostic client completed the full identify in 9.3 s                                                                                                      | Rejected                  |
| PTY start ordering (Klippy before emulator)        | Only the first attempt saw a missing PTY; 16 later attempts with the PTY present still timed out                                                            | Not sufficient            |
| cgroup CPU quota throttling                        | Emulator measured at 0.037× with Klippy stopped; throttled time under 1 s per 110 s run                                                                     | Not the primary cause     |
| Unoptimised simulavr too slow for the 5 s identify | Build flags lack `-O`; 0.037× measured; `-O3` rebuild: 0 identify timeouts                                                                                  | **Confirmed** (failure 1) |
| Variable unpaced emulator speed                    | Unpaced: 4.7–6.2 MHz drift, `Timer too close`; paced 0.2×: emulator fell to 2.6 MHz under load and shut down; paced 0.1×: locked at 2.000 MHz, no shutdowns | **Confirmed** (failure 2) |

## Fix

`infra/sim/klipper/Dockerfile` derives the simulator image from the **same
pinned digest**:

- a builder stage installs a compiler toolchain and rebuilds the simulavr
  sources already in the pinned image with `CMAKE_BUILD_TYPE=Release`;
- the runtime stage copies only the rebuilt `simulavr/build` directory and
  adds avrsim's built-in real-time pacing (`-r 0.1`) to the Supervisor
  command. Pacing caps emulated time at 0.1× wall time (2 MHz effective). That
  rate sits below the slowest rate measured under heavy host load, so the MCU
  clock stays linear and Klippy's frequency estimate holds.

Compose builds this image for `sv06` and `u1`. Upstream GPL code stays in the
external image; the repository adds only the MIT build recipe. The builder
installs its toolchain from a fixed `snapshot.debian.org` timestamp
(`20261101T000000Z`) with exact package versions, plus a hash-locked
`setuptools==80.9.0` wheel; none of it reaches the runtime image. The runtime
stage keeps the upstream `printer` user (`Config.User` of the pinned image) and
`/bin/start` entrypoint. `SIMULAVR_PACING_RATE` is validated as a number in
(0, 1] before the Supervisor command is edited. Without a warm cache the build
takes about four minutes on the test host, so the manual `Simulator` workflow
timeout moved from 10 to 20 minutes. Local CI cleanup now passes `--rmi local`
to remove the built images, and its running-simulator check also matches the
derived `-sv06`/`-u1` images and Compose service labels.

`scripts/simulator-identify-diagnostic.mjs` intentionally keeps running the
**stock** pinned image, so it can still reproduce and observe the original
failure. Its preflight now checks that the harness Compose file builds `sv06`
and `u1` from `./klipper` and that the Dockerfile's final stage is the pinned
digest.

| Variant (pair cold starts) | Runs | Both ready     | Identify timeouts | `Timer too close` |
| -------------------------- | ---- | -------------- | ----------------- | ----------------- |
| Pinned image (stock)       | 1    | 0              | 17 per printer    | 0 (never ready)   |
| Candidate `27ea11e` stock  | 2    | 0              | 17 per printer    | 0 (never ready)   |
| `-O3`, unpaced             | 1    | Ready at 17 s  | 0                 | SV06 shut down    |
| `-O3`, paced 0.2×          | 3    | 2 stayed ready | 0                 | 1 SV06 shutdown   |
| `-O3`, paced 0.1×          | 3    | 3 stayed ready | 0                 | 0                 |

## Acceptance

All runs used the committed `infra/sim/docker-compose.yml` (only the published
loopback ports were remapped by a local override) on the same shared host.

**Ten consecutive cold starts.** Each run removed the containers and volumes,
then started `sv06` and `u1` together on fresh volumes and sampled
`/server/info` about once a second for roughly 110 seconds.

| Metric                                   | SV06                | U1 (four tools)     |
| ---------------------------------------- | ------------------- | ------------------- |
| Runs reaching `connected` + `ready`      | 10/10               | 10/10               |
| First ready (seconds after `up -d`)      | 18.2–22.7           | 18.2–22.8           |
| Samples not `ready` after first ready    | 0                   | 0                   |
| Identify timeouts                        | 0                   | 0                   |
| `Timer too close` / MCU shutdown         | 0                   | 0                   |
| Final Klippy MCU frequency estimate (Hz) | 1,999,951–2,000,473 | 1,999,349–2,000,152 |

**Full harness, three cold starts.** All three profiles (`klipper`,
`spoolman`, `cams`) were started fresh each time, followed immediately by
`pnpm run sim:smoke` and `pnpm run sim:verify` with the unchanged 90-second
deadlines. All three runs printed `SIM_SMOKE_OK` and
`SIM_FULL_OK: 2 ready printers, 4 tools, webcams, synthetic JPEG and 6 seeded
spools` (exit 0 for both commands).

`sim:verify` had never completed under Node. It crashed while loading the
Spoolman seed (`ERR_IMPORT_ATTRIBUTE_MISSING`) because the JSON import had no
`with { type: 'json' }` attribute. That is fixed, and
`tests/node/sim-tools-node-import.test.ts` covers it.

Not run: `scripts/local-ci.sh klipper` publishes the default ports
(7125/7126/8110/8111) on a shared host and was not executed there. The
GitHub `Simulator` workflow is manual-dispatch only and was not dispatched.

## Limits

Pacing makes the simulated MCU run ten times slower than real hardware.
Commands and heater simulation take ten times longer in wall-clock terms.
This is acceptable for API and readiness tests but not for timing
measurements. A host whose emulator cannot sustain 0.1× real time (very slow
or heavily oversubscribed CPUs) could still fail. Raise `SIMULAVR_PACING_RATE`
only on hosts measured to sustain the higher rate under load. The candidate
digest from PR #98 gives no improvement and is not needed for this fix; the
pinned digest is kept.
