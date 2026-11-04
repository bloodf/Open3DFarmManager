# Local simulator

Requires a running Docker daemon and Compose. This project has its own network and volume; ports bind only to loopback. It never receives host devices, Docker sockets or production configuration.

```sh
docker compose -f infra/sim/docker-compose.yml --profile klipper up -d
bun run sim:smoke
docker compose -f infra/sim/docker-compose.yml --profile klipper down
```

The smoke check requires Moonraker to report both an active Klippy connection and `ready` state. An HTTP 200 alone is insufficient. It times out after 90 seconds and rejects non-loopback destinations and redirects.

The upstream image is pinned to its reviewed amd64 manifest. ARM hosts need Docker emulation. The simulator runs upstream GPL software as a separate process. See [upstream documentation](https://github.com/mainsail-crew/virtual-klipper-printer); this repository does not vendor or relicense its code.

The first slice covers E0.1.1 only. Four-tool U1, Spoolman, cameras and network fault profiles are subsequent gates. Do not treat this single-printer smoke as full E0.1 acceptance.

`down` preserves simulator data. Only remove its named volume when you intend to reset test data.
