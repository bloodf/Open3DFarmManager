# Changelog

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
