# Container validation checkpoint

Executed on 2026-11-04 from the local integration branch, after explicit authorization for local Docker and isolated native-host testing. GitHub Actions execution and publication remain separately pending. No workflow or acceptance deadline was changed.

## Results

| Check                                       | Result                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Application amd64 Docker build              | Passed; image 237,695,350 bytes (below 300 MB)                                           |
| Application container liveness              | Passed; `/healthz` returned process `ok`                                                 |
| Chromium regression suite                   | 9 passed                                                                                 |
| Synthetic camera                            | Passed locally and natively; bounded valid JPEG, 7,769 bytes                             |
| Spoolman fixtures                           | Passed locally and natively; native repeat preserved 2 vendors, 4 filaments, 6 spools    |
| Klipper on ARM with amd64 emulation         | Failed readiness; observed MCU `Timer too close` shutdown                                |
| Klipper on native x86_64                    | Failed 90-second smoke readiness; MCU `No communication with MCU` / `Timeout on connect` |
| Native diagnostic with two CPUs per printer | Full verification still failed the unchanged `ready` requirement                         |

The application ran as its nonroot image user with a read-only root filesystem, all capabilities dropped and no-new-privileges. This health result is process liveness, not database readiness or working login.

The Spoolman entrypoint initially failed with `failed switching to "app": operation not permitted`: it tried to change identity after all capabilities had been dropped. The Compose fix runs directly as the image's existing UID/GID 1000. Fresh task-owned storage initialized successfully while preserving capability restrictions. This does not test migration of arbitrary existing host-owned storage.

The native simulator's one-CPU configuration showed throttling in 2,309 of 2,890 measured periods. A temporary two-CPU diagnostic did not establish readiness, so the repository CPU configuration was not changed. Root cause remains unresolved; do not attribute the failure solely to ARM emulation or claim successful four-tool acceptance. No deadline was extended, readiness condition weakened, or printer command sent.

## Isolation and cleanup

Both test environments used the dedicated project `o3dfm-phase0-20261104-2118`, synthetic data, loopback-only published ports, independent networks and three independent volumes. Native ports were forwarded only over a temporary SSH session. No production mounts, credentials, devices or configuration were used. The GPL simulator remained an external service; no upstream implementation was copied into the MIT repository.

All task containers, networks, volumes and newly introduced image references were removed after testing. Inventory comparisons in both environments confirmed that every baseline resource remained and zero additional resources remained in each category. The dedicated local buildx builder and its state volume were removed. No broad prune was used. Existing branches and unmerged work were preserved.

An initial global buildx inventory attempted to probe pre-existing remote builder endpoints and received connection-refused errors. No remote changes resulted; subsequent Docker work explicitly selected the local context and dedicated builder. Future inventory should stay scoped to the chosen context.

## Remaining gates

Resolve pinned virtual-MCU startup and repeat the unchanged smoke and full checks from fresh isolated volumes. Full acceptance must then verify both ready printers, four-tool objects and macros, webcam metadata, camera data and repeatable seeding together. RTSP, network faults, authenticated pairing, durable server persistence, WebRTC and physical hardware acceptance remain incomplete. Passing packaging and partial simulator checks does not complete Phase 0.
