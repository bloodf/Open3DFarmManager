# Real-RTC farm page against the genuine simulators

Issue #2 (E0). An opt-in row for the [real-RTC farm-page runner](RTC-FARM-ACCEPTANCE-CHECKPOINT.md):
`farm-page-simulator-inventory`. The Connector runtime collects from a genuine
Klipper/Moonraker simulator and a seeded Spoolman instead of the synthetic
Moonraker fixture. The farm page must then show that printer's live state, its
temperatures and the Spoolman inventory over the existing WebRTC path. It
stays inside the current loopback-only RTC policy: browser, Connector and
simulators share one host. It is read-only; the pause button must stay disabled
and no printer command is sent.

## Running it

Start, seed and later remove the simulators yourself. For example, with
`infra/sim` and remapped loopback ports:

```sh
docker compose -p o3dfm-sim -f infra/sim/docker-compose.yml -f <ports override> \
  --profile klipper --profile spoolman up -d --build
SIM_SPOOLMAN_URL=http://127.0.0.1:<spoolman port> pnpm run sim:seed
RTC_FARM_TEST_ADMITTED=yes RTC_FARM_TEST_IMAGE='postgres:17@sha256:<digest>' \
RTC_FARM_TEST_DB_PORT=<port> RTC_FARM_TEST_WORK_ROOT=<absolute dir outside the repo> \
RTC_FARM_TEST_SIM_MOONRAKER=http://127.0.0.1:<u1 moonraker port> \
RTC_FARM_TEST_SIM_SPOOLMAN=http://127.0.0.1:<spoolman port> \
RTC_FARM_TEST_SCENARIOS=farm-page-simulator-inventory \
pnpm run test:rtc-farm
```

The row exists only when both `RTC_FARM_TEST_SIM_*` origins are set. Each must be
`http://127.0.0.1:<port>`. Without them the registry, default selection and
existing rows are unchanged.

## What it checks

| Step        | Check                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source      | The Connector fixture child reads `/server/info`: Klippy connected and ready. Its runtime config points the printer at the simulator and adds the Spoolman section (`farmId` from the issued credential). |
| Live state  | The printer row shows "Conexão direta autenticada" and the state "Ociosa". Both temperature readings are numeric `°C` values, and "Pausar impressão" is disabled.                                         |
| Inventory   | The Spoolman section shows "Bobinas (n de m)" with n at least 6 (the seed) and every seeded filament name as a row header.                                                                                |
| Degradation | After the signalling connections drop, the row turns read-only ("Conexão direta indisponível...") within 10 s and the pause button stays disabled.                                                        |

## Code

- `tests/helpers/rtc-farm-acceptance-sim-scenarios.ts`: the row (separate file)
  and the child-side source check.
- `tests/helpers/signalling-sim-farm-page.ts`: the farm-page assertions.
- Hunks in shared files, 32 lines in total:
  - one spread line in the registry (`rtc-farm-acceptance-scenarios.ts`);
  - forwarding the two `SIGNALLING_HTTPS_SIM_*` variables to the Connector child and dispatching to the simulator page check (`signalling-authenticated-rtc.ts`);
  - the opt-in source and Spoolman section (`signalling-runtime-moonraker.ts`).
- `tests/node/rtc-farm-sim-scenarios.test.ts`: the row is absent by default and
  rejects partial or non-loopback origins.

## Results

On 2026-11-12 UTC, cortexos (native x86_64, Docker 29, Node 24.22.2) used the
pinned simulators from `infra/sim` (u1 four-tool printer, Spoolman seeded 2/4/6)
and `postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`.
`RTC_FARM_TEST_REPEAT=3` gave **3/3 passes**:

| Run | Row time | Observed state / temperatures | Spools shown | Read-only after |
| --- | -------- | ----------------------------- | ------------ | --------------- |
| 1   | 17.9 s   | Ociosa / 103,3 °C, 103,3 °C   | 6 of 6       | 14 ms           |
| 2   | 17.5 s   | Ociosa / 103,3 °C, 103,3 °C   | 6 of 6       | 12 ms           |
| 3   | 17.3 s   | Ociosa / 103,3 °C, 103,3 °C   | 6 of 6       | 14 ms           |

The 103.3 °C readings come from the emulated MCU's idle thermistor input. No
heater is on; this is the simulator's fixed ADC value, not real heat. The
regression run of the existing `farm-page-disconnect` row without the simulator
variables: passed (23.7 s, read-only after 14 ms).

Four earlier rows (two invocations) failed on a test selector, not the product.
Each reached the live state and temperatures, then timed out on the inventory
caption: the anchored text match never matched the caption, which is
interpolated across lines. The captured page already showed "Bobinas (6 de 6)"
with all six spools. The first invocation did not retain the assertion message;
the row now records it, sanitized.

## Limits

- **One printer per row.** The harness provisions exactly one assignment. The
  four-tool u1 is used, but the status protocol carries only one
  `toolTemperatureCelsius` per printer, so the page cannot show per-extruder
  state. Showing all four tools needs a protocol and UI change.
- The simulators are caller-owned; the runner neither starts nor removes them.
- Cross-host RTC (NAT, latency/loss, UDP-block on the real page) remains blocked by
  the loopback bind policy; see
  [SIMULATOR-NETWORK-FAULTS-CHECKPOINT.md](SIMULATOR-NETWORK-FAULTS-CHECKPOINT.md) (#148).
