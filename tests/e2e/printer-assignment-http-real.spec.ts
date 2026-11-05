import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

// This suite requires the explicit disposable HTTPS and PostgreSQL fixture.
const enabled = process.env.PRINTER_HTTP_TEST_DISPOSABLE === 'yes'
const origin = process.env.PRINTER_HTTP_TEST_ORIGIN
const password = process.env.PRINTER_HTTP_TEST_PASSWORD
const farm = process.env.PRINTER_HTTP_TEST_FARM
const otherFarm = process.env.PRINTER_HTTP_TEST_OTHER_FARM
const agent = process.env.PRINTER_HTTP_TEST_AGENT
const foreignAgent = process.env.PRINTER_HTTP_TEST_FOREIGN_AGENT
const revokedAgent = process.env.PRINTER_HTTP_TEST_REVOKED_AGENT
const ownerAccount = process.env.PRINTER_HTTP_TEST_OWNER_ACCOUNT
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
    !farm ||
    !otherFarm ||
    !agent ||
    !foreignAgent ||
    !revokedAgent ||
    !ownerAccount ||
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
      max: 1,
      connect_timeout: 3,
    })
    try {
      await db`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
      expect(
        (
          await post(owner, path, {
            agentId: agent,
            printerKey: 'after-downgrade',
            confirmedLocalConfiguration: true,
          })
        ).status,
      ).toBe(403)
      await db`UPDATE farm.memberships SET revoked_at=${Date.now()} WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
      expect((await get(owner, path)).status).toBe(403)
      await db`UPDATE farm.account_sessions SET revoked_at=${Date.now()} WHERE account_id=${ownerAccount} AND revoked_at IS NULL`
      expect((await get(owner, path)).status).toBe(401)
      const rows =
        await db`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farm}::uuid AND printer_key='after-downgrade'`
      expect(rows[0]?.n).toBe(0)
    } finally {
      await db.end({ timeout: 3 })
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
