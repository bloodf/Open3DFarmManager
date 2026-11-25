// Print the affected test entry points for the check planner.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

const changed = new Set(process.argv.slice(2))
const migrationDirectory = 'infra/db/migrations'
const migrationsChanged = [...changed].some((file) =>
  file.startsWith(migrationDirectory + '/'),
)
const fixtures = [...changed].filter(
  (file) =>
    file.startsWith('tests/fixtures/') ||
    /\.(?:jsonc?|gcode[^/]*|3mf)$/i.test(file),
)
const scripts = existsSync('package.json')
  ? (JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {})
  : {}
const extraNodeTests = new Set(
  (scripts['test:node'] ?? '').match(/[^\s'"*]+\.test\.(?:ts|mts|mjs)\b/g),
)
const sourceExtension = /\.(?:ts|mts|mjs|tsx|cts|js|jsx|cjs|vue)$/
const files = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'packages/',
    'apps/',
    'scripts/',
    'tests/',
    'infra/sandbox/docs-drift.test.ts',
  ],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((file) => sourceExtension.test(file))
  .filter((file) => lstatSync(file, { throwIfNoEntry: false })?.isFile())

const knownPaths = new Set([...files, ...changed])
const importers = new Map()
const affected = new Set(changed)
const dataAffected = new Set()
const changedPackages = new Set(
  [...changed]
    .filter((file) => sourceExtension.test(file))
    .map((file) => /^packages\/([^/]+)\/src\//.exec(file)?.[1])
    .filter(Boolean)
    .map((name) => '@open3dfarmmanager/' + name),
)
if (
  [...changed].some(
    (file) =>
      file.startsWith('tests/helpers/kobralink-rtc/') &&
      sourceExtension.test(file),
  )
) {
  affected.add('tests/helpers/kobralink-rtc/cdp-body.test.ts')
}

const extensions = ['.ts', '.mts', '.mjs', '.tsx', '.js']
const imports =
  /\b(?:from\s*|import\s*(?:\(\s*)?|(?:require|new\s+URL)\s*\(\s*)(['"])([^'"\r\n]+)\1/g

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  if (
    (migrationsChanged && source.includes(migrationDirectory)) ||
    fixtures.some((fixture) => source.includes(basename(fixture)))
  ) {
    dataAffected.add(file)
  }

  for (const [, , specifier] of source.matchAll(imports)) {
    if (changedPackages.has(specifier)) affected.add(file)
    const relative = specifier.replace(/^raw:/, '').split('?')[0]
    if (!relative.startsWith('./') && !relative.startsWith('../')) continue
    const target = join(dirname(file), relative)
    const extension = extname(target)
    const candidates = [target]
    if (extension === '.js') candidates.push(target.slice(0, -3) + '.ts')
    if (extension === '.mjs') candidates.push(target.slice(0, -4) + '.mts')
    if (!extension) {
      for (const suffix of extensions) {
        candidates.push(target + suffix, join(target, 'index' + suffix))
      }
    }
    for (const dependency of candidates) {
      if (!knownPaths.has(dependency)) continue
      if (!importers.has(dependency)) importers.set(dependency, new Set())
      importers.get(dependency).add(file)
    }
  }
}

function includeImporters(selected) {
  // Set iteration also visits newly added files and terminates on import cycles.
  for (const file of selected) {
    for (const importer of importers.get(file) ?? []) selected.add(importer)
  }
}

includeImporters(dataAffected)
for (const file of dataAffected) affected.add(file)
includeImporters(affected)

for (const file of [...new Set(files)].sort()) {
  if (!affected.has(file)) continue
  if (/^tests\/node\/[^/]+\.test\.ts$/.test(file) || extraNodeTests.has(file)) {
    console.log('node:' + file)
  } else if (
    dataAffected.has(file) &&
    (/^tests\/unit\/.*\.test\.ts$/.test(file) ||
      file === 'infra/sandbox/docs-drift.test.ts')
  ) {
    console.log('vitest:' + file)
  }
}
