// Node build for the Connector CLI. Replaces the former Bun bundler with the
// esbuild API: ESM output, platform node, code splitting and the same external
// native boundary. esbuild carries the entry hashbang over to dist/cli.js.
import { copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const outputDirectory = join(packageDirectory, 'dist')

// node-datachannel is a native addon and must stay a runtime import.
const external = ['node-datachannel']

// The bundle is ESM, where `require` does not exist. The bundled `ws` keeps an
// optional `require('bufferutil')` inside a try/catch, so the bundle needs a
// real Node require to keep that boundary honest.
const banner = {
  js: `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
`,
}

// A split build leaves orphaned chunks behind. The notices are regenerated
// below, so dist/ holds nothing but this build's output.
rmSync(outputDirectory, { recursive: true, force: true })

await esbuild.build({
  absWorkingDir: packageDirectory,
  entryPoints: ['src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  splitting: true,
  external,
  banner,
  legalComments: 'external',
  logLevel: 'info',
})

// Required notices must travel next to the bundled JavaScript.
const licenseCopies = [
  ['../../LICENSE', 'LICENSE'],
  ['../../THIRD_PARTY.md', 'THIRD_PARTY.md'],
  ['node_modules/zod/LICENSE', 'ZOD-LICENSE'],
  ['node_modules/ws/LICENSE', 'WS-LICENSE'],
]
for (const [from, to] of licenseCopies) {
  copyFileSync(join(packageDirectory, from), join(outputDirectory, to))
}
