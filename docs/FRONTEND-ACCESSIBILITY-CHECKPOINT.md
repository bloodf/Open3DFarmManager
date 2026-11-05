# Frontend accessibility and account-flow checkpoint

This checkpoint covers browser interaction with the current Portuguese home, login and logout pages. The Playwright cases use route stubs for `/api/auth/login` and `/api/auth/logout`; responses and credentials are synthetic. They exercise keyboard access, visible names, username guidance, announced and focused failures, pending-submit protection, logout outcomes, and the home page's unavailable/read-only presentation.

The browser tests do not authenticate an account. A stubbed successful response does not prove a session cookie was issued, persisted, scoped or protected, and does not verify backend password handling, CSRF protection, session revocation, or authorization. Those need endpoint and integration evidence against the real application boundary and a dedicated test database. Never use production accounts or secrets for these checks.

Connector pairing is not exposed as an available user flow. The home page communicates that pairing, printer status and cameras are unavailable, and that degraded mode will be read-only with no commands. These statements are product status copy; they are not evidence of Connector transport, printer connectivity, or enforcement by a live Connector.

No accessibility scanner or additional dependency is introduced. This is focused interaction coverage, not a complete WCAG audit or assistive-technology certification. The tests do not contact physical printers or send commands.
