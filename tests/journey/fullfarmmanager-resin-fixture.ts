import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import postgres from 'postgres'

const ROLE = 'journey_resin_ledger'

// The shared harness starts PostgreSQL on a random port and does not wire
// Resin Ledger. Reserve a local address before Nitro starts, then connect it to
// this journey's cluster and provision the restricted login before navigation.
export async function startResinFixture() {
  // Keep the nested PostgreSQL socket path below the Unix path limit.
  const directory = await mkdtemp('/tmp/ofr-')
  const saved = {
    TMPDIR: process.env.TMPDIR,
    NUXT_RESIN_LEDGER_ENABLED: process.env.NUXT_RESIN_LEDGER_ENABLED,
    NUXT_RESIN_LEDGER_DATABASE_URL: process.env.NUXT_RESIN_LEDGER_DATABASE_URL,
  }
  const password = randomBytes(24).toString('hex')
  let databasePort: number | undefined
  const sockets = new Set<Socket>()
  const server = createServer((browser) => {
    if (!databasePort) {
      browser.destroy()
      return
    }
    const database = connect(databasePort, '127.0.0.1')
    for (const [socket, peer] of [
      [browser, database],
      [database, browser],
    ] as const) {
      sockets.add(socket)
      socket.on('error', () => socket.destroy())
      socket.on('close', () => {
        sockets.delete(socket)
        peer.destroy()
      })
    }
    browser.pipe(database).pipe(browser)
  })
  const close = async () => {
    for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    for (const socket of sockets) socket.destroy()
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Resin fixture proxy did not bind')
    process.env.TMPDIR = directory
    process.env.NUXT_RESIN_LEDGER_ENABLED = 'true'
    process.env.NUXT_RESIN_LEDGER_DATABASE_URL = `postgres://${ROLE}:${password}@127.0.0.1:${address.port}/fixture`
    return {
      async provision() {
        const clusters = (await readdir(directory)).filter((name) =>
          name.startsWith('o3dfm-pg-'),
        )
        if (clusters.length !== 1)
          throw new Error(
            'Expected one owned PostgreSQL fixture for Resin Ledger',
          )
        const cluster = join(directory, clusters[0]!)
        const pidFile = await readFile(
          join(cluster, 'data', 'postmaster.pid'),
          'utf8',
        )
        const port = Number(pidFile.split('\n')[3])
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error('Invalid PostgreSQL fixture port')
        const sql = postgres({
          host: '127.0.0.1',
          port,
          database: 'fixture',
          username: 'fixture',
          password: (await readFile(join(cluster, 'password'), 'utf8')).trim(),
          max: 1,
          connect_timeout: 3,
        })
        try {
          await sql.unsafe(
            `CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' IN ROLE farm_resin_ledger`,
          )
        } finally {
          await sql.end({ timeout: 3 })
        }
        databasePort = port
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
