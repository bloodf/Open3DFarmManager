// Node build for the Connector CLI. Replaces the former Bun bundler with the
// esbuild API: ESM output, platform node, code splitting and the same external
// native boundary. esbuild carries the entry hashbang over to dist/cli.js.
import { copyFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const outputDirectory = join(packageDirectory, 'dist')
// Dependencies resolve through npm workspace module resolution from this package.
const packageRequire = createRequire(join(packageDirectory, 'package.json'))
const licenseOf = (name) =>
  join(dirname(packageRequire.resolve(`${name}/package.json`)), 'LICENSE')

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
  target: 'node22',
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
  [licenseOf('zod'), 'ZOD-LICENSE'],
  [licenseOf('ws'), 'WS-LICENSE'],
]
for (const [from, to] of licenseCopies) {
  copyFileSync(resolve(packageDirectory, from), join(outputDirectory, to))
}
