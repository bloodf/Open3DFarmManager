import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  migrateConfig,
  readVersionedRuntimeConfig,
} from '../../packages/connector/src/config/version.ts'

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/config-versions',
)
const bindingsDir = join(fixturesRoot, 'bindings')
const credentialsDir = join(fixturesRoot, 'credentials')

const BINDING_TYPES = [
  'moonraker-origin',
  'moonraker-api-key',
  'moonraker-login',
  'kobralink',
  'bambu',
  'creality',
  'anycubic',
] as const

type BindingType = (typeof BINDING_TYPES)[number]

const CREDENTIAL_PATH_KEYS = [
  'apiKeyFile',
  'credentialFile',
  'passwordFile',
] as const

const SECRET_MARKERS: Partial<Record<BindingType, readonly string[]>> = {
  'moonraker-api-key': ['SECRET_MARKER_MOONRAKER_API_KEY_NEVER_INLINE'],
  'moonraker-login': ['SECRET_MARKER_MOONRAKER_LOGIN_NEVER_INLINE'],
  kobralink: ['SECRET_MARKER_KOBRALINK_NEVER_INLINE'],
  bambu: ['SECRET_MARKER_BAMBU_NEVER_INLINE'],
  anycubic: ['SECRET_MARKER_ANYCUBIC_NEVER_INLINE'],
}

const CREDENTIAL_FIXTURES: Partial<Record<BindingType, string>> = {
  'moonraker-api-key': 'moonraker-api-key.json',
  'moonraker-login': 'moonraker-login.json',
  kobralink: 'kobralink.json',
  bambu: 'bambu.json',
  anycubic: 'anycubic-password.json',
}

function loadBinding(name: BindingType, edition: 'v1' | 'current') {
  return JSON.parse(
    readFileSync(join(bindingsDir, `${name}.${edition}.json`), 'utf8'),
  ) as Record<string, unknown>
}

function collectCredentialPaths(
  value: unknown,
  found: string[] = [],
): string[] {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const entry of value) collectCredentialPaths(entry, found)
    return found
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      (CREDENTIAL_PATH_KEYS as readonly string[]).includes(key) &&
      typeof entry === 'string'
    )
      found.push(entry)
    else collectCredentialPaths(entry, found)
  }
  return found
}

function assertBindingPreserved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  assert.deepEqual(after.collection, before.collection)
  assert.equal(after.version, before.version)
  for (const key of Object.keys(before)) {
    if (key === 'schemaVersion') continue
    assert.deepEqual(after[key], before[key])
  }
}

test('fixture catalog covers every binding type at v1 and current', () => {
  const names = readdirSync(bindingsDir).sort()
  for (const binding of BINDING_TYPES) {
    assert.ok(
      names.includes(`${binding}.v1.json`),
      `missing v1 fixture for ${binding}`,
    )
    assert.ok(
      names.includes(`${binding}.current.json`),
      `missing current fixture for ${binding}`,
    )
  }
  assert.equal(CURRENT_CONFIG_SCHEMA_VERSION, 2)
})

test('one fixture per binding type round-trips read, migrate and write unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-config-version-'))
  try {
    for (const binding of BINDING_TYPES) {
      const v1 = loadBinding(binding, 'v1')
      const current = loadBinding(binding, 'current')
      assert.equal(current.schemaVersion, CURRENT_CONFIG_SCHEMA_VERSION)
      assert.equal('schemaVersion' in v1, false)

      const migrated = migrateConfig(structuredClone(v1))
      assert.deepEqual(migrated, current)
      assertBindingPreserved(v1, migrated)
      assert.deepEqual(v1, loadBinding(binding, 'v1'))

      const currentMigrated = migrateConfig(structuredClone(current))
      assert.deepEqual(currentMigrated, current)
      assertBindingPreserved(current, currentMigrated)

      const v1Path = join(dir, `${binding}.v1.json`)
      const currentPath = join(dir, `${binding}.current.json`)
      const v1Bytes = `${JSON.stringify(v1, null, 2)}\n`
      const currentBytes = `${JSON.stringify(current, null, 2)}\n`
      writeFileSync(v1Path, v1Bytes, { mode: 0o600 })
      writeFileSync(currentPath, currentBytes, { mode: 0o600 })

      const v1Runtime = readVersionedRuntimeConfig(v1Path)
      const { schemaVersion: _dropped, ...expectedRuntime } = current
      assert.deepEqual(v1Runtime, expectedRuntime)
      assert.deepEqual(JSON.parse(readFileSync(v1Path, 'utf8')), current)
      assert.equal(readFileSync(`${v1Path}.bak`, 'utf8'), v1Bytes)

      const currentRuntime = readVersionedRuntimeConfig(currentPath)
      assert.deepEqual(currentRuntime, expectedRuntime)
      assert.equal(readFileSync(currentPath, 'utf8'), currentBytes)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('credential file references survive migration and are never inlined', () => {
  for (const binding of BINDING_TYPES) {
    const credentialName = CREDENTIAL_FIXTURES[binding]
    const markers = SECRET_MARKERS[binding] ?? []
    if (credentialName) {
      assert.ok(
        readdirSync(credentialsDir).includes(credentialName),
        `missing credential fixture ${credentialName}`,
      )
      const credentialText = readFileSync(
        join(credentialsDir, credentialName),
        'utf8',
      )
      for (const marker of markers)
        assert.match(credentialText, new RegExp(marker))
    }

    for (const edition of ['v1', 'current'] as const) {
      const input = loadBinding(binding, edition)
      const beforePaths = collectCredentialPaths(input).sort()
      const migrated = migrateConfig(structuredClone(input))
      const afterPaths = collectCredentialPaths(migrated).sort()
      assert.deepEqual(afterPaths, beforePaths)

      const serialized = JSON.stringify(migrated)
      for (const path of beforePaths) {
        assert.ok(serialized.includes(JSON.stringify(path)))
        assert.match(path, /^\/run\/open3dfarmmanager\/private\/credentials\//)
      }
      for (const marker of markers) {
        assert.equal(
          serialized.includes(marker),
          false,
          `${binding} inlined ${marker}`,
        )
      }
      if (credentialName) {
        const credential = JSON.parse(
          readFileSync(join(credentialsDir, credentialName), 'utf8'),
        )
        if (credential && typeof credential === 'object') {
          for (const value of Object.values(credential)) {
            if (typeof value === 'string' && value.startsWith('SECRET_MARKER_'))
              assert.equal(serialized.includes(value), false)
          }
        } else if (
          typeof credential === 'string' &&
          credential.startsWith('SECRET_MARKER_')
        )
          assert.equal(serialized.includes(credential), false)
      }
    }
  }
})
