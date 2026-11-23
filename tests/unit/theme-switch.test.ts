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
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'dark'],
    [null, 'dark'],
  ])('resolves saved choice %s to %s before hydration', (stored, expected) => {
    const classes = new Set<string>()
    const root = {
      dataset: { theme: '' },
      style: { colorScheme: '' },
      classList: {
        toggle: (name: string, enabled: boolean) =>
          enabled ? classes.add(name) : classes.delete(name),
      },
    }
    const meta = { content: '' }
    runInNewContext(themeScript, {
      document: { documentElement: root, querySelector: () => meta },
      localStorage: { getItem: () => stored },
      getComputedStyle: () => ({ getPropertyValue: () => ' rgb(1, 2, 3) ' }),
    })
    expect(root.dataset.theme).toBe(expected)
    expect(root.style.colorScheme).toBe(expected)
    expect(classes.has('dark')).toBe(expected === 'dark')
    expect(meta.content).toBe('rgb(1, 2, 3)')
  })
})

it('defaults to dark even when storage is blocked', () => {
  const added: string[] = []
  const root = {
    dataset: { theme: '' },
    style: { colorScheme: '' },
    classList: { add: (name: string) => added.push(name) },
  }
  runInNewContext(themeScript, {
    document: { documentElement: root },
    localStorage: {
      getItem: () => {
        throw new Error('blocked')
      },
    },
  })
  expect(root.dataset.theme).toBe('dark')
  expect(root.style.colorScheme).toBe('dark')
  expect(added).toEqual(['dark'])
})
