import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // These two stay on node:test (retained Node-native tests) and run under
    // the node --test suite; Vitest must not discover them here.
    exclude: [
      'tests/unit/pause-authority-tooling.test.ts',
      'tests/unit/pause-authority-timeout.test.ts',
    ],
    environment: 'node',
    isolate: true,
    maxWorkers: 2,
  },
})
