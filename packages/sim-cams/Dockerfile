FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY packages/sim-cams/package.json ./
COPY packages/sim-cams/src ./src
COPY packages/sim-cams/fixtures ./fixtures
USER 10001:10001
ENV SIM_CAMERA_HOST=0.0.0.0 SIM_CAMERA_PORT=8112
EXPOSE 8112
CMD ["node", "src/cli.ts"]
