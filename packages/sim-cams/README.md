# Synthetic camera

`node src/cli.ts` starts a local JPEG/MJPEG source. Snapshot: `http://127.0.0.1:8112/?action=snapshot`; stream: `?action=stream`. The server emits the committed synthetic test pattern at two frames per second, supports at most five streams, and closes slow consumers. It reads no camera devices or network sources.

The test image was generated locally with FFmpeg's `testsrc2`, size 320×180. It is an original test fixture. `SIM_CAMERA_HOST` defaults to loopback; the isolated Docker service sets it to `0.0.0.0` inside its own container while publishing a loopback port only.

This source is for testing the Connector's future camera ingestion. It is not a server-mediated live fallback for the product.
