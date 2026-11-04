# Open3DFarmManager

Open-source 3D print farm manager, licensed under MIT. Phase 0 builds an independent application and LAN Connector for Klipper/Moonraker and Spoolman.

## Development

Use Node 24.15+ (24.x), Bun 1.4.2 and Docker Compose for simulator integration.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev
```

The app opens on `http://127.0.0.1:3000`. This initial skeleton has a Portuguese home page, process liveness at `/healthz` and a hidden `/farm` route. Login, printer connections and controls are not implemented yet. The Connector currently supports `--help` and `--version` only.

```sh
bun run check:all
bunx playwright install chromium
bun run test:e2e
node packages/connector/dist/cli.js --version
```

For the isolated Klipper integration test, see [infra/sim](infra/sim/README.md). Docker must be running. The development and test commands do not deploy anything.

## Architecture boundaries

The product owns its accounts, host-only session and database. The Connector runs on the customer's LAN. Live status, camera and signed commands use browser-to-Connector WebRTC; an unavailable P2P connection leaves the UI read-only. No TURN or command relay through the server is planned.

See the [Phase 0 acceptance ledger](docs/PHASE-0.md) and [dependency/reference policy](THIRD_PARTY.md). Hardware checks follow simulator acceptance.
