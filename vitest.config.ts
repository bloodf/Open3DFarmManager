import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Mirrors Nitro's `raw:` import (the file's text as the default export) so
 * server routes that bundle a file at build time load under Vitest unchanged.
 */
const rawImports: Plugin = {
  name: 'nitro-raw-imports',
  enforce: 'pre',
  resolveId(id, importer) {
    if (!id.startsWith('raw:') || !importer) return
    return `\0raw:${resolve(dirname(importer), id.slice(4))}`
  },
  async load(id) {
    if (!id.startsWith('\0raw:')) return
    const source = await readFile(id.slice(5), 'utf8')
    return `export default ${JSON.stringify(source)}`
  },
}

export default defineConfig({
  plugins: [rawImports],
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
