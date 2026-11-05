import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  validateBrowserDevicePublicKey,
  verifyBrowserDeviceProof,
  type BrowserDeviceProofChallenge,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'

const limits = {
  pendingLifetimeMs: 86400000,
  proofLifetimeMs: 60000,
  maxChallengesPerKey: 3,
}

test('actual device page retains nonextractable key across reload and rejects corrupt storage', async ({
  page,
}) => {
  const farm = randomUUID(),
    keyId = randomUUID()
  let account = 'account_fixture',
    challengeCount = 0,
    flipAfterLocalRead = false,
    listReads = 0
  let challenge: BrowserDeviceProofChallenge | undefined
  let publicKey:
    | Awaited<ReturnType<typeof validateBrowserDevicePublicKey>>['publicKey']
    | undefined
  let verified = false
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me')
      return route.fulfill({ json: { accountId: account } })
    if (url.pathname === '/api/farms')
      return route.fulfill({
        json: { farms: [{ farmId: farm }], nextAfter: null },
      })
    if (url.pathname === '/api/browser-devices') {
      if (flipAfterLocalRead) listReads++
      return route.fulfill({
        json: {
          currentAccountId: account,
          currentRole: 'owner',
          devices: [],
          nextAfter: null,
          limits,
        },
      })
    }
    if (url.pathname === '/api/browser-devices/challenges') {
      challengeCount++
      const data = route.request().postDataJSON()
      expect(data.farm_id).toBe(farm)
      const validated = await validateBrowserDevicePublicKey(data.public_key)
      publicKey = validated.publicKey
      const now = Date.now()
      challenge = {
        v: 1,
        purpose: 'enroll',
        challenge_id: randomUUID(),
        farm_id: farm,
        key_id: keyId,
        account_id: account,
        session_id: randomUUID(),
        thumbprint: validated.thumbprint,
        origin: url.origin,
        audience: 'open3dfarmmanager:browser-device',
        nonce: 'A'.repeat(43),
        issued_at: now,
        expires_at: now + 60000,
      }
      return route.fulfill({ json: { challenge, limits } })
    }
    if (url.pathname === '/api/browser-devices/proofs') {
      const data = route.request().postDataJSON()
      expect(challenge && publicKey).toBeTruthy()
      if (!challenge || !publicKey) throw new Error('Missing challenge fixture')
      verified = await verifyBrowserDeviceProof(
        challenge,
        publicKey,
        data.signature,
      )
      expect(verified).toBe(true)
      return route.fulfill({
        json: {
          device: {
            keyId,
            accountId: account,
            thumbprint: challenge.thumbprint,
            status: 'pending',
            proofAt: Date.now(),
          },
          limits,
        },
      })
    }
    throw new Error('Unexpected API ' + url.pathname)
  })
  await page.goto('/dispositivos')
  await page.locator('#device-farm').selectOption(farm)
  await expect(
    page.getByText('Nenhuma chave local', { exact: false }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
    .click()
  await expect(
    page.getByText('Posse confirmada.', { exact: false }),
  ).toBeVisible()
  expect(verified).toBe(true)
  const fingerprint = await page.locator('li code').first().textContent()
  expect(fingerprint).toBeTruthy()
  const keyState = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('open3dfarmmanager-device-keys')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const row = await new Promise<{ privateKey: CryptoKey }>(
      (resolve, reject) => {
        const req = db.transaction('keys').objectStore('keys').getAll()
        req.onsuccess = () => resolve(req.result[0])
        req.onerror = () => reject(req.error)
      },
    )
    let exportDenied = false
    try {
      await crypto.subtle.exportKey('pkcs8', row.privateKey)
    } catch {
      exportDenied = true
    }
    db.close()
    return { extractable: row.privateKey.extractable, exportDenied }
  })
  expect(keyState).toEqual({ extractable: false, exportDenied: true })
  await page.reload()
  await page.locator('#device-farm').selectOption(farm)
  await expect(page.locator('li code').first()).toHaveText(fingerprint!)
  await expect(
    page.getByText('Cada prova deve terminar em 60 segundos.', {
      exact: false,
    }),
  ).toContainText('24 horas')
  await expect(
    page.getByText('Cada prova deve terminar em 60 segundos.', {
      exact: false,
    }),
  ).toContainText('três desafios')
  account = 'other_account'
  await page.reload()
  await page.locator('#device-farm').selectOption(farm)
  await expect(
    page.getByText('Nenhuma chave local', { exact: false }),
  ).toBeVisible()
  expect(challengeCount).toBe(1)
  const rowCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('open3dfarmmanager-device-keys')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const count = await new Promise<number>((resolve, reject) => {
      const req = db.transaction('keys').objectStore('keys').count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return count
  })
  expect(rowCount).toBe(1)
  account = 'account_fixture'
  await page.reload()
  await page.locator('#device-farm').selectOption(farm)
  await expect(page.locator('li code').first()).toHaveText(fingerprint!)
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('open3dfarmmanager-device-keys')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const tx = db.transaction('keys', 'readwrite'),
      store = tx.objectStore('keys')
    const originalCursor = IDBObjectStore.prototype.openCursor
    IDBObjectStore.prototype.openCursor = function (...args) {
      Reflect.set(globalThis, 'deviceTestCursorPending', true)
      IDBObjectStore.prototype.openCursor = originalCursor
      return originalCursor.apply(this, args)
    }
    let running = true
    Reflect.set(globalThis, 'releaseDeviceTestLock', () => {
      running = false
    })
    const timer = setTimeout(() => {
      running = false
    }, 5000)
    const keep = () => {
      if (!running) return
      const req = store.get('__test_lock__')
      req.onsuccess = keep
    }
    tx.oncomplete = () => {
      clearTimeout(timer)
      db.close()
    }
    keep()
  })
  flipAfterLocalRead = true
  await page.getByRole('button', { name: 'Atualizar dispositivos' }).click()
  await expect.poll(() => listReads).toBe(1)
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(globalThis, 'deviceTestCursorPending') === true,
      ),
    )
    .toBe(true)
  account = 'other_account'
  await page.evaluate(() => Reflect.get(globalThis, 'releaseDeviceTestLock')())
  await expect(page.getByRole('alert')).toContainText(
    'operação não foi confirmada',
  )
  expect(challengeCount).toBe(1)
  flipAfterLocalRead = false
  account = 'account_fixture'
  await page.reload()
  await page.locator('#device-farm').selectOption(farm)
  await expect(page.locator('li code').first()).toHaveText(fingerprint!)
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('open3dfarmmanager-device-keys')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite')
      const store = tx.objectStore('keys')
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        if (cursor.result) cursor.result.update({ version: 1 })
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.getByRole('button', { name: 'Atualizar dispositivos' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'operação não foi confirmada',
  )
  await expect(
    page.getByRole('button', { name: 'Criar chave e solicitar cadastro' }),
  ).toHaveCount(0)
})

test('account change after challenge stops signing and proof submission', async ({
  page,
}) => {
  const farm = randomUUID(),
    account = 'account_fixture'
  let changed = false,
    proofRequests = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me')
      return route.fulfill({
        json: { accountId: changed ? 'other_account' : account },
      })
    if (url.pathname === '/api/farms')
      return route.fulfill({
        json: { farms: [{ farmId: farm }], nextAfter: null },
      })
    if (url.pathname === '/api/browser-devices')
      return route.fulfill({
        json: {
          currentAccountId: changed ? 'other_account' : account,
          currentRole: 'owner',
          devices: [],
          nextAfter: null,
          limits,
        },
      })
    if (url.pathname === '/api/browser-devices/challenges') {
      const data = route.request().postDataJSON(),
        validated = await validateBrowserDevicePublicKey(data.public_key),
        now = Date.now()
      changed = true
      return route.fulfill({
        json: {
          challenge: {
            v: 1,
            purpose: 'enroll',
            challenge_id: randomUUID(),
            farm_id: farm,
            key_id: randomUUID(),
            account_id: account,
            session_id: randomUUID(),
            thumbprint: validated.thumbprint,
            origin: url.origin,
            audience: 'open3dfarmmanager:browser-device',
            nonce: 'A'.repeat(43),
            issued_at: now,
            expires_at: now + 60000,
          },
          limits,
        },
      })
    }
    if (url.pathname === '/api/browser-devices/proofs') {
      proofRequests++
      return route.fulfill({ status: 500 })
    }
    throw new Error('Unexpected API ' + url.pathname)
  })
  await page.goto('/dispositivos')
  await page.locator('#device-farm').selectOption(farm)
  await page
    .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    'operação não foi confirmada',
  )
  expect(proofRequests).toBe(0)
})

test('unproven local key resumes explicitly after reload without creating another key', async ({
  page,
}) => {
  const farm = randomUUID(),
    account = 'account_fixture',
    keys: string[] = []
  let challenges = 0,
    recoveries = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me')
      return route.fulfill({ json: { accountId: account } })
    if (url.pathname === '/api/farms')
      return route.fulfill({
        json: { farms: [{ farmId: farm }], nextAfter: null },
      })
    if (url.pathname === '/api/browser-devices')
      return route.fulfill({
        json: {
          currentAccountId: account,
          currentRole: 'owner',
          devices: [],
          nextAfter: null,
          limits,
        },
      })
    if (url.pathname === '/api/browser-devices/challenges') {
      challenges++
      keys.push(
        (
          await validateBrowserDevicePublicKey(
            route.request().postDataJSON().public_key,
          )
        ).thumbprint,
      )
      return route.fulfill({ status: 503, json: { message: 'indisponível' } })
    }
    if (url.pathname === '/api/browser-devices/recovery-challenges') {
      recoveries++
      return route.fulfill({ status: 500 })
    }
    throw new Error('Unexpected API ' + url.pathname)
  })
  await page.goto('/dispositivos')
  await page.locator('#device-farm').selectOption(farm)
  await page
    .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    'operação não foi confirmada',
  )
  await page.reload()
  await page.locator('#device-farm').selectOption(farm)
  await page
    .getByRole('button', { name: 'Retomar cadastro com esta chave' })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    'operação não foi confirmada',
  )
  expect(challenges).toBe(2)
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).toBe(keys[0])
  expect(recoveries).toBe(0)
})

test('approved local key explicitly proves possession again after reload', async ({
  page,
}) => {
  const farm = randomUUID(),
    account = 'account_fixture',
    keyId = randomUUID()
  let registered:
    | {
        thumbprint: string
        publicKey: Awaited<
          ReturnType<typeof validateBrowserDevicePublicKey>
        >['publicKey']
      }
    | undefined
  let challenge: BrowserDeviceProofChallenge | undefined,
    recoveries = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me')
      return route.fulfill({ json: { accountId: account } })
    if (url.pathname === '/api/farms')
      return route.fulfill({
        json: { farms: [{ farmId: farm }], nextAfter: null },
      })
    if (url.pathname === '/api/browser-devices')
      return route.fulfill({
        json: {
          currentAccountId: account,
          currentRole: 'owner',
          devices: registered
            ? [
                {
                  keyId,
                  accountId: account,
                  thumbprint: registered.thumbprint,
                  status: 'approved',
                  proofAt: Date.now(),
                  createdAt: Date.now() - 1000,
                  pendingExpiresAt: null,
                },
              ]
            : [],
          nextAfter: null,
          limits,
        },
      })
    if (
      url.pathname === '/api/browser-devices/challenges' ||
      url.pathname === '/api/browser-devices/recovery-challenges'
    ) {
      const validated = await validateBrowserDevicePublicKey(
        route.request().postDataJSON().public_key,
      )
      const recovery = url.pathname.endsWith('/recovery-challenges')
      if (recovery) {
        recoveries++
        expect(validated.thumbprint).toBe(registered?.thumbprint)
      }
      const now = Date.now()
      challenge = {
        v: 1,
        purpose: recovery ? 'recover' : 'enroll',
        challenge_id: randomUUID(),
        farm_id: farm,
        key_id: keyId,
        account_id: account,
        session_id: randomUUID(),
        thumbprint: validated.thumbprint,
        origin: url.origin,
        audience: 'open3dfarmmanager:browser-device',
        nonce: 'A'.repeat(43),
        issued_at: now,
        expires_at: now + 60000,
      }
      registered = validated
      return route.fulfill({ json: { challenge, limits } })
    }
    if (url.pathname === '/api/browser-devices/proofs') {
      if (!challenge || !registered) throw new Error('Missing proof fixture')
      expect(
        await verifyBrowserDeviceProof(
          challenge,
          registered.publicKey,
          route.request().postDataJSON().signature,
        ),
      ).toBe(true)
      return route.fulfill({
        json: {
          device: {
            keyId,
            accountId: account,
            thumbprint: registered.thumbprint,
            status: 'approved',
            proofAt: Date.now(),
          },
          limits,
        },
      })
    }
    throw new Error('Unexpected API ' + url.pathname)
  })
  await page.goto('/dispositivos')
  await page.locator('#device-farm').selectOption(farm)
  await page
    .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
    .click()
  await expect(
    page.getByText('Posse confirmada nesta sessão.', { exact: false }),
  ).toBeVisible()
  await page.reload()
  await page.locator('#device-farm').selectOption(farm)
  await page
    .getByRole('button', { name: 'Confirmar posse da chave existente' })
    .click()
  await expect(
    page.getByText('Posse confirmada nesta sessão.', { exact: false }),
  ).toBeVisible()
  expect(recoveries).toBe(1)
})

test('administrator confirms full fingerprint before approval and terminal revocation', async ({
  page,
}) => {
  const farm = randomUUID(),
    keyId = randomUUID(),
    thumbprint = 'A'.repeat(43)
  let status: 'pending' | 'approved' | 'revoked' = 'pending'
  const operations: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me')
      return route.fulfill({ json: { accountId: 'admin' } })
    if (url.pathname === '/api/farms')
      return route.fulfill({
        json: { farms: [{ farmId: farm }], nextAfter: null },
      })
    if (url.pathname === '/api/browser-devices')
      return route.fulfill({
        json: {
          currentAccountId: 'admin',
          currentRole: 'admin',
          devices: [
            {
              keyId,
              accountId: 'owner',
              thumbprint,
              status,
              proofAt: 1000,
              createdAt: 1000,
              pendingExpiresAt: status === 'pending' ? 86401000 : null,
            },
          ],
          nextAfter: null,
          limits,
        },
      })
    if (
      url.pathname === '/api/browser-devices/approve' ||
      url.pathname === '/api/browser-devices/revoke'
    ) {
      const request = route.request().postDataJSON()
      expect(request).toEqual({
        farm_id: farm,
        key_id: keyId,
        expected_thumbprint: thumbprint,
      })
      operations.push(url.pathname)
      status = url.pathname.endsWith('/approve') ? 'approved' : 'revoked'
      return route.fulfill({
        json: {
          device: {
            keyId,
            accountId: 'owner',
            thumbprint,
            status,
            proofAt: 1000,
          },
          limits,
        },
      })
    }
    throw new Error('Unexpected API ' + url.pathname)
  })
  await page.goto('/dispositivos')
  await page.locator('#device-farm').selectOption(farm)
  const approve = page.getByRole('button', { name: 'Aprovar dispositivo' })
  await expect(approve).toBeDisabled()
  await page.locator('#fingerprint-confirmation').fill('wrong')
  await expect(approve).toBeDisabled()
  await page.locator('#fingerprint-confirmation').fill(thumbprint)
  await approve.click()
  await expect(page.getByText('Dispositivo aprovado.')).toBeVisible()
  await page.locator('#fingerprint-confirmation').fill(thumbprint)
  await page.getByRole('button', { name: 'Revogar definitivamente' }).click()
  await expect(
    page.getByText('Dispositivo revogado definitivamente.'),
  ).toBeVisible()
  await expect(page.getByText('Revogado', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Aprovar dispositivo' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Revogar definitivamente' }),
  ).toHaveCount(0)
  expect(operations).toEqual([
    '/api/browser-devices/approve',
    '/api/browser-devices/revoke',
  ])
})

test('unconfigured device routes remain unavailable through actual Nuxt server', async ({
  request,
}) => {
  const list = await request.get(`/api/browser-devices?farm_id=${randomUUID()}`)
  const enrollment = await request.post('/api/browser-devices/challenges', {
    data: {},
  })
  expect(list.status()).toBe(404)
  expect(enrollment.status()).toBe(404)
})
