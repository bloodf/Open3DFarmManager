import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../apps/farm/app/assets/main.css', import.meta.url), 'utf8')
const states = ['idle', 'printing', 'paused', 'error', 'offline', 'stale']
const foregrounds = ['text', 'text-muted', 'accent', ...states.map(state => `printer-${state}`)]
const surfaces = ['surface', 'surface-raised']

function luminance(hex: string) {
  const channels = [0, 2, 4].map(index => {
    const srgb = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function colour(block: string, name: string) {
  const match = block.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})\\s*;`, 'i'))
  if (!match) throw new Error(`Missing six-digit colour token --${name}`)
  return luminance(match[1])
}

const light = css.match(/^:root\s*\{([^}]+)\}/)?.[1] ?? ''
const dark = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)?.[1] ?? ''

describe.each([['light', light], ['dark', dark]])('%s design tokens', (_theme, block) => {
  it.each(foregrounds.flatMap(foreground => surfaces.map(surface => ({ foreground, surface }))))(
    '$foreground on $surface meets AA for normal text',
    ({ foreground, surface }) => {
      const a = colour(block, foreground)
      const b = colour(block, surface)
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5)
    },
  )
})

it('pairs all printer state colours with distinct icon tokens', () => {
  const icons = states.map(state => light.match(new RegExp(`--printer-${state}-icon:\\s*"([^"]+)";`))?.[1])
  expect(icons).not.toContain(undefined)
  expect(new Set(icons).size).toBe(states.length)
})
