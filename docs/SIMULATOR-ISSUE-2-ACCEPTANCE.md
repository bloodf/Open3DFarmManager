# Issue #2 simulator profile acceptance

Checked on 2026-11-20 against commit `e8cd8d75` plus the focused fixes in this change. Host is Linux x86_64. Docker server reports `amd64` 29.1.3. No physical printer was contacted. `OPENFARM_SIM` was unset, so the tools stayed on loopback mocks. Ports 7125 and 7912 were already taken by other tasks, so Compose was not started.

## What this run executed

| Check                                    | Command                                                                                       | Result                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Both printers ready                      | `tests/node/sim-smoke-multi.test.ts`, `e16-352` smoke and SV06/U1 discovery, `full-cli`       | pass                                                                                                                             |
| Four-tool switch and saved `active_tool` | `tests/node/sim-verify-tools.test.ts`, U1 `verifyToolSwitching`                               | pass. `full-cli` prints `SIM_FULL_OK`                                                                                            |
| u1 camera                                | U1 discovery webcam `u1-test-pattern`, `verifyWebcam`, camera mock JPEG and RTSP in `e16-354` | pass                                                                                                                             |
| NAT, latency/loss, UDP-block profiles    | `tests/node/sim-netfault-harness.test.ts`                                                     | 10 pass. Profiles `nat`, `netem` and `udp-block` parse offline                                                                   |
| Loopback latency, loss and UDP-block     | `tests/node/e16-356.test.mjs`                                                                 | 14 pass, including 5% loss with 200 ms latency and UDP-block recovery                                                            |
| Container hardening                      | `tests/node/sim-compose-hardening.test.ts`                                                    | 3 pass. `sv06` and `u1` drop all capabilities, set `no-new-privileges`, and run as `printer`. Camera base image is digest-pinned |
| Both architecture jobs                   | `tests/node/sim-workflow.test.ts`                                                             | 4 pass. The workflow file lists `ubuntu-24.04` and `ubuntu-24.04-arm`                                                            |

Node for the `node --test` runs was 24.22.2. That version is inside `package.json` engines `>=24.22.2 <25`. Vitest `tests/unit/sim-verification.test.ts` passed 5 tests on the host Node 22.22.1, because Vitest transforms TypeScript itself.

The harness test did not ask Docker to validate Compose. Its diagnostic was: `OPENFARM_SIM is not docker; offline profile parsing passed; CLI validation not requested`.

## Gaps

Issue #2 stays open. This run does not close it.

- **Node 22 pin is not on this host.** `.nvmrc` is `22.23.5`. Engines require `^22.22.3` on the 22 line. The only Node 22 binary found is `/opt/nodejs/distro-node22/node` at `v22.22.1`. It is not compiled with TypeScript support (`ERR_NO_TYPESCRIPT`), so `node --test` cannot load the `.ts` suite on it. Node `22.22.3` and `22.23.5` were not installed. No package was downloaded to fill that gap.
- **NAT was not executed.** The `nat` profile was parsed from `infra/sim/netfault/docker-compose.json`. The loopback proxy states that it does not reproduce NAT. No network namespace, router container or live NAT run was started.
- **arm64 was not executed.** The host and the Docker engine are amd64. No arm64 process, container or runner was used.
- **Actions was not executed.** `.github/workflows/sim.yml` is `workflow_dispatch` only. Nothing dispatched it. [SIMULATOR-EVIDENCE-SUMMARY.md](SIMULATOR-EVIDENCE-SUMMARY.md) still records both architectures as `pending: owner dispatch`. There is no Actions run URL for this check.
- **Go was not used.** No RTSP helper was rebuilt. The reviewed amd64 helper hash in the camera helper was not replaced, and there is no arm64 helper result from this run.

## Fixes kept with the checks

- The RTSP helper guard now looks for `if (isMockSim())` before the Compose override. The helper already calls `isMockSim()`; the old source search looked for an inlined env comparison that is no longer there.
- The UDP forwarder and the loss-rate sink set a 1 MiB receive buffer. With the default `rmem` (212992 bytes) a 400-datagram burst delivers 221 datagrams and the kernel drops the rest before the loss counter can see them. A 2 ms gap, or a 1 MiB buffer, delivers all 400 on this host.
