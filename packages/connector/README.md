# Open3DFarmManager Connector

Local Phase 0 CLI for Node.js >=24.22.2 <25. No package has been published. Build from this checkout with the project's installed pnpm dependencies:

```sh
pnpm --dir packages/connector build
node packages/connector/dist/cli.js --help
```

The built `dist/` directory includes `LICENSE`, `THIRD_PARTY.md` and `ZOD-LICENSE`. Keep these notices alongside `cli.js` in any distribution; copying only the bundled JavaScript omits required notices.

## Initialize and inspect local identity

Choose a private data directory owned by your OS user. Replace the example path below with that directory. Initialization is explicit; there is no default path and help/version do not create files.

```sh
node packages/connector/dist/cli.js init-identity --data-dir /path/to/private-data
node packages/connector/dist/cli.js identity --data-dir /path/to/private-data
```

`init-identity` creates an Ed25519 identity only when none exists, or reuses a valid existing identity. Repeating it preserves the key and fingerprint. `identity` only reads. Successful output is JSON containing algorithm, fingerprint and public SPKI; it does not contain the private key.

This is local identity preparation, not pairing or authentication. The CLI makes no network request and starts no service. `pair`, `run`, service installation and printer discovery/control are not implemented. Initializing an identity does not register or authorize it with a farm.

On failure the CLI exits nonzero with a fixed pt-BR message. Existing corrupt identity data is not overwritten. Incomplete initialization may leave recovery files; do not delete them or generate replacement keys without reviewing [identity recovery constraints](../../docs/CONNECTOR-IDENTITY.md).

Private files are protected with OS ownership and permissions, not encryption. Windows remains unsupported until an ACL implementation exists. Keep the data directory private and do not commit it. Backup, rotation and credential storage remain unimplemented.

## Verification

The source and built CLI are tested against disposable temporary directories: initialization, repeat invocation, read-only inspection, unchanged private bytes, argument rejection, corrupt-file preservation and use of the persisted identity in a synthetic server challenge. No production identity, account or real device is used.
