import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import postgres, { type Sql } from 'postgres'
import { validatePrinterAssignmentRole } from '../../apps/farm/server/utils/printer-assignments/role-policy.ts'

/** Only call with a disposable migrated fixture owned by the caller. */
export async function testPrinterAssignmentRolePolicy(
  admin: Sql,
  port: number,
  ledger: string,
) {
  const prefix = `printer_policy_${randomUUID().replaceAll('-', '')}`
  const login = `${prefix}_login`
  const extra = `${prefix}_extra`
  const schema = `${prefix}_schema`
  const password = randomBytes(24).toString('hex')
  await appendFile(
    ledger,
    `Printer role-policy fixture roles: ${login}, ${extra}; schema: ${schema}\n`,
  )
  const runtime = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: login,
    password,
    max: 1,
    connect_timeout: 3,
    idle_timeout: 2,
  })
  let loginCreated = false
  let extraCreated = false
  let schemaCreated = false
  try {
    await admin.unsafe(
      `CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_printer_ownership`,
    )
    loginCreated = true
    await validatePrinterAssignmentRole(runtime)
    await admin.unsafe(`CREATE ROLE ${extra} NOLOGIN`)
    extraCreated = true
    await admin`GRANT ${admin(extra)} TO ${admin(login)}`
    await assert.rejects(validatePrinterAssignmentRole(runtime))
    await admin`REVOKE ${admin(extra)} FROM ${admin(login)}`
    await admin`GRANT ${admin(extra)} TO ${admin(login)} WITH INHERIT FALSE`
    await assert.rejects(validatePrinterAssignmentRole(runtime))
    await admin`REVOKE ${admin(extra)} FROM ${admin(login)}`
    await admin`ALTER ROLE ${admin(extra)} CREATEROLE`
    await admin`GRANT ${admin(extra)} TO ${admin(login)} WITH INHERIT FALSE`
    await assert.rejects(validatePrinterAssignmentRole(runtime))
    await admin`REVOKE ${admin(extra)} FROM ${admin(login)}`
    await admin`GRANT SELECT ON farm.password_credentials TO ${admin(login)}`
    await assert.rejects(validatePrinterAssignmentRole(runtime))
    await admin`REVOKE SELECT ON farm.password_credentials FROM ${admin(login)}`
    await admin`CREATE SCHEMA ${admin(schema)} AUTHORIZATION ${admin(login)}`
    schemaCreated = true
    await assert.rejects(validatePrinterAssignmentRole(runtime))
    await admin`DROP SCHEMA ${admin(schema)}`
    schemaCreated = false
    await validatePrinterAssignmentRole(runtime)
  } finally {
    const failed: string[] = []
    const cleanup = async (name: string, action: () => Promise<void>) => {
      try {
        await action()
      } catch {
        failed.push(name)
      }
    }
    await cleanup('runtime connection', () => runtime.end({ timeout: 3 }))
    if (schemaCreated)
      await cleanup('schema', async () => {
        await admin`DROP SCHEMA ${admin(schema)}`
      })
    if (loginCreated)
      await cleanup('login', async () => {
        await admin`DROP OWNED BY ${admin(login)}`
        await admin`DROP ROLE ${admin(login)}`
      })
    if (extraCreated)
      await cleanup('extra role', async () => {
        await admin`DROP ROLE ${admin(extra)}`
      })
    await appendFile(
      ledger,
      `Printer role-policy cleanup: ${failed.length ? 'failed: ' + failed.join(', ') : 'complete'}\n`,
    )
    if (failed.length)
      throw new Error('Role-policy cleanup incomplete; inspect task ledger')
  }
}
