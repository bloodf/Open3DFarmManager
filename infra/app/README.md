# Application Compose

Provide an immutable application image in `O3DFM_APP_IMAGE` and the PostgreSQL bootstrap password in `O3DFM_DB_PASSWORD`. Create `app.env` in this directory with `NUXT_DATABASE_DATABASE_URL` pointing to the dedicated database at host `postgres`. Keep this file private. Follow `docs/DATABASE-MIGRATIONS.md` to provision the migration and application roles; do not use the bootstrap superuser as the application login.

Run `docker compose -f infra/app/docker-compose.yml up -d`. The app applies migrations at startup and listens on `127.0.0.1:3000` by default. Configure an operator-managed reverse proxy for external access and TLS. Change the host port with `O3DFM_APP_PORT`. Check readiness at `http://127.0.0.1:3000/readyz`.
