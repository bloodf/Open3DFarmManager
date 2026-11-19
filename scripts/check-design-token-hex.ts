#!/usr/bin/env node
/**
 * Lint: hex colours may appear only in the design-token file.
 * Scans apps/farm/app/assets/** for #RGB / #RRGGBB / #RRGGBBAA.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ASSETS = join(ROOT, 'apps/farm/app/assets')
const TOKEN_FILE = join(ASSETS, 'tokens/tokens.css')
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g

async function cssFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await cssFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(path)
  }
  return out
}

export async function findHexOutsideTokens(
  assetsDir = ASSETS,
  tokenFile = TOKEN_FILE,
): Promise<string[]> {
  const allowed = resolve(tokenFile)
  const offenders: string[] = []
  for (const file of await cssFiles(assetsDir)) {
    if (resolve(file) === allowed) continue
    const source = await readFile(file, 'utf8')
    HEX.lastIndex = 0
    if (HEX.test(source)) {
      offenders.push(relative(ROOT, file))
    }
  }
  return offenders
}

async function main() {
  const offenders = await findHexOutsideTokens()
  if (offenders.length > 0) {
    console.error(
      'Hex colours must live only in apps/farm/app/assets/tokens/tokens.css:',
    )
    for (const file of offenders) console.error(`  ${file}`)
    process.exitCode = 1
    return
  }
  console.log('OK: no hex colours outside the design-token file')
}

const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
