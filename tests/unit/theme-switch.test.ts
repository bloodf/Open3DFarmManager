import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { themeScript } from '../../apps/farm/app/utils/pre-hydration'

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
