// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
})
registerLibraryPages(current)
registerManagementPages(current)
registerFarmPages(current)
registerAccountPages(current)
