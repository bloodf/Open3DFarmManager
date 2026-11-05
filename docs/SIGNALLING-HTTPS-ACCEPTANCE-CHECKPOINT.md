# Signalling HTTPS acceptance fixture

The opt-in fixture prepares a separate Nuxt layer, seals the source and complete generated output manifest, and requires an explicitly disposable database with the official 17-migration journal. It runs the generated Node listener behind a synthetic loopback TLS forwarder. The fixture's process receipts wait for output streams to close, retain bounded redacted diagnostics, and report success only after cleanup and manifest revalidation.

Focused synthetic tests cover loopback TLS upgrade forwarding, including the original request target and duplicate headers, and process output drainage after parent exit, failure and timeout. These tests do not establish application acceptance.

The enabled built application, real PostgreSQL roles, HTTPS/WSS admission and Chromium flow have not yet been run with this fixture. Real client WebRTC transport remains a separate pending gate. The default application configuration remains disabled; the fixture does not provide printer commands or a server fallback.
