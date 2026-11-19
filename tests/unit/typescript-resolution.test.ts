import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

// npm hoists one `typescript`: the legacy JavaScript compiler API that
// vue-tsc and Volar need. TypeScript 7 is installed beside it as `typescript7`
// and drives the root `tsc --noEmit` through its own launcher.
const rootRequire = createRequire(
  new URL('../../package.json', import.meta.url),
)
const farmRequire = createRequire(
  new URL('../../apps/farm/package.json', import.meta.url),
)

test('root keeps TypeScript 7 for tsc, separate from the legacy compiler entry', () => {
  expect(rootRequire('typescript7/package.json').version).toBe('7.0.2')
  expect(() => rootRequire.resolve('typescript7/lib/tsc')).toThrow(
    expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
  )
})

test('vue-tsc resolves the legacy compiler through its actual peer context', () => {
  const vueRequire = createRequire(farmRequire.resolve('vue-tsc'))
  expect(farmRequire('typescript/package.json').version).toBe('6.0.3')
  expect(vueRequire('typescript/package.json').version).toBe('6.0.3')
  expect(vueRequire.resolve('typescript/lib/tsc')).toBe(
    farmRequire.resolve('typescript/lib/tsc'),
  )
})

test('Volar resolves the same legacy compiler API used by vue-tsc', () => {
  const vueRequire = createRequire(farmRequire.resolve('vue-tsc'))
  const volarRequire = createRequire(
    vueRequire.resolve('@volar/typescript/lib/quickstart/runTsc'),
  )
  expect(volarRequire.resolve('typescript')).toBe(
    farmRequire.resolve('typescript'),
  )
  expect(typeof volarRequire('typescript').createProgram).toBe('function')
})
