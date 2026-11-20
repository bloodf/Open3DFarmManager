FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
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

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
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
