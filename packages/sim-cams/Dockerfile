FROM node:24.22.2-alpine
WORKDIR /app
COPY packages/sim-cams/package.json ./
COPY packages/sim-cams/src ./src
COPY packages/sim-cams/fixtures ./fixtures
USER 10001:10001
ENV SIM_CAMERA_HOST=0.0.0.0 SIM_CAMERA_PORT=8112
EXPOSE 8112
CMD ["node", "src/cli.ts"]
