import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  constants,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readPrivateJsonFile } from './local.ts'

export const CURRENT_CONFIG_SCHEMA_VERSION = 2

export function migrateConfig(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid Connector configuration')
  const config = { ...input }
  const version = 'schemaVersion' in config ? config.schemaVersion : 1
  if (
    !Number.isSafeInteger(version) ||
    typeof version !== 'number' ||
    version < 1
  )
    throw Error('Invalid Connector configuration schema version')
  if (version > CURRENT_CONFIG_SCHEMA_VERSION)
    throw Error(
      `Connector configuration schema version ${version} is newer than supported version ${CURRENT_CONFIG_SCHEMA_VERSION}`,
    )
  return { ...config, schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION }
}

export function readVersionedRuntimeConfig(
  path: string,
  persist = true,
): unknown {
  const original = readPrivateJsonFile(path, { maxBytes: 64 * 1024 })
  const migrated = migrateConfig(original)
  if (
    persist &&
    (!original ||
      typeof original !== 'object' ||
      !('schemaVersion' in original) ||
      original.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION)
  ) {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(migrated, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      try {
        copyFileSync(path, `${path}.bak`, constants.COPYFILE_EXCL)
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          throw error
        copyFileSync(
          path,
          `${path}.${randomUUID()}.bak`,
          constants.COPYFILE_EXCL,
        )
      }
      renameSync(temp, path)
    } finally {
      try {
        unlinkSync(temp)
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error
      }
    }
  }
  const { schemaVersion: _schemaVersion, ...runtime } = migrated
  return runtime
}
