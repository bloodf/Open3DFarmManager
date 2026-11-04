# Native amd64 full-harness result

The bounded PTY candidate was tested on native x86_64 with the complete isolated four-service harness on 2026-11-04. **The unchanged `sim:verify` command failed Klipper readiness. The candidate is not approved for integration into the default harness.** The earlier ARM64 results do not generalize to this environment.

## Test configuration and outcomes

SV06 and U1 used the original pinned amd64 Klipper image and existing project fixtures, with the exact committed MIT helper mounted read-only. The temporary Supervisor configuration disabled automatic Klippy restart and startup retries and prepended the bounded launcher. CPU, memory, PID limits and firmware remained unchanged. Spoolman retained its pinned image and nonroot configuration. No physical device or printer command was used.

The original synthetic-camera source ran read-only on the official Node 24.20.0 Alpine runtime resolved to a digest, with the same user, environment, resource and capability restrictions as its Dockerfile/service. Its image build was not repeated. The dedicated network and volumes contained synthetic data; all published ports bound only to loopback and were reached through a temporary SSH forward.

| Check                                                         | Result                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Native amd64 architecture and pinned Klipper source label     | Verified                                                              |
| Complete `sim:verify`, original ready criterion and deadlines | Failed: Klippy state was `error`, expected `ready`                    |
| SV06/U1 logs collected after failure                          | 18 identification timeouts each, zero loaded MCU, `Unable to connect` |
| Launcher behavior                                             | Klippy launched; no launcher timeout was recorded                     |
| Four-tool and webcam assertions inside full acceptance        | Not reached because readiness failed                                  |
| Independent Spoolman seed, two runs                           | Both returned 2 vendors, 4 filaments, 6 spools                        |
| Independent synthetic camera check                            | Valid bounded JPEG, 7,769 bytes                                       |

The timeout count comes from logs collected after the acceptance failure, not a claim that all 18 occurred inside the gate's 90-second window. CPU throttling was present in the snapshots; this does not prove its causal role. No timeout, readiness condition or firmware tolerance was increased to obtain a pass, and no late readiness retry was counted as success.

## Separate security and provenance review

Recorded manifests/runtime metadata confirmed amd64 and the expected upstream revision label. The exact helper SHA-256 matched the local committed file. Source review confirmed its monotonic admission bound, descriptor cleanup, no terminal-setting or data-read operation, direct argument forwarding and nonzero launch failure. These are prerequisite properties; none authenticates a device or substitutes for MCU readiness.

Runtime assertions verified no privileged mode, added capabilities, device mounts or host networking. All bind mounts were read-only and inside the task's temporary directory; named volumes belonged to the unique project; all published bindings were loopback-only. The external GPL image/configuration remained separate from original MIT helper code. This review does not convert the failed functional acceptance into approval.

## Cleanup and decision

Project `o3dfm-full-amd64-20261104` owned four service containers, three volumes, one network and a temporary configuration-inspection container. These and the three newly introduced image references were removed. All four resource inventories returned to their baseline sets. The SSH forward, remote temporary directory and local transfer files were removed after preserving evidence. No broad prune or pre-existing resource deletion occurred.

Compose, CI, production settings and image selection are unchanged. No default mitigation integration or publication was prepared because the acceptance prerequisite failed. Existing source checks were not repeated for this documentation-only checkpoint; no application or helper source changed. The next step requires an independently validated emulator/identification solution or an explicitly evaluated alternative, not promotion of the PTY candidate based solely on its ARM64 successes.

The [static serial/firmware comparison](SIMULATOR-SERIAL-STATIC-REVIEW.md) verifies identical firmware/dictionary bytes across images and narrows the next diagnostic without claiming the timing hypothesis is proven.
