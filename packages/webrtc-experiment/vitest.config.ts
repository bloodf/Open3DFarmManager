import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['session.test.ts', 'transport.test.ts'],
    environment: 'node',
    isolate: true,
    maxWorkers: 2,
  },
})
