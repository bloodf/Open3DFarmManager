import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../apps/farm/app/utils/pre-hydration.ts', import.meta.url),
  'utf8',
)
const themeScript = source.match(/export const themeScript = `([\s\S]*?)`/)?.[1]
if (!themeScript) throw new Error('Theme script not found')

describe('pre-hydration theme', () => {
  it.each([
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['system', true, 'dark'],
    [null, false, 'light'],
  ])('resolves %s with system dark=%s', (stored, systemDark, expected) => {
    const document = { documentElement: { dataset: { theme: '' } } }
    runInNewContext(themeScript, {
      document,
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: systemDark }),
    })
    expect(document.documentElement.dataset.theme).toBe(expected)
  })
})
