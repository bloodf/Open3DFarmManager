// Synthetic PostgreSQL only. Caller owns the disposable loopback database, its
// migrations (the full catalog) and its teardown. Runs the cross-farm HTTP
// scenario (issue #222) against the real stores, one login per capability role.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  CROSS_FARM_ROLES,
  testPostgresCrossFarmHttp,
  type CrossFarmPools,
} from '../tests/helpers/postgres-cross-farm-http-integration.ts'

const portText = process.env.CROSS_FARM_HTTP_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.CROSS_FARM_HTTP_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  ssl: false as const,
  max: 4,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const suffix = randomUUID().replaceAll('-', '')
const logins = Object.fromEntries(
  Object.keys(CROSS_FARM_ROLES).map((key) => [key, `xfarm_${key}_${suffix}`]),
) as Record<keyof typeof CROSS_FARM_ROLES, string>
const pools: Partial<CrossFarmPools> = {}
const created: string[] = []
let checks: string[] = []
try {
  assert.equal((await admin`SELECT current_user AS actor`)[0]?.actor, 'fixture')
  for (const [key, group] of Object.entries(CROSS_FARM_ROLES)) {
    const login = logins[key as keyof typeof CROSS_FARM_ROLES]
    await admin`CREATE ROLE ${admin(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(group)}`
    created.push(login)
    pools[key as keyof typeof CROSS_FARM_ROLES] = postgres({
      ...options,
      username: login,
    })
  }
  checks = await testPostgresCrossFarmHttp(admin, pools as CrossFarmPools)
} finally {
  for (const pool of Object.values(pools)) await pool?.end({ timeout: 3 })
  try {
    for (const login of created) await admin`DROP ROLE ${admin(login)}`
  } finally {
    await admin.end({ timeout: 3 })
  }
}
console.log(JSON.stringify({ result: 'passed', checks }))
