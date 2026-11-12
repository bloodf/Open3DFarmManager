# Simulator network faults and two-printer acceptance checkpoint

Issue #2 (E0): "Isolated NAT, latency/loss and UDP-block scenarios" and the
two-printer / four-tool / Spoolman simulator acceptance. Runs on 2026-11-12 UTC
on a shared native x86_64 Docker host (Docker 29, Node 24.22.2, load average 13
to 25). No physical printer was contacted and no printer command was sent.

## Network fault harness

`infra/sim/netfault/run.sh <nat|netem|udp-block> [repeats] [out-dir]`. The
topology, capabilities and isolation are described in
[its README](../infra/sim/netfault/README.md). In short: a Connector-side peer
sits behind a NAT router on its own namespace, and a browser-side peer sits on
a separate internal network. Faults are applied with `iptables`/`tc` inside the
router only (`NET_ADMIN` on the router and the lan namespace holder, nowhere
else). Each repeat starts the topology fresh.

The probe uses the Connector's `PeerConnection` options: no STUN/TURN, no
ICE-TCP, fingerprint verification on. It runs twice per repeat:

- `loopback`: the Connector's current `bindAddress: '127.0.0.1'`, set in
  `readonly-peer.ts`, `pause-control-peer.ts` and `synthetic-peer.ts`.
- `any`: the same options bound to all interfaces.

### Results (3 repeats each)

| Scenario                                       | `loopback` (Connector policy)                                    | `any`                                                                                              | TCP signalling |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------- |
| NAT (masquerade)                               | 3/3 failed: only a `127.0.0.1` candidate, ICE `checking` at 20 s | 3/3 open in 221–232 ms; 40/40 echoed; RTT median 1 ms; both sides see `prflx 10.231.31.2` (router) | 6/6 ok         |
| netem 100 ms ± 10 ms, 5 % loss, each direction | 3/3 failed (as above)                                            | 3/3 open in 3.0–4.2 s; 40/40 echoed; RTT median 204–216 ms                                         | 6/6 ok         |
| UDP-block (`FORWARD -p udp -j DROP`)           | 3/3 failed                                                       | 3/3 failed: ICE `checking` at 20 s                                                                 | 6/6 ok         |

### What this establishes

- **Finding: the Connector cannot open WebRTC to any browser on another host.**
  Every Connector `PeerConnection` binds ICE to `127.0.0.1`. That is the
  documented Phase 0 policy ("Native RTC remains restricted to its existing
  loopback-only policy", [Connector RTC runtime](CONNECTOR-RTC-RUNTIME-CHECKPOINT.md)).
  The only candidate it offers is a loopback address, so even a direct LAN path
  fails, not just NAT. Live status, camera and signed commands therefore work
  only when browser and Connector share a host. Changing the bind policy is a
  product and security decision for the owner and is not made here.
- With an all-interfaces bind, the same ICE configuration crosses a single NAT
  without STUN: the browser learns the Connector as a peer-reflexive candidate.
  It also survives 200 ms added round trip with 5 % loss each way. Setup is
  slower (3–4 s); SCTP retransmission delivered every message.
- With UDP blocked, WebRTC fails as designed (no TURN, no ICE-TCP) while TCP
  signalling keeps working. That is the precondition for the read-only degraded
  mode. This harness checks the transport only: the farm page's switch to
  read-only is covered by the real-RTC runner rows (`farm-page-disconnect`,
  [RTC farm acceptance](RTC-FARM-ACCEPTANCE-CHECKPOINT.md)). A UDP-block row on the
  real farm page needs a non-loopback Connector bind to be meaningful (above).

## Two-printer / four-tool / Spoolman acceptance

`scripts/test-sim-farm-acceptance.ts` (helpers
`tests/helpers/sim-farm-acceptance.ts`, `connector-enrollment.ts`,
`disposable-postgres.ts`):

```sh
pnpm --dir apps/farm build
SIM_ACCEPT_ADMITTED=yes \
SIM_ACCEPT_IMAGE='postgres:17@sha256:<digest>' \
SIM_ACCEPT_PORT_BASE=<port> \
SIM_ACCEPT_WORK_ROOT=<absolute directory outside the repository> \
SIM_ACCEPT_PROJECT=o3dfm-<name> \
node scripts/test-sim-farm-acceptance.ts
```

It uses ports `base..base+8`, starts the `infra/sim` stack (`klipper`,
`spoolman`, `cams`) under its own Compose project with remapped loopback ports,
and a disposable PostgreSQL 17 (shared helper, same hardening as the outage
runner). Then:

1. Both genuine Klipper/Moonraker printers become `connected` + `ready` within the
   unchanged 90 s budget.
2. The Spoolman seed (2 vendors, 4 filaments, 6 spools) is applied twice with an
   identical result.
3. Connector discovery (`discoverMoonraker`, #106) against both printers: ready,
   u1 exposes exactly `extruder`..`extruder3`, sv06 exactly `extruder`, and each
   reports its webcam.
4. The Connector's Spoolman provider (HTTP traversal plus websocket
   invalidation) observes the seeded spools.
5. Real enrollment (pairing, proof, approval, credential claim, two printer
   assignments), the built farm server behind a loopback TLS front, and the real
   Connector CLI `run` with both printers and the Spoolman section. Telemetry for
   both `sv06` and `u1` must be ingested into `farm.telemetry_events`, and the
   Connector must exit 0 on SIGTERM.

It removes its Compose project (containers, volumes, network, built images), the
PostgreSQL container (verified by ID and label), its database roles and its work
directory. Evidence is kept only on failure.

### Results

Three consecutive runs plus one earlier run passed (each a fresh Compose project,
fresh volumes, fresh PostgreSQL and fresh enrollment), with
`postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`:

| Run | Total  | Both ready | Telemetry ingested | Seed (v/f/s) | u1 tools                    | Webcams | Spools observed | Rows sv06/u1 | Connector exit | Cleanup  |
| --- | ------ | ---------- | ------------------ | ------------ | --------------------------- | ------- | --------------- | ------------ | -------------- | -------- |
| 1   | 38.9 s | 14.2 s     | 18.2 s             | 2/4/6        | `extruder`..`extruder3` (4) | 1 + 1   | 6               | 1 / 1        | 0              | complete |
| 2   | 36.0 s | 13.9 s     | 17.9 s             | 2/4/6        | 4                           | 1 + 1   | 6               | 1 / 1        | 0              | complete |
| 3   | 39.2 s | 13.7 s     | 20.4 s             | 2/4/6        | 4                           | 1 + 1   | 6               | 1 / 1        | 0              | complete |

Times are from the start of the checks (simulators already started). The
simulators were idle, so each printer produced one `idle` state record. The only
`unavailable` diagnostics were the expected `connecting` events, one per printer
at startup. The simulator images were rebuilt from a warm BuildKit cache.

The outage runner (`pnpm run test:connector-outage`) now uses the shared
enrollment and PostgreSQL helpers. It passed once after the refactor (89.9 s, all
scenarios, cleanup complete).

### Not covered yet

- **Inventory and multi-tool state on the farm page over RTC.** Spoolman snapshots
  leave the Connector only through the WebRTC status channel, so the end-to-end
  "inventory flows to the browser" check belongs in the real-RTC runner
  (#140, now on `main`). A row there needs a `test-signalling-https.ts` opt-in that
  points the Connector at the genuine simulators and Spoolman instead of its
  synthetic Moonraker, plus farm-page assertions for inventory and tools. That is
  the next slice, in a separate scenario file.
- **Discovery is not wired into the Connector runtime (#106 scope).** Tools and
  webcams are verified through the Connector's discovery module, not through
  telemetry or the farm page.
- **NAT/netem/UDP-block on the real farm page.** Blocked by the loopback bind
  policy above until the owner decides on it.
