import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import postgres from 'postgres'
import {
  disposablePostgres,
  findPostgresBin,
  getFreePort,
} from '../helpers/disposable-postgres.ts'
import { startLocalPostgres } from '../helpers/connector-outage-local-postgres.ts'

function hasPostgres(): boolean {
  try {
    findPostgresBin()
    return true
  } catch {
    return false
  }
}

async function assertPasswordRequired(port: number, password: string) {
  const unauthenticated = postgres({
    host: '127.0.0.1',
    port,
    username: 'fixture',
    database: 'fixture',
    password: '',
    ssl: false,
    connect_timeout: 3,
  })
  try {
    await assert.rejects(unauthenticated`SELECT 1`, /password|authentication/i)
  } finally {
    await unauthenticated.end({ timeout: 3 })
  }
  const authenticated = postgres({
    host: '127.0.0.1',
    port,
    username: 'fixture',
    database: 'fixture',
    password,
    ssl: false,
    connect_timeout: 3,
  })
  try {
    assert.equal((await authenticated`SELECT 1 AS value`)[0]?.value, 1)
  } finally {
    await authenticated.end({ timeout: 3 })
  }
}

test(
  'native disposable PostgreSQL refuses password-less TCP superuser access',
  { skip: !hasPostgres() },
  async () => {
    const previous = process.env.OPENFARM_PG
    delete process.env.OPENFARM_PG
    const fixture = disposablePostgres({
      name: 'auth-regression',
      isolated: true,
      through: false,
    })
    try {
      await fixture.start()
      await assertPasswordRequired(fixture.port, fixture.password)
    } finally {
      await fixture.stop()
      if (previous === undefined) delete process.env.OPENFARM_PG
      else process.env.OPENFARM_PG = previous
    }
  },
)

test(
  'outage PostgreSQL refuses password-less TCP superuser access',
  { skip: !hasPostgres() },
  async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'o3dfm-auth-'))
    let fixture: Awaited<ReturnType<typeof startLocalPostgres>> | undefined
    try {
      const port = await getFreePort()
      fixture = await startLocalPostgres({ workDir, port, ledger: () => {} })
      await assertPasswordRequired(port, fixture.password)
    } finally {
      try {
        await fixture?.stop()
      } finally {
        await rm(workDir, { recursive: true, force: true })
      }
    }
  },
)
