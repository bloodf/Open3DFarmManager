// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createConnection } from 'node:net'
import * as httpMock from '../../packages/sim-tools/src/mocks/http-mock'
import {
  createPageHarness,
  pageNames,
  type PageHarness,
} from '../helpers/page-harness'
import { register as registerAccountPages } from '../helpers/page-state-specs/account-pages'
import { register as registerFarmPages } from '../helpers/page-state-specs/farm-pages'
import { register as registerLibraryPages } from '../helpers/page-state-specs/library-pages'
import { register as registerManagementPages } from '../helpers/page-state-specs/management-pages'

vi.setConfig({ testTimeout: 30_000 })

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 60_000)
afterAll(async () => {
  await harness?.close()
})
const current = () => harness

describe('page states', () => {
  it('knows every page', () => {
    expect(pageNames.length).toBeGreaterThan(20)
  })

  it('closes the listener when mounting fails', async () => {
    const start = httpMock.startHttpMock
    let origin = ''
    const spy = vi
      .spyOn(httpMock, 'startHttpMock')
      .mockImplementation(async (options) => {
        const server = await start(options)
        origin = server.origin
        return server
      })
    try {
      await expect(
        harness.open(
          pageNames[0]!,
          {},
          {
            init: `Object.defineProperty(window, '__mount', {
            set() {},
            get() { return () => { throw new Error('mount failed') } }
          })`,
          },
        ),
      ).rejects.toThrow('mount failed')
      expect(origin).not.toBe('')
      const url = new URL(origin)
      const error = await new Promise<NodeJS.ErrnoException>(
        (resolve, reject) => {
          const socket = createConnection({
            host: url.hostname,
            port: Number(url.port),
          })
          socket.once('connect', () => {
            socket.destroy()
            reject(new Error('listener still accepts connections'))
          })
          socket.once('error', resolve)
        },
      )
      expect(error.code).toBe('ECONNREFUSED')
    } finally {
      spy.mockRestore()
    }
  })
})
registerLibraryPages(current)
registerManagementPages(current)
registerFarmPages(current)
registerAccountPages(current)
