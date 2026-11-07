FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/farm/package.json apps/farm/package.json
COPY packages/connector/package.json packages/connector/package.json
COPY packages/farm-protocol/package.json packages/farm-protocol/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sim-tools/package.json packages/sim-tools/package.json
COPY packages/sim-cams/package.json packages/sim-cams/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run --cwd apps/farm build

FROM node:24.22.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000
COPY --from=build --chown=10001:10001 /app/apps/farm/.output ./
COPY --from=build --chown=10001:10001 /app/LICENSE /app/THIRD_PARTY.md ./
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
