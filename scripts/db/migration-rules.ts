/**
 * Migration upgrade safety rules and validation.
 *
 * Rules:
 * 1. Every NNNN_x.up.sql has a matching down.sql and vice-versa.
 * 2. Numbering is contiguous starting from 0001.
 * 3. Up files numbered above 0027 contain no DROP TABLE, DROP COLUMN, TRUNCATE,
 *    ALTER COLUMN ... TYPE, or DELETE without WHERE, unless listed in
 *    EXPAND_CONTRACT_ALLOWLIST with a reason.
 * 4. Checksum mismatches provide clear diagnostic guidance to restore the released file.
 */

export interface MigrationSource {
  name: string
  sql: string
}

export interface AllowlistEntry {
  id: string
  rule: string
  reason: string
}

/**
 * Allowlist for approved expand/contract exceptions above migration 0027.
 * Each entry must specify the migration ID, the matching rule or pattern, and the explicit rationale.
 */
export const EXPAND_CONTRACT_ALLOWLIST: readonly AllowlistEntry[] = []

/**
 * Strips single-line comments (-- ...), multi-line comments (/* ... *\/),
 * dollar-quoted string literals ($tag$...$tag$), and standard single-quoted strings ('...').
 */
export function stripSqlCommentsAndStrings(sql: string): string {
  let result = ''
  let i = 0
  const n = sql.length

  while (i < n) {
    // Single-line comment: -- ...
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') {
        i++
      }
      result += ' '
      continue
    }

    // Multi-line comment: /* ... */
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i++
      }
      if (i < n) i += 2
      result += ' '
      continue
    }

    // Dollar-quoted string: $tag$...$tag$
    if (sql[i] === '$') {
      const match = /^\$([a-zA-Z0-9_]*)\$/.exec(sql.slice(i))
      if (match) {
        const tag = match[0]
        i += tag.length
        const closingIndex = sql.indexOf(tag, i)
        if (closingIndex !== -1) {
          i = closingIndex + tag.length
        } else {
          i = n
        }
        result += " '' "
        continue
      }
    }

    // Single-quoted string literal: '...' with '' escaping or backslash escaping
    if (sql[i] === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
          } else {
            i++
            break
          }
        } else if (sql[i] === '\\' && i + 1 < n) {
          i += 2
        } else {
          i++
        }
      }
      result += " '' "
      continue
    }

    result += sql[i]
    i++
  }

  return result
}

export type DestructiveOperation =
  | 'DROP TABLE'
  | 'DROP COLUMN'
  | 'TRUNCATE'
  | 'ALTER COLUMN ... TYPE'
  | 'DELETE without WHERE'

/**
 * Checks a stripped SQL string for destructive operations that violate expand/contract rules.
 */
export function findDestructiveOperations(
  strippedSql: string,
): DestructiveOperation[] {
  const violations = new Set<DestructiveOperation>()

  if (/\bDROP\s+TABLE\b/i.test(strippedSql)) {
    violations.add('DROP TABLE')
  }

  if (
    /\bDROP\s+COLUMN\b/i.test(strippedSql) ||
    /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+(?:COLUMN\s+)?(?!(?:CONSTRAINT|PRIMARY\s+KEY)\b)\w+/i.test(
      strippedSql,
    )
  ) {
    violations.add('DROP COLUMN')
  }

  if (
    /(?<!\b(?:BEFORE|AFTER|INSTEAD\s+OF|OR)\s+)\bTRUNCATE\b/i.test(strippedSql)
  ) {
    violations.add('TRUNCATE')
  }

  if (
    /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i.test(strippedSql) ||
    /\bALTER\s+(?:TABLE\s+)?[\w.]+\s+ALTER\s+(?:COLUMN\s+)?[\w.]+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(
      strippedSql,
    )
  ) {
    violations.add('ALTER COLUMN ... TYPE')
  }

  const statements = strippedSql.split(';')
  for (const stmt of statements) {
    if (/\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) {
      violations.add('DELETE without WHERE')
    }
  }

  return [...violations]
}

/**
 * Validates a list of migration sources against structural pairing, contiguous numbering,
 * and expand/contract safety rules.
 */
export function validateMigrationSafety(
  sources: readonly MigrationSource[],
  allowlist: readonly AllowlistEntry[] = EXPAND_CONTRACT_ALLOWLIST,
): void {
  const pairs = new Map<string, { up?: string; down?: string }>()

  for (const source of sources) {
    const match = /^(\d{4}_[a-z][a-z0-9_]*)\.(up|down)\.sql$/.exec(source.name)
    const id = match?.[1]
    const direction = match?.[2]
    if (
      !id ||
      (direction !== 'up' && direction !== 'down') ||
      !source.sql.trim()
    ) {
      throw new Error(`Invalid migration source: ${source.name}`)
    }
    const pair = pairs.get(id) ?? {}
    if (pair[direction] !== undefined) {
      throw new Error(`Duplicate migration source: ${source.name}`)
    }
    pair[direction] = source.sql
    pairs.set(id, pair)
  }

  const sortedPairs = [...pairs].sort(([a], [b]) => a.localeCompare(b))

  for (const [index, [id, pair]] of sortedPairs.entries()) {
    const expectedPrefix = String(index + 1).padStart(4, '0')
    if (id.slice(0, 4) !== expectedPrefix) {
      throw new Error(
        `Migration numbering must be contiguous starting from 0001: expected ${expectedPrefix}, found ${id}`,
      )
    }
    if (pair.up === undefined) {
      throw new Error(`Missing matching up migration for ${id}`)
    }
    if (pair.down === undefined) {
      throw new Error(`Missing matching down migration for ${id}`)
    }

    const migrationNumber = Number(id.slice(0, 4))
    if (migrationNumber > 27) {
      const stripped = stripSqlCommentsAndStrings(pair.up)
      const operations = findDestructiveOperations(stripped)
      for (const op of operations) {
        const allowed = allowlist.some(
          (entry) => entry.id === id && entry.rule === op,
        )
        if (!allowed) {
          throw new Error(
            `Migration ${id}.up.sql violates expand/contract upgrade safety: destructive operation '${op}' is prohibited in migrations above 0027`,
          )
        }
      }
    }
  }
}

/**
 * Validates that an applied migration history row matches the local catalog checksum.
 * Throws a detailed error directing the operator to restore the released file if mismatched.
 */
export function validateMigrationHistoryChecksum(
  migrationId: string,
  recordedChecksum: string,
  localChecksum: string,
): void {
  if (recordedChecksum !== localChecksum) {
    throw new Error(
      `Migration history checksum mismatch for '${migrationId}': recorded checksum ${recordedChecksum} does not match local catalog checksum ${localChecksum}. Restore the released migration file instead of editing already-applied migrations.`,
    )
  }
}
