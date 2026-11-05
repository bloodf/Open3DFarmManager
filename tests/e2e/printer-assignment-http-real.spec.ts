import { expect, test, type Page } from '@playwright/test'
import postgres, { type TransactionSql } from 'postgres'
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
import { PostgresCredentials } from '../../apps/farm/server/storage/postgres-credentials.ts'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_ATTRIBUTES,
} from '../../apps/farm/server/utils/auth/boundary.ts'

// This suite requires the explicit disposable HTTPS and PostgreSQL fixture.
const enabled = process.env.PRINTER_HTTP_TEST_DISPOSABLE === 'yes'
const origin = process.env.PRINTER_HTTP_TEST_ORIGIN
const password = process.env.PRINTER_HTTP_TEST_PASSWORD
const sessionSecret = process.env.PRINTER_HTTP_TEST_SESSION_SECRET
const farm = process.env.PRINTER_HTTP_TEST_FARM
const otherFarm = process.env.PRINTER_HTTP_TEST_OTHER_FARM
const agent = process.env.PRINTER_HTTP_TEST_AGENT
const foreignAgent = process.env.PRINTER_HTTP_TEST_FOREIGN_AGENT
const revokedAgent = process.env.PRINTER_HTTP_TEST_REVOKED_AGENT
const ownerAccount = process.env.PRINTER_HTTP_TEST_OWNER_ACCOUNT
const adminAccount = process.env.PRINTER_HTTP_TEST_ADMIN_ACCOUNT
const printerRole = process.env.PRINTER_HTTP_TEST_PRINTER_ROLE
const authRole = process.env.PRINTER_HTTP_TEST_AUTH_ROLE
const port = process.env.PRINTER_HTTP_SYNTHETIC_TEST_PORT
const usernames = {
  owner: process.env.PRINTER_HTTP_TEST_OWNER,
  admin: process.env.PRINTER_HTTP_TEST_ADMIN,
  viewer: process.env.PRINTER_HTTP_TEST_VIEWER,
  operator: process.env.PRINTER_HTTP_TEST_OPERATOR,
}

test('real login scopes registration and preserves opaque printer keys', async ({
  browser,
}) => {
  test.skip(!enabled, 'Requires an explicit disposable printer HTTP fixture')
  test.setTimeout(90_000)
  if (
    !origin ||
    !password ||
    !sessionSecret ||
    !farm ||
    !otherFarm ||
    !agent ||
    !foreignAgent ||
    !revokedAgent ||
    !ownerAccount ||
    !adminAccount ||
    !printerRole ||
    !authRole ||
    !port ||
    Object.values(usernames).some((value) => !value)
  )
    throw new Error('Missing printer HTTP fixture configuration')
  const url = new URL(origin)
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('Fixture origin must be canonical HTTPS loopback')
  const contexts = await Promise.all(
    Object.values(usernames).map(() =>
      browser.newContext({ ignoreHTTPSErrors: true }),
    ),
  )
  try {
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    )
    for (const [index, username] of Object.values(usernames).entries()) {
      const page = pages[index]!
      await page.goto(origin + '/entrar')
      await page.getByLabel('Usuário').fill(username!)
      await page.getByLabel('Senha').fill(password)
      await page.getByRole('button', { name: 'Entrar', exact: true }).click()
      await expect(page).not.toHaveURL(/\/entrar$/)
    }
    const [owner, admin, viewer, operator] = pages
    if (!owner || !admin || !viewer || !operator)
      throw new Error('Fixture browser pages unavailable')
    const path = `/api/farms/${farm}/printers`
    const post = (page: Page, target: string, body: unknown) =>
      page.evaluate(
        async ({ target, body }) => {
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          return { status: response.status, body: await response.json() }
        },
        { target, body },
      )
    const get = (page: Page, target: string) =>
      page.evaluate(async (target) => {
        const response = await fetch(target)
        return { status: response.status, body: await response.json() }
      }, target)
    const exact = ' e\u0301 Printer '
    expect(
      (await post(owner, path, { agentId: agent, printerKey: exact })).status,
    ).toBe(400)
    const registration = await post(owner, path, {
      agentId: agent,
      printerKey: exact,
      confirmedLocalConfiguration: true,
    })
    expect(registration.status).toBe(200)
    expect(registration.body.status).toBe('active')
    expect(
      (
        await post(admin, path, {
          agentId: agent,
          printerKey: 'é',
          confirmedLocalConfiguration: true,
        })
      ).status,
    ).toBe(200)
    for (const page of [viewer, operator]) {
      expect(
        (
          await post(page, path, {
            agentId: agent,
            printerKey: 'denied',
            confirmedLocalConfiguration: true,
          })
        ).status,
      ).toBe(403)
      const list = await get(page, path)
      expect(list.status).toBe(200)
      expect(list.body.canManage).toBe(false)
      expect(
        list.body.printers.some(
          (entry: { printerKey: string }) => entry.printerKey === exact,
        ),
      ).toBe(true)
      expect((await get(page, `/api/farms/${otherFarm}/printers`)).status).toBe(
        403,
      )
    }
    for (const agentId of [foreignAgent, revokedAgent])
      expect(
        (
          await post(owner, path, {
            agentId,
            printerKey: 'denied',
            confirmedLocalConfiguration: true,
          })
        ).status,
      ).toBe(403)
    const first = await get(owner, path + '?limit=1')
    expect(first.status).toBe(200)
    expect(first.body.printers).toHaveLength(1)
    expect(first.body.nextAfter).toBeTruthy()
    const second = await get(
      owner,
      path + '?limit=1&after=' + first.body.nextAfter,
    )
    expect(second.status).toBe(200)
    expect(second.body.printers).toHaveLength(1)
    expect(second.body.printers[0].assignmentId).not.toBe(
      first.body.printers[0].assignmentId,
    )
    const oldId = registration.body.assignmentId
    expect(
      (
        await post(owner, `${path}/${oldId}/revoke`, {
          agentId: agent,
          printerKey: exact,
        })
      ).status,
    ).toBe(200)
    const replacement = await post(owner, path, {
      agentId: agent,
      printerKey: exact,
      confirmedLocalConfiguration: true,
    })
    expect(replacement.status).toBe(200)
    expect(replacement.body.assignmentId).not.toBe(oldId)
    const stale = await post(owner, `${path}/${oldId}/revoke`, {
      agentId: agent,
      printerKey: exact,
    })
    expect(stale.status).toBe(200)
    expect(stale.body.assignmentId).toBe(oldId)
    expect(stale.body.status).toBe('revoked')
    const current = await get(owner, path)
    expect(
      current.body.printers.some(
        (entry: { assignmentId: string; status: string }) =>
          entry.assignmentId === replacement.body.assignmentId &&
          entry.status === 'active',
      ),
    ).toBe(true)
    const db = postgres({
      host: '127.0.0.1',
      port: Number(port),
      database: 'fixture',
      username: 'fixture',
      max: 3,
      connect_timeout: 3,
    })
    try {
      async function blocked<T>(
        hold: (tx: TransactionSql) => Promise<void>,
        role: string,
        fragment: string,
        start: () => Promise<T>,
        beforeRelease?: () => Promise<void>,
      ): Promise<T> {
        let ready: () => void = () => {
          throw new Error('Lock signal unavailable')
        }
        let release: () => void = () => {
          throw new Error('Lock release unavailable')
        }
        const held = new Promise<void>((resolve) => {
          ready = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const transaction = db.begin(async (tx) => {
          await hold(tx)
          ready()
          await gate
        })
        let operation: Promise<T> | undefined
        try {
          await Promise.race([
            held,
            transaction.then(() => {
              throw new Error('Lock released early')
            }),
          ])
          operation = start()
          void operation.catch(() => {})
          const deadline = performance.now() + 750
          while (true) {
            const rows =
              await db`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=${role} AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
            if (Number(rows[0]?.n) > 0) break
            expect(
              performance.now(),
              'Expected an observed PostgreSQL row-lock wait',
            ).toBeLessThan(deadline)
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          await beforeRelease?.()
        } finally {
          release()
          await transaction
        }
        if (!operation) throw new Error('Blocked request did not start')
        return await operation
      }
      const registration = (page: Page, printerKey: string) =>
        post(page, path, {
          agentId: agent,
          printerKey,
          confirmedLocalConfiguration: true,
        })
      for (const kind of ['downgrade', 'revoke'] as const) {
        const key = `wait-membership-${kind}`
        const response = await blocked(
          async (tx) => {
            if (kind === 'downgrade')
              await tx`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
            else
              await tx`UPDATE farm.memberships SET revoked_at=${Date.now()} WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
          },
          printerRole,
          'farm.memberships',
          () => registration(owner, key),
        )
        expect(response.status).toBe(403)
        const rows =
          await db`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farm}::uuid AND printer_key=${key}`
        expect(rows[0]?.n).toBe(0)
        if (kind === 'downgrade')
          await db`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
      }
      expect((await get(owner, path)).status).toBe(403)
      const session =
        await db`SELECT id FROM farm.account_sessions WHERE account_id=${ownerAccount} AND revoked_at IS NULL`
      expect(session).toHaveLength(1)
      const ownerSession = String(session[0]?.id)
      const revoked = await blocked(
        async (tx) => {
          await tx`UPDATE farm.account_sessions SET revoked_at=${Date.now()} WHERE id=${ownerSession}`
        },
        authRole,
        'farm.account_sessions',
        () => get(owner, path),
      )
      expect(revoked.status).toBe(401)
      expect(
        (
          await db`SELECT revoked_at FROM farm.account_sessions WHERE id=${ownerSession}`
        )[0]?.revoked_at,
      ).not.toBeNull()

      const expiryContext = await browser.newContext({
        ignoreHTTPSErrors: true,
      })
      contexts.push(expiryContext)
      const expiryPage = await expiryContext.newPage()
      await expiryPage.goto(origin + '/entrar')
      const credentials = new PostgresCredentials(db)
      const credential = await credentials.find(usernames.admin!)
      if (!credential || credential.accountId !== adminAccount)
        throw new Error('Missing synthetic admin credential')
      const issuedAt = Date.now()
      const expiresAt = issuedAt + 750
      const adminSession = await credentials.issue(credential, issuedAt, 750)
      if (!adminSession) throw new Error('Synthetic short session not issued')
      const event = {
        req: new Request(origin),
        res: { headers: new Headers() },
      }
      const sealed = await useSession(event, {
        name: SESSION_COOKIE_NAME,
        password: sessionSecret,
        maxAge: 8 * 60 * 60,
        cookie: { ...SESSION_COOKIE_ATTRIBUTES },
      })
      await sealed.update({ sessionRecordId: adminSession })
      const setCookie = event.res.headers.getSetCookie().at(-1)?.split(';')[0]
      if (!setCookie?.startsWith(SESSION_COOKIE_NAME + '='))
        throw new Error('Missing sealed fixture cookie')
      await expiryContext.addCookies([
        {
          name: SESSION_COOKIE_NAME,
          value: setCookie.slice(SESSION_COOKIE_NAME.length + 1),
          url: origin,
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ])
      const expired = await blocked(
        async (tx) => {
          await tx`SELECT agent_id FROM farm.connector_enrollments WHERE agent_id=${agent}::uuid FOR UPDATE`
        },
        printerRole,
        'farm.connector_enrollments',
        () => registration(expiryPage, 'wait-expiry'),
        async () => {
          const remaining = expiresAt - Date.now()
          if (remaining > 0)
            await new Promise((resolve) => setTimeout(resolve, remaining + 5))
        },
      )
      expect(expired.status).toBe(403)
      expect(
        (
          await db`SELECT revoked_at FROM farm.account_sessions WHERE id=${adminSession}`
        )[0]?.revoked_at,
      ).not.toBeNull()
      expect(
        (
          await db`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farm}::uuid AND printer_key='wait-expiry'`
        )[0]?.n,
      ).toBe(0)
    } finally {
      await db.end({ timeout: 3 })
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
