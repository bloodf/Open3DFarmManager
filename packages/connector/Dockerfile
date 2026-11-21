FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/farm/package.json apps/farm/package.json
COPY packages/connector/package.json packages/connector/package.json
COPY packages/farm-protocol/package.json packages/farm-protocol/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sim-tools/package.json packages/sim-tools/package.json
COPY packages/sim-cams/package.json packages/sim-cams/package.json
COPY packages/webrtc-experiment/package.json packages/webrtc-experiment/package.json
RUN npm ci --ignore-scripts && npm rebuild node-datachannel
COPY . .
RUN npm run build -w @open3dfarmmanager/connector

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/connector/dist ./dist
COPY --from=build /app/node_modules/node-datachannel ./node_modules/node-datachannel
COPY --from=build /app/node_modules/@node-datachannel ./node_modules/@node-datachannel
COPY --from=build /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build /app/node_modules/node-gyp-build ./node_modules/node-gyp-build
RUN mkdir -p /data /config && chown 1000:1000 /data /config && chmod 700 /data /config
USER 1000:1000
VOLUME ["/data", "/config"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
