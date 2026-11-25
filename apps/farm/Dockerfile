FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/farm/package.json apps/farm/package.json
COPY packages/connector/package.json packages/connector/package.json
COPY packages/farm-protocol/package.json packages/farm-protocol/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sim-tools/package.json packages/sim-tools/package.json
COPY packages/sim-cams/package.json packages/sim-cams/package.json
COPY packages/webrtc-experiment/package.json packages/webrtc-experiment/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w @open3dfarmmanager/farm

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
WORKDIR /app
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000 NUXT_DATABASE_MIGRATIONS_DIR=/app/migrations
COPY --from=build --chown=10001:10001 /app/apps/farm/.output ./
COPY --from=build --chown=10001:10001 /app/infra/db/migrations ./migrations
COPY --from=build --chown=10001:10001 /app/LICENSE /app/THIRD_PARTY.md /app/THIRD_PARTY_NOTICES.md ./
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
