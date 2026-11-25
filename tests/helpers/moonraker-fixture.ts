import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const MOONRAKER_FIXTURES = new URL(
  '../fixtures/moonraker/',
  import.meta.url,
)

export function moonrakerFixtureText(name: string): string {
  return readFileSync(new URL(name, MOONRAKER_FIXTURES), 'utf8')
}

/** A JSONC fixture opens with a `//` comment saying it was not captured. */
export function moonrakerFixture(name: string): any {
  const text = moonrakerFixtureText(name)
  assert.match(text, /^\/\/ (spec-derived|reference-derived), not captured/)
  return JSON.parse(
    text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
  )
}
