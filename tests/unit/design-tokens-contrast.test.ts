import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { findHexOutsideTokens } from '../../scripts/check-design-token-hex.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const TOKENS = join(ROOT, 'apps/farm/app/assets/tokens/tokens.css')

const TEXT_PAIRS = [
  ['--color-text', '--color-surface'],
  ['--color-text-muted', '--color-surface'],
  ['--color-accent', '--color-surface'],
  ['--color-on-accent', '--color-accent'],
] as const

const STATE_COLORS = [
  '--state-idle-color',
  '--state-printing-color',
  '--state-paused-color',
  '--state-error-color',
  '--state-offline-color',
  '--state-stale-color',
] as const

const STATE_ICONS = [
  ['--state-idle-icon', 'idle'],
  ['--state-printing-icon', 'printing'],
  ['--state-paused-icon', 'paused'],
  ['--state-error-icon', 'error'],
  ['--state-offline-icon', 'offline'],
  ['--state-stale-icon', 'stale'],
] as const

/** WCAG 2.x relative luminance for an sRGB hex colour. */
function relativeLuminance(hex: string): number {
  const raw = hex.replace('#', '')
  const full =
    raw.length === 3 || raw.length === 4
      ? [...raw].map((c) => c + c).join('')
      : raw
  const channels = [0, 2, 4].map((i) => {
    const value = Number.parseInt(full.slice(i, i + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    map.set(match[1]!, match[2]!.trim())
  }
  return map
}

function extractBlock(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css)
  if (!match || match.index === undefined) {
    throw new Error(`Missing block for ${selectorPattern}`)
  }
  const start = css.indexOf('{', match.index)
  if (start < 0) throw new Error(`Missing '{' for ${selectorPattern}`)
  let depth = 0
  for (let i = start; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return css.slice(start + 1, i)
    }
  }
  throw new Error(`Unclosed block for ${selectorPattern}`)
}

function requireHex(map: Map<string, string>, name: string): string {
  const value = map.get(name)
  if (!value) throw new Error(`Missing token ${name}`)
  const hex = value.match(
    /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
  )
  if (!hex) throw new Error(`Token ${name} is not a hex colour: ${value}`)
  return hex[0]!
}

async function loadThemes() {
  const css = stripComments(await readFile(TOKENS, 'utf8'))
  const light = parseDeclarations(
    extractBlock(css, /:root\s*,\s*\[data-theme=['"]light['"]\]/),
  )
  const dark = parseDeclarations(
    extractBlock(css, /\[data-theme=['"]dark['"]\]/),
  )
  return { light, dark }
}

test('light and dark text/accent token pairs meet WCAG AA (4.5:1)', async () => {
  const { light, dark } = await loadThemes()
  for (const theme of [light, dark]) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrastRatio(requireHex(theme, fg), requireHex(theme, bg))
      expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})

test('printer-state colours meet WCAG AA for non-text UI (3:1) on surface', async () => {
  const { light, dark } = await loadThemes()
  for (const theme of [light, dark]) {
    const surface = requireHex(theme, '--color-surface')
    for (const name of STATE_COLORS) {
      const ratio = contrastRatio(requireHex(theme, name), surface)
      expect(ratio, `${name} on --color-surface`).toBeGreaterThanOrEqual(3)
    }
  }
})

test('each printer-state colour is paired with a stable icon name', async () => {
  const { light } = await loadThemes()
  for (const [token, expected] of STATE_ICONS) {
    const value = light.get(token)
    expect(value, token).toBeDefined()
    expect(value!.replace(/['"]/g, '')).toBe(expected)
  }
})

test('hex colours appear only in the design-token file (lint)', async () => {
  const offenders = await findHexOutsideTokens()
  expect(offenders).toEqual([])
})

test('spacing, radius, type, elevation and focus tokens are defined', async () => {
  const { light } = await loadThemes()
  for (const name of [
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-5',
    '--space-6',
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--font-sans',
    '--font-size-sm',
    '--font-size-base',
    '--font-size-lg',
    '--font-size-xl',
    '--font-size-2xl',
    '--line-height-tight',
    '--line-height-normal',
    '--elevation-1',
    '--elevation-2',
    '--focus-ring-width',
    '--focus-ring-offset',
    '--color-focus-ring',
  ]) {
    expect(light.get(name), name).toBeTruthy()
  }
})
