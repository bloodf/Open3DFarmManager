# Library and Connector test checkpoint

On 2026-11-20, focused tests ran against integration commit
`4afe6b5c6a0fdc2ba196bb72e04a4786d1c31156` and main commit
`10cc2a550e5d2db4d00ac13294dab72476375241`. The four reported library
upload failures and the Connector configuration timeout did not reproduce in
these runs. The original gate's individual failure output was not available,
so these results do not establish the cause of that gate's failures.

The runs used existing dependencies and Node 22.22.1, below the repository's
Node 22 minimum of 22.22.3. The distribution's Node binary lacks built-in
TypeScript support. Vitest transformed its own tests. For the Node test, a
temporary ESM loader used the existing `esbuild` dependency to transform `.ts`
files, including files loaded by child processes. This differs
from the normal Node test runner and limits the comparison with the gate.

| Command                                                                                                                                                            | Integration                  | Main               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------ |
| `node node_modules/vitest/vitest.mjs run tests/unit/library-routes.test.ts tests/unit/library-connector-wiring.test.ts tests/unit/configuration-connector.test.ts` | 63 passed                    | 63 passed          |
| `node node_modules/vitest/vitest.mjs run tests/unit/api-v1-contract.test.ts`                                                                                       | Included in 550 passed below | 422 passed         |
| `node node_modules/vitest/vitest.mjs run tests/unit/api-v1-contract.test.ts tests/unit/api-v1-library-replay.test.ts`                                              | 550 passed                   | Replay test absent |
| `node --test --test-timeout=120000 --test-force-exit tests/node/configuration-connector.test.ts` with the temporary loader in `NODE_OPTIONS`                       | 3 passed                     | 3 passed           |

The issue's proposed evidence command names
`tests/unit/integration-library-contract.test.ts`, which is absent from both
commits. The integration API contract and replay tests above are the available
related tests. The four focused test files shared by both commits have no diff
between those commits. The Node configuration test uses a synthetic loopback
peer and mock services. No physical printer commands were sent.
