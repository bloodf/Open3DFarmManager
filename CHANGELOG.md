# Changelog

## 0.1.0

### Farm app

- Polish farm dashboard, printer detail, spool management, and job history layouts, empty states, and accessibility.
- Support connecting encrypted Bambu Cloud accounts per farm, importing cloud printers into setup, and viewing AMS state and cloud print history.
- Add password change and global sign-out flows in browser sessions.

### Integration API

- Report optional printer specs (`buildVolumeMm`, `nozzles`, `spoolSlots`, `multicolor`) on printer reads (OpenAPI 1.1.0).
- Fix 503 service unavailable errors on inventory and job history caused by `sql.array` removal in `postgres` 4.1.1.
- Expose library files and job replay through the v1 integration API.
- Add v1 bulk printer status and alert webhooks.

### Connector

- Add native Anycubic Kobra X telemetry support using the bundled slicer certificate and `printer/public` report subscription.
- Accept unknown envelope members in Snapmaker U1 pause replies and vendor members in Moonraker responses.
- Qualify Moonraker printer identity detection and multi-webcam discovery.
- Support configurable WebRTC ICE bind address (`rtc.bindAddress`).

### Install and upgrade

- Add first-install self-hosting guide and Docker Compose setup walkthrough.
- Gate release archive builds on upgrade rehearsal verification and verify Connector native binary provenance.
- Harden database migration sequencing and CLI rollback authorization checks.

### Website

- Launch static documentation website with component architecture diagrams and printer compatibility matrix.
- Publish step-by-step installation guide and hosting, validation, and license FAQ.

## 0.0.1

- Initial Open3DFarmManager release with the farm app and Connector.
- The Connector CLI and the farm app health endpoint report the project version.

## Release process

Set the release version in the root `package.json`, update its lockfile
metadata with `npm install --package-lock-only --ignore-scripts`, and add
the corresponding changelog entry.

Dispatch **Release** with owner approval unchecked to build and download the
Linux amd64 image archives, Connector runtime tarball, and `SHA256SUMS` from
the workflow run. Verify the downloads with `sha256sum -c SHA256SUMS`.
Load either image archive with `docker load -i <archive>`. The Connector
runtime tarball requires Node 22 on Linux amd64 with glibc. Extract it and run
`node dist/cli.js --version` inside the extracted directory.

To publish, dispatch from the default branch after the owner approves the
release and check the owner approval input. Configure the `release`
environment with an owner required reviewer where supported. The publish job
pushes versioned images to GHCR and creates the version tag and GitHub Release
with the same archives and checksums.
