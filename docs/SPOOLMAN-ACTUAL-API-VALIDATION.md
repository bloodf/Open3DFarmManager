# Disposable Spoolman API compatibility

The opt-in `scripts/test-spoolman-reader.ts` exercises the actual HTTP reader against a fresh disposable Spoolman service. It is deliberately excluded from CI and `check:all`; its setup writes synthetic vendor, filament and spool records and archives one synthetic spool. The reader itself uses GET only.

To run against an explicitly created disposable instance, set `SPOOLMAN_SYNTHETIC_TEST_ORIGIN` to its canonical loopback HTTP origin and `SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE=yes`, then run `bun scripts/test-spoolman-reader.ts`. It refuses to seed a nonempty spool inventory. This check is a guard, not proof of ownership: operators must create and verify the disposable service themselves before invoking it.

Coverage includes an initially empty inventory, two idempotent seed executions, six spools with four filaments/two vendors, exact remaining weights, page limits 1/2/4/200, trusted scope retention, and inclusion of an archived spool. Limits 1 and 2 exercise an empty terminal page; limit 4 exercises a partial terminal page. Synthetic transport tests separately cover malformed responses, redirects, cancellation and deadlines.

Compatibility with one pinned Spoolman version does not validate authentication, production deployment, persistent mirroring, concurrent upstream edits, UI integration, or the full Klipper simulator gate. No physical printer is involved.

## Observed local result

On 2026-11-04 the test passed using OrbStack and the existing harness's linux/amd64 Spoolman image pinned to `sha256:1405c3db0661cabf45209701f95304cf65f7db3b0f262dc824d32a1694fdf5fa`. The health endpoint became ready in 26.59 seconds after inspection; the integration script exited 0 with all assertions passing. No reader changes were necessary.

The container ran as UID/GID 1000, with all capabilities dropped, no-new-privileges, no devices/privileged mode, 0.5 CPU, 512 MiB memory and 128 PIDs. A uniquely labeled bridge network and volume belonged exclusively to this run. The service published only on 127.0.0.1. This bridge did not block outbound traffic; it is not an egress isolation claim.

Two prior setup attempts using an internal Docker network yielded no published port, including one with the container confirmed running after three seconds. Neither reached API validation. Both were cleaned before the dedicated bridge attempt; the reader and CI gates were unchanged.

Cleanup removed each run's container, volume, network and newly pulled unused image. Label-filtered inventories were empty afterward; pre-existing resources were preserved. Local evidence retains the setup failures, successful result, inspection restrictions and application log outside the public repository.

`bun run check:all` also passed: lint, typecheck, 173 Bun tests, 92 Node tests and Connector/Nuxt builds. The separate real API compatibility run is not counted as a new unit test. No GitHub Actions run, publication, production access or full simulator acceptance is implied.
