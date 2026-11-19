import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const app = fileURLToPath(new URL('../', import.meta.url))
const tokenFile = fileURLToPath(new URL('./main.css', import.meta.url))
const targets = process.argv.slice(2)

function check(path) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) check(join(path, entry))
    return
  }

  if (!/\.(css|vue)$/.test(path)) return
  const source = readFileSync(path, 'utf8')
  const styles = path.endsWith('.css')
    ? [source]
    : Array.from(source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g), match => match[1])
  for (const style of styles) {
    const css = style.replace(/\/\*[\s\S]*?\*\//g, '')
    const declarations = css.matchAll(/(?<=[;{])\s*([\w-]+)\s*:\s*([^;{}]*)/g)
    for (const [, property, value] of declarations) {
      if (path === tokenFile && property.startsWith('--')) continue
      const hex = value.match(/#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])/gi)
      if (hex) {
        console.error(`${path}: ${property} uses ${hex.join(', ')}`)
        process.exitCode = 1
      }
    }
  }
}

for (const target of targets.length ? targets : [app]) check(resolve(target))
