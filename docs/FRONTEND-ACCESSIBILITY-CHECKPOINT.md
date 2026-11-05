# Frontend accessibility and account-flow checkpoint

This checkpoint covers browser interaction with the current Portuguese home, login and logout pages. The Playwright cases use route stubs for `/api/auth/login` and `/api/auth/logout`; responses and credentials are synthetic. They exercise keyboard access, visible names, username guidance, announced and focused failures, pending-submit protection, logout outcomes, and the home page's unavailable/read-only presentation.

The browser tests do not authenticate an account. A stubbed successful response does not prove a session cookie was issued, persisted, scoped or protected, and does not verify backend password handling, CSRF protection, session revocation, or authorization. Those need endpoint and integration evidence against the real application boundary and a dedicated test database. Never use production accounts or secrets for these checks.

Connector pairing is not exposed as an available user flow. The home page communicates that pairing, printer status and cameras are unavailable, and that degraded mode will be read-only with no commands. These statements are product status copy; they are not evidence of Connector transport, printer connectivity, or enforcement by a live Connector.

No accessibility scanner or additional dependency is introduced. This is focused interaction coverage, not a complete WCAG audit or assistive-technology certification. The tests do not contact physical printers or send commands.

## Local validation on 2026-11-04

Against commits `db76a31` and `5631566` plus the subsequent test adjustments, Chromium ran against a Nuxt dev server bound to `127.0.0.1:3217`, with farm view disabled. The temporary Playwright config used that base URL, Chromium and one worker. The command `bunx --no-install playwright test --config .playwright-accessibility-local.config.ts tests/e2e/auth-pages.spec.ts tests/e2e/frontend-accessibility.spec.ts tests/e2e/skeleton.spec.ts --workers=1` passed 9 tests. `bun run --cwd apps/farm typecheck` passed. The browser intercepted login and logout HTTP requests with synthetic responses; it did not validate real backend authentication.

The first browser run was interrupted after an unhydrated form submission navigated to a stub response. After waiting for Vue to mount, a complete run passed 8 of 9 cases; the remaining status locator also matched Nuxt's dev indicator. Scoping that assertion to the form produced the 9-test passing run. These checks do not replace `bun run check:all` or backend integration checks before publication.

Installed package metadata reports Nuxt 4.6.4, Vue 3.5.44, Vue Router 5.4.0 and vue-tsc 3.3.14 as MIT; Playwright Test 1.64.1 and TypeScript 5.9.3 as Apache-2.0; and Prettier 3.6.2 as MIT. No dependency was added. These direct package checks do not audit the full transitive license or distribution notice inventory.
