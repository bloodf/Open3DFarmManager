import { test, expect, type Page } from '@playwright/test'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string
let source: string
const id = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'open3d-device-key-'))
  const outfile = join(directory, 'browser.js')
  buildSync({
    entryPoints: ['./tests/helpers/browser-device-entry.ts'],
    bundle: true,
    target: 'browser',
    outfile,
    logLevel: 'silent',
  })
  source = readFileSync(outfile, 'utf8')
})
test.afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

async function publicKey(page: Page, farmId = id, userId = id) {
  return page.evaluate(
    async ({ source, farmId, userId }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      try {
        const api = await import(url)
        const pair = await api.loadOrCreateDeviceKey({ farmId, userId })
        return await crypto.subtle.exportKey('jwk', pair.publicKey)
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    { source, farmId, userId },
  )
}

test('concurrent tabs retain one key per scope while accounts and farms remain separate', async ({
  page,
  context,
}) => {
  const secondPage = await context.newPage()
  await Promise.all([page.goto('/'), secondPage.goto('/')])
  const keys = await Promise.all([
    publicKey(page),
    publicKey(secondPage),
    publicKey(page),
    publicKey(secondPage),
  ])
  for (const key of keys) expect(key).toEqual(keys[0])
  expect(await publicKey(page, id, otherId)).not.toEqual(keys[0])
  expect(await publicKey(page, otherId, id)).not.toEqual(keys[0])
  await secondPage.close()
})

test('inconsistent stored keys reject repeatedly without silently rotating the identity', async ({
  page,
}) => {
  await page.goto('/')
  await publicKey(page)
  await page.evaluate(
    async ({ source, id }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      try {
        const api = await import(url)
        const unrelated = await api.createBrowserKey()
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('open3dfarmmanager-device-keys', 1)
          open.onerror = () => reject(new Error('fixture open failed'))
          open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction('keys', 'readwrite')
            const store = tx.objectStore('keys')
            const read = store.get(`${id}:${id}`)
            read.onsuccess = () =>
              store.put(
                { ...read.result, publicKey: unrelated.publicKey },
                `${id}:${id}`,
              )
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => {
              db.close()
              reject(new Error('fixture update failed'))
            }
          }
        })
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    { source, id },
  )
  for (let i = 0; i < 2; i++) {
    await expect(publicKey(page)).rejects.toThrow(
      'Browser device key storage unavailable or invalid',
    )
    await page.reload()
  }
})

test('storage denial never falls back to an ephemeral key', async ({
  page,
}) => {
  await page.goto('/')
  const error = await page.evaluate(
    async ({ source, id }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      const original = indexedDB.open
      try {
        const api = await import(url)
        indexedDB.open = () => {
          throw new DOMException('synthetic denied storage', 'SecurityError')
        }
        try {
          await api.loadOrCreateDeviceKey({ farmId: id, userId: id })
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      } finally {
        indexedDB.open = original
        URL.revokeObjectURL(url)
      }
    },
    { source, id },
  )
  expect(error).toBe('Browser device key storage unavailable or invalid')
})

test('aborted key insertion is never reported as a persisted key', async ({
  page,
}) => {
  await page.goto('/')
  const error = await page.evaluate(
    async ({ source, id }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      const original = IDBObjectStore.prototype.add
      try {
        const api = await import(url)
        IDBObjectStore.prototype.add = function (value, key) {
          const request = original.call(this, value, key)
          this.transaction.abort()
          return request
        }
        try {
          await api.loadOrCreateDeviceKey({ farmId: id, userId: id })
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      } finally {
        IDBObjectStore.prototype.add = original
        URL.revokeObjectURL(url)
      }
    },
    { source, id },
  )
  expect(error).toBe('Browser device key storage unavailable or invalid')
  expect((await publicKey(page)).kty).toBe('EC')
})
