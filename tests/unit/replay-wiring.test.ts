// SPDX-License-Identifier: MIT
import { join } from 'node:path'
import { Server } from 'node:net'
import { expect as pw } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

/**
 * The real `historico` and `biblioteca` pages in Chrome against an in-process
 * API on 127.0.0.1 (port 0). Only the WebRTC session is a stand-in
 * (tests/helpers/replay-live-stub.ts); the pages, the replay dialog and the
 * compatibility check are the real ones.
 */
vi.setConfig({ testTimeout: 30_000 })

const FARM = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-000000000002'
const SHA = 'a'.repeat(64)
const WAIT = 10_000

const assignment = (key: string, name: string) => ({
  assignmentId: `${key}-id`,
  agentId: AGENT,
  printerKey: key,
  displayName: name,
  status: 'active',
  connectorStatus: 'approved',
})
const profile = (key: string, model: string) => ({
  assignmentId: `${key}-id`,
  effective: {
    values: { model, nozzleDiameterMm: 0.4 },
    compatibleModels: [model],
  },
})
const version = {
  id: '00000000-0000-4000-8000-0000000000a1',
  itemId: '00000000-0000-4000-8000-0000000000b1',
  versionNumber: 1,
  sizeBytes: 1024,
  sha256: SHA,
  storageLocation: 'server',
  agentId: null,
  originalName: 'vaso.gcode',
  kind: 'gcode',
  plateCount: 1,
  metadata: {
    printerModel: 'Voron 2.4',
    tools: [{ nozzleDiameter: 0.4, filamentType: 'PLA' }],
  },
  hasThumbnail: false,
  notes: '',
  createdAt: Date.UTC(2026, 10, 1),
  deletedAt: null,
  purgedAt: null,
}
const item = {
  id: version.itemId,
  title: 'Vaso espiral',
  tags: [],
  archived: false,
  createdAt: 1,
  latest: version,
}
const job = {
  id: 'job-1',
  printerKey: 'voron',
  outcome: 'completed',
  filename: 'vaso.gcode',
  librarySha256: SHA,
  plate: 1,
  endedAt: Date.UTC(2026, 10, 2),
  printDurationSeconds: 3600,
}

const routes = (extra: Routes = {}): Routes => ({
  'GET /api/farms': reply({ farms: [{ farmId: FARM }], nextAfter: null }),
  'GET /api/job-history': reply({
    jobs: [job, { ...job, id: 'job-2', librarySha256: undefined }],
    nextBefore: null,
  }),
  [`GET /api/farms/${FARM}/library/replay-source`]: reply({ version }),
  [`GET /api/farms/${FARM}/printers`]: reply({
    printers: [
      assignment('voron', 'Voron da bancada'),
      assignment('ender', 'Ender da oficina'),
    ],
    nextAfter: null,
  }),
  [`GET /api/farms/${FARM}/printer-profiles`]: reply({
    profiles: [profile('voron', 'Voron 2.4'), profile('ender', 'Ender 3')],
  }),
  [`GET /api/farms/${FARM}/library/settings`]: reply({
    settings: { storageMode: 'server', quotaBytes: 1 << 30, retentionDays: 30 },
    locations: [],
    usage: { usedBytes: 1024 },
    canManage: true,
  }),
  [`GET /api/farms/${FARM}/connectors`]: reply({ connectors: [] }),
  [`GET /api/farms/${FARM}/library`]: reply({
    items: [item],
    nextCursor: null,
  }),
  [`GET /api/farms/${FARM}/library/items/${item.id}/versions`]: reply({
    versions: [version],
  }),
  ...extra,
})

/** What the live session tells the pages: both printers are idle and signed. */
const liveInit = (result: unknown) => `
  window.__replayLive = {
    result: ${JSON.stringify(result)},
    sent: [],
    info: {
      voron: { connectorOnline: true, live: true, state: 'idle', materials: [] },
      ender: { connectorOnline: true, live: true, state: 'idle', materials: [] },
    },
  }`
const sent = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __replayLive: { sent: unknown[] } }).__replayLive
        .sent,
  )

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness({
    replace: {
      [join(process.cwd(), 'apps/farm/app/composables/useReplayLive.ts')]: join(
        process.cwd(),
        'tests/helpers/replay-live-stub.ts',
      ),
    },
  })
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

describe('page harness setup cleanup', () => {
  it('closes its listener and browser context when mounting fails', async () => {
    const listeningServers = () =>
      (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
        ._getActiveHandles()
        .filter(
          (handle: unknown) => handle instanceof Server && handle.listening,
        ).length
    const before = listeningServers()
    await expect(
      harness.open('historico', routes(), {
        init: "Object.defineProperty(window, '__mount', { configurable: false, value: () => { throw new Error('mount fault') } })",
      }),
    ).rejects.toThrow()
    expect(listeningServers()).toBe(before)
  })
})

describe('Histórico', () => {
  it('shows "Imprimir de novo" only for linked jobs', async () => {
    const opened = await harness.open('historico', routes(), {
      init: liveInit({ outcome: 'applied' }),
    })
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: 'Imprimir de novo vaso.gcode' })
        .waitFor({ timeout: WAIT })
      expect(
        await page.getByRole('button', { name: /Imprimir de novo/ }).count(),
      ).toBe(1)
    } finally {
      await opened.close()
    }
  })

  it('offers the compatible printer, refuses the incompatible one with its reason and sends the replay', async () => {
    const opened = await harness.open('historico', routes(), {
      init: liveInit({ outcome: 'applied' }),
    })
    try {
      const { page, calls } = opened
      await page
        .getByRole('button', { name: /Imprimir de novo/ })
        .click({ timeout: WAIT })
      const dialog = page.getByRole('dialog')
      const voron = dialog.getByRole('radio', { name: /Voron da bancada/ })
      await voron.waitFor({ timeout: WAIT })
      await pw(voron).toBeEnabled()
      await pw(voron).toBeChecked()
      const ender = dialog.getByRole('radio', { name: /Ender da oficina/ })
      await pw(ender).toBeDisabled()
      await pw(dialog).toContainText('Bloqueadas ou indisponíveis')
      await pw(dialog).toContainText(/incompatível/i)
      expect(calls('GET', `/library/replay-source?sha256=${SHA}`)).toBe(1)

      await dialog.getByRole('checkbox', { name: /mesa está limpa/i }).check()
      await dialog.getByRole('button', { name: /^Imprimir/ }).click()
      await pw(dialog).toContainText('Impressão iniciada')
      expect(await sent(page)).toEqual([
        { printerKey: 'voron', args: { sha256: SHA } },
      ])
    } finally {
      await opened.close()
    }
  })

  it('shows the refusal from the Connector in plain pt-BR', async () => {
    const opened = await harness.open('historico', routes(), {
      init: liveInit({ outcome: 'rejected', code: 'local-file-missing' }),
    })
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: /Imprimir de novo/ })
        .click({ timeout: WAIT })
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('checkbox', { name: /mesa está limpa/i })
        .check({ timeout: WAIT })
      await dialog.getByRole('button', { name: /^Imprimir/ }).click()
      await pw(dialog).toContainText(
        'O arquivo não está na biblioteca do Connector',
      )
      await pw(dialog).toContainText('A impressão não foi iniciada')
    } finally {
      await opened.close()
    }
  })

  it('says the version is unavailable when the library no longer has it', async () => {
    const opened = await harness.open(
      'historico',
      routes({
        [`GET /api/farms/${FARM}/library/replay-source`]: reply(
          { message: 'não encontrado' },
          404,
        ),
      }),
      { init: liveInit({ outcome: 'applied' }) },
    )
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: /Imprimir de novo/ })
        .click({ timeout: WAIT })
      await pw(
        page.getByText(
          'A versão da biblioteca deste trabalho não está disponível.',
        ),
      ).toBeVisible()
      expect(await page.getByRole('dialog').count()).toBe(0)
    } finally {
      await opened.close()
    }
  })

  it('keeps every printer unavailable without a live signed session', async () => {
    const opened = await harness.open('historico', routes(), {
      init: `window.__replayLive = { result: { outcome: 'not-sent' }, sent: [], info: {} }`,
    })
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: /Imprimir de novo/ })
        .click({ timeout: WAIT })
      const dialog = page.getByRole('dialog')
      await pw(
        dialog.getByRole('radio', { name: /Voron da bancada/ }),
      ).toBeDisabled({
        timeout: WAIT,
      })
      await pw(dialog).toContainText('Não há conexão direta segura')
      expect(await sent(page)).toEqual([])
    } finally {
      await opened.close()
    }
  })
})

describe('Biblioteca', () => {
  it('shows "Imprimir de novo" on a version and sends the replay', async () => {
    const opened = await harness.open('biblioteca', routes(), {
      init: liveInit({ outcome: 'applied', code: undefined }),
    })
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: 'Ver detalhes de Vaso espiral' })
        .click({ timeout: WAIT })
      await page
        .getByRole('button', { name: /Imprimir de novo/ })
        .click({ timeout: WAIT })
      const dialog = page.getByRole('dialog', { name: /Imprimir de novo/ })
      const voron = dialog.getByRole('radio', { name: /Voron da bancada/ })
      await pw(voron).toBeEnabled({ timeout: WAIT })
      await pw(
        dialog.getByRole('radio', { name: /Ender da oficina/ }),
      ).toBeDisabled()
      await dialog.getByRole('checkbox', { name: /mesa está limpa/i }).check()
      await dialog.getByRole('button', { name: /^Imprimir/ }).click()
      await pw(dialog).toContainText('Impressão iniciada')
      expect(await sent(page)).toEqual([
        { printerKey: 'voron', args: { sha256: SHA } },
      ])
    } finally {
      await opened.close()
    }
  })
})
