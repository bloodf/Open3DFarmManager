# Self-hosting: first installation

This guide deploys one Open3D Farm Manager application and its dedicated PostgreSQL database. Use an independent host, database, credentials, and cookie. Do not expose PostgreSQL publicly. Use a clean Linux VM with Docker Engine and the Compose plugin, Node.js 22 for the initializer, a DNS name, and a reverse proxy with a publicly trusted TLS certificate. Allow inbound HTTPS only (and HTTP only for certificate renewal/redirect); keep SSH restricted to administrators.

## 1. Prepare the deployment

Obtain the trusted immutable application release image and check out its matching source. Run these Bash commands as a dedicated non-root deployment operator with Docker access. Install the PostgreSQL client (`psql`) and OpenSSL on the host.

```bash
umask 077
repo="$PWD"
install -d -m 700 "$HOME/openfarm"
cd "$HOME/openfarm"
cp "$repo/infra/app/docker-compose.yml" compose.yml
cp "$repo/infra/app/pairing.compose.yml" pairing.compose.yml
```

Create a private `.env` in this directory. Replace the image placeholder with the release image pinned by digest and generate the database password with `openssl rand -hex 24`.

```dotenv
O3DFM_APP_IMAGE=registry.example.org/owner/farm@sha256:RELEASE_DIGEST
O3DFM_DB_PASSWORD=REPLACE_WITH_GENERATED_PASSWORD
O3DFM_APP_ENV_FILE=./state/app.env
NUXT_DATABASE_MIGRATIONS=verify
```

These commands use the default database name `open3dfarm`, bootstrap user `open3dfarm_owner`, and host database port `5433`. If you set `O3DFM_DB_NAME`, `O3DFM_DB_USER` or `O3DFM_DB_PORT`, update the matching commands and URLs below. `COMPOSE_PROJECT_NAME` selects the project and persistent volume. `O3DFM_APP_PORT` overrides the host app port of `3000`. Both ports bind to loopback. Keep `.env` and `state/` outside version control.

## 2. Initialize secrets and database

Start PostgreSQL and create a dedicated migration owner. The bootstrap superuser is used only for provisioning. See [Database migrations](DATABASE-MIGRATIONS.md) for role details.

```bash
export O3DFM_APP_ENV_FILE=/dev/null
docker compose up -d --wait postgres
migrator_password="$(openssl rand -hex 24)"
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U open3dfarm_owner -d open3dfarm <<SQL
CREATE ROLE o3dfm_migrator LOGIN PASSWORD '${migrator_password}' NOSUPERUSER CREATEROLE;
ALTER ROLE o3dfm_migrator SET createrole_self_grant 'set, inherit';
GRANT CREATE ON DATABASE open3dfarm TO o3dfm_migrator;
GRANT CREATE ON SCHEMA public TO o3dfm_migrator;
SQL
export NUXT_DATABASE_DATABASE_URL="postgres://o3dfm_migrator:${migrator_password}@postgres:5432/open3dfarm"
docker compose run -d --name openfarm-migrate --no-deps \
  -e NUXT_DATABASE_MIGRATIONS=apply -e NUXT_DATABASE_DATABASE_URL app
```

Wait for this check to succeed before proceeding. If it keeps failing, inspect `docker logs openfarm-migrate` privately and resolve the migration error.

```bash
docker exec openfarm-migrate node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1))"
```

Remove the temporary migration container. Store the migration password securely for upgrades. Enter the bootstrap URL privately when prompted, using the password from `.env` in `postgres://open3dfarm_owner:PASSWORD@127.0.0.1:5433/open3dfarm`. Substitute your canonical public HTTPS origin below.

```bash
docker rm -f openfarm-migrate
unset NUXT_DATABASE_DATABASE_URL migrator_password O3DFM_APP_ENV_FILE
read -rsp 'Bootstrap database URL: ' OPENFARM_INIT_DATABASE_URL
printf '\n'
OPENFARM_INIT_DATABASE_URL="$OPENFARM_INIT_DATABASE_URL" \
  node "$repo/scripts/self-host/init.ts" "$PWD/state" https://farm.example.org --compose
unset OPENFARM_INIT_DATABASE_URL
docker compose up -d --wait app
```

Leave `state/` absent until the initializer creates it. The initializer provisions restricted runtime logins and writes `state/app.env` and signing keys with mode `0600`. Compose reads that environment file directly. The generated runtime URLs use `postgres:5432` on the Compose network, and application startup verifies the migrations. Back up the deployment files securely. Keep database URLs, bootstrap tokens, session secrets and signing keys out of logs and support requests.

## 3. Configure reverse proxy

Point the DNS A/AAAA record to the VM. Configure the proxy with a valid TLS certificate and redirect HTTP to HTTPS. Proxy requests to `http://127.0.0.1:3000`, preserve the `Host` header and forward `X-Forwarded-Proto: https`. Support HTTP/1.1 WebSocket upgrades (`Upgrade` and `Connection` headers), disable proxy buffering for upgraded connections, and allow long-lived WebSocket connections. Keep the app port and `/readyz` private. Set `NUXT_AUTH_ORIGIN` to the exact public origin, for example `https://farm.example.org`, with no trailing slash; it must match the proxy URL and TLS scheme.

## 4. Bootstrap the owner

Open the public HTTPS origin and follow the first-owner bootstrap page using the one-time token in `NUXT_AUTH_BOOTSTRAP_TOKEN` in `state/app.env`. Choose a unique username and a password of at least 12 characters. Confirm the account can sign in and has the owner role. Bootstrap closes after the first owner is created. Store the token in a password manager and remove transient copies after use. If bootstrap was consumed incorrectly, use the documented database recovery procedure; do not reopen public registration.

## 5. Pair a simulator Connector

After confirming owner sign-in, enable pairing and inventory with the supplied Compose override. Run it as the same non-root operator who initialized `state/`. The container uses that operator's numeric UID and GID to read the existing key through a read-only file mount.

```bash
export O3DFM_OPERATOR_UID="$(id -u)" O3DFM_OPERATOR_GID="$(id -g)"
docker compose -f compose.yml -f pairing.compose.yml up -d --wait app
```

Use the same two Compose files and operator IDs for subsequent app updates while pairing is enabled. Run the Connector against a simulator and invoke its pairing command with an empty private data directory.

```bash
open3dfarmmanager-connector init-identity --data-dir ./simulator-connector
open3dfarmmanager-connector pair --server https://farm.example.org \
  --audience open3dfarmmanager:connector \
  --data-dir ./simulator-connector \
  --credential-file ./simulator-connector/credential.json
```

While signed in as owner, approve the short code in the Connector pairing screen, checking the fingerprint printed by the CLI. Confirm the identity appears as approved in the farm's Connector inventory.

## 6. Enable subsystems deliberately

The first installation needs only authentication and database access. Keep every optional subsystem disabled until its dedicated database role, migrations, key material, and operational need are ready. For each subsystem, configure its documented `NUXT_*_ENABLED` flag and dedicated database URL; never reuse the schema-owner credential. See `.env.example`, `docs/ACCOUNT-CREATION.md`, `docs/SPOOLMAN-FARM-CONFIG.md`, and subsystem-specific docs for exact variables and grants. Connector pairing, telemetry, browser devices, printer assignments/states, integration APIs, pause authority, OIDC, password reset, library storage, and Bambu cloud are opt-in. Bambu cloud remains offline unless explicitly enabled and configured.

For any feature that reads a generated key or key registry, add a read-only bind mount for the required file at its configured container path. Keep each source file private and readable by the application UID.

Set telemetry and job-history retention only after enabling their maintenance configuration. Defaults are 30 days for telemetry and 365 days for job history; configure retention days and batch size according to storage and policy needs. Library retention/quota settings apply only when library storage is enabled. Back up PostgreSQL and Connector private configuration separately, test restoration, and review `docs/SELF-HOSTING-UPGRADE.md` before upgrades.

## Environment variables

The app's required first-install values are `NUXT_DATABASE_ENABLED`, `NUXT_DATABASE_DATABASE_URL`, `NUXT_DATABASE_MIGRATIONS`, `NUXT_DATABASE_MIGRATIONS_DIR`, `NUXT_AUTH_ENABLED`, `NUXT_AUTH_ORIGIN`, `NUXT_AUTH_SESSION_SECRET`, `NUXT_AUTH_BOOTSTRAP_TOKEN`, and `NUXT_AUTH_DATABASE_URL`. The initializer generates secret/key values and creates URLs; operators provide the public origin and database credentials. Every optional feature variable is documented in `.env.example`; variables absent from the environment use the defaults in `apps/farm/nuxt.config.ts`. `O3DFM_*` and `COMPOSE_PROJECT_NAME` are Compose interpolation settings, documented above and in `infra/app/docker-compose.yml`, not application settings. `NODE_ENV`, `NITRO_HOST`, and `NITRO_PORT` are image defaults.

Keep API-originated printer commands, cloud integrations, public signup, and any subsystem without its dedicated credentials disabled. Browser commands remain WebRTC-only. Automated tests must never command physical printers.
