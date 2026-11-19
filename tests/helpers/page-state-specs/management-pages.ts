// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import {
  RAW_ERROR,
  rawFailure,
  reply,
  visibleText,
  type PageHarness,
  type Routes,
} from '../page-harness'
import type { RegisterStates } from './types'

const farm = '11111111-1111-4111-8111-111111111111'
const farm2 = '22222222-2222-4222-8222-222222222222'
const nextCursor = '33333333-3333-4333-8333-333333333333'
const farmPage = (...ids: string[]) =>
  reply({ farms: ids.map((farmId) => ({ farmId })), nextAfter: null })
const WAIT = { timeout: 10_000 }
const hang = { hang: true } as const

type Opened = Awaited<ReturnType<PageHarness['open']>>

/** Opens `name` and always closes it, so a failed assertion leaks nothing. */
async function using(
  harness: () => PageHarness,
  name: string,
  routes: Routes,
  run: (opened: Opened) => Promise<void>,
) {
  const opened = await harness().open(name, routes)
  try {
    await run(opened)
  } finally {
    await opened.close()
  }
}

const shows = (page: Page, text: string) =>
  page.getByText(text, { exact: false }).first().waitFor(WAIT)
const heading = (page: Page, name: string) =>
  page.getByRole('heading', { name }).waitFor(WAIT)
const skeletons = (page: Page) => page.locator('[aria-busy="true"] .skeleton')
async function expectNoRawText(page: Page) {
  expect(await visibleText(page)).not.toMatch(RAW_ERROR)
}
/** Loading pattern: busy region, announced status, skeleton, no raw text. */
async function expectLoading(page: Page, text: string) {
  await page.locator('[aria-busy="true"] [role="status"]').first().waitFor(WAIT)
  await shows(page, text)
  expect(await skeletons(page).count()).toBeGreaterThan(0)
  await expectNoRawText(page)
}
async function expectNotStale(page: Page) {
  expect(await page.getByText('Dados desatualizados').count()).toBe(0)
  expect(await page.getByText('Lista desatualizada').count()).toBe(0)
}

// ---- connectors -----------------------------------------------------------
const connectorRow = {
  agentId: '44444444-4444-4444-8444-444444444444',
  fingerprint: 'synthetic-fingerprint',
  status: 'pending',
}
const connectorRoutes = (overrides: Routes = {}): Routes => ({
  'GET /api/connector-pairing/capability': reply({ enabled: true }),
  'GET /api/farms': farmPage(farm),
  [`GET /api/farms/${farm}/connectors`]: reply({
    connectors: [connectorRow],
    nextAfter: null,
  }),
  ...overrides,
})

// ---- dispositivos ---------------------------------------------------------
const thumbprint = `${'A'.repeat(42)}A`
const deviceLimits = {
  pendingLifetimeMs: 86_400_000,
  proofLifetimeMs: 60_000,
  maxChallengesPerKey: 3,
}
const deviceList = (devices: unknown[]) =>
  reply({
    currentAccountId: 'account_fixture',
    currentRole: 'owner',
    devices,
    nextAfter: null,
    limits: deviceLimits,
  })
const deviceRow = {
  keyId: '55555555-5555-4555-8555-555555555555',
  accountId: 'other_account',
  thumbprint,
  status: 'pending',
  proofAt: null,
  createdAt: 1000,
  pendingExpiresAt: null,
}
const deviceRoutes = (overrides: Routes = {}): Routes => ({
  'GET /api/auth/me': reply({ accountId: 'account_fixture' }),
  'GET /api/farms': farmPage(farm),
  'GET /api/browser-devices': deviceList([deviceRow]),
  ...overrides,
})

// ---- integracoes ----------------------------------------------------------
const appRow = (id: string, name: string) => ({
  id,
  name,
  sandbox: false,
  createdAt: 1000,
  revokedAt: null,
})
const appId = '66666666-6666-4666-8666-666666666666'
const integrationRoutes = (overrides: Routes = {}): Routes => ({
  'GET /api/farms': farmPage(farm),
  [`GET /api/farms/${farm}/integrations/apps`]: reply({
    apps: [appRow(appId, 'Painel da oficina')],
    printers: [],
  }),
  [`GET /api/farms/${farm}/integrations/apps/${appId}/grants`]: reply({
    grants: [],
  }),
  ...overrides,
})

// ---- membros --------------------------------------------------------------
const memberRoutes = (overrides: Routes = {}): Routes => ({
  'GET /api/farms': farmPage(farm),
  [`GET /api/farms/${farm}/members`]: reply({
    members: [{ accountId: 'admin-account', username: 'Admin', role: 'admin' }],
  }),
  [`GET /api/farms/${farm}/invites`]: reply({ invites: [] }),
  ...overrides,
})

export const register: RegisterStates = (harness) => {
  describe('connectors states', { timeout: 30_000 }, () => {
    it('connectors: loading', () =>
      using(
        harness,
        'connectors',
        connectorRoutes({ 'GET /api/farms': hang }),
        async ({ page }) => {
          await expectLoading(page, 'Carregando o inventário…')
          expect(await page.getByText('Nenhuma farm disponível').count()).toBe(
            0,
          )
        },
      ))

    it('connectors: empty', () =>
      using(
        harness,
        'connectors',
        connectorRoutes({
          'GET /api/farms': farmPage(),
        }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Nenhuma farm disponível')
          await page
            .getByRole('button', { name: 'Consultar novamente' })
            .waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
          // A farm without registrations offers the next action.
          setRoutes(
            connectorRoutes({
              [`GET /api/farms/${farm}/connectors`]: reply({
                connectors: [],
                nextAfter: null,
              }),
            }),
          )
          await page
            .getByRole('button', { name: 'Consultar novamente' })
            .click()
          await page.locator('#farm').selectOption(farm)
          await heading(page, 'Nenhum Connector registrado')
          await page
            .getByRole('link', { name: 'Aprovar um novo Connector' })
            .waitFor(WAIT)
        },
      ))

    it('connectors: error', () =>
      using(
        harness,
        'connectors',
        connectorRoutes({ 'GET /api/farms': rawFailure() }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Inventário indisponível')
          await shows(page, 'Não foi possível consultar o inventário.')
          await expectNoRawText(page)
          expect(await skeletons(page).count()).toBe(0)
          setRoutes(connectorRoutes())
          await page.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.locator('#farm option', { hasText: farm }).waitFor({
            state: 'attached',
            ...WAIT,
          })
          expect(
            await page
              .getByRole('heading', { name: 'Inventário indisponível' })
              .count(),
          ).toBe(0)
        },
      ))

    it('connectors: stale', () =>
      // n/a by design: a failed refetch clears the inventory so no old
      // authorized rows stay on screen; only the error state remains.
      using(
        harness,
        'connectors',
        connectorRoutes(),
        async ({ page, setRoutes }) => {
          await page.locator('#farm option', { hasText: farm }).waitFor({
            state: 'attached',
            ...WAIT,
          })
          await page.locator('#farm').selectOption(farm)
          await shows(page, connectorRow.agentId)
          setRoutes(connectorRoutes({ 'GET /api/farms': rawFailure(503) }))
          await page.getByRole('button', { name: 'Atualizar farms' }).click()
          await heading(page, 'Inventário indisponível')
          expect(await page.getByText(connectorRow.agentId).count()).toBe(0)
          await expectNotStale(page)
          await expectNoRawText(page)
        },
      ))
  })

  describe('dispositivos states', { timeout: 30_000 }, () => {
    it('dispositivos: loading', () =>
      using(
        harness,
        'dispositivos',
        deviceRoutes({ 'GET /api/auth/me': hang }),
        async ({ page }) => {
          await expectLoading(page, 'Carregando farms e dispositivos…')
        },
      ))

    it('dispositivos: empty', () =>
      using(
        harness,
        'dispositivos',
        deviceRoutes({
          'GET /api/farms': farmPage(),
        }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Nenhuma farm disponível')
          expect(await skeletons(page).count()).toBe(0)
          setRoutes(
            deviceRoutes({ 'GET /api/browser-devices': deviceList([]) }),
          )
          await page.getByRole('button', { name: 'Atualizar farms' }).click()
          await page.locator('#device-farm').selectOption(farm)
          await heading(page, 'Nenhum dispositivo nesta página')
          await heading(page, 'Sem chaves neste navegador')
          await shows(page, 'Nenhuma chave local para esta conta e farm')
          await page
            .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
            .waitFor(WAIT)
        },
      ))

    it('dispositivos: error', () =>
      using(
        harness,
        'dispositivos',
        deviceRoutes({ 'GET /api/auth/me': rawFailure() }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Operação não confirmada')
          await shows(page, 'A operação não foi confirmada.')
          await expectNoRawText(page)
          setRoutes(deviceRoutes())
          await page.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.locator('#device-farm option', { hasText: farm }).waitFor({
            state: 'attached',
            ...WAIT,
          })
          expect(
            await page
              .getByRole('heading', { name: 'Operação não confirmada' })
              .count(),
          ).toBe(0)
        },
      ))

    it('dispositivos: stale', () =>
      // n/a by design: a failed refetch drops the registrations instead of
      // keeping them, because they are account-scoped authorization data.
      using(
        harness,
        'dispositivos',
        deviceRoutes(),
        async ({ page, setRoutes }) => {
          await page.locator('#device-farm option', { hasText: farm }).waitFor({
            state: 'attached',
            ...WAIT,
          })
          await page.locator('#device-farm').selectOption(farm)
          await shows(page, thumbprint)
          setRoutes(deviceRoutes({ 'GET /api/browser-devices': rawFailure() }))
          await page
            .getByRole('button', { name: 'Atualizar dispositivos' })
            .click()
          await heading(page, 'Operação não confirmada')
          expect(await page.getByText(thumbprint).count()).toBe(0)
          await expectNotStale(page)
          await expectNoRawText(page)
        },
      ))
  })

  describe('integracoes states', { timeout: 30_000 }, () => {
    it('integracoes: loading', () =>
      using(
        harness,
        'integracoes',
        integrationRoutes({
          [`GET /api/farms/${farm}/integrations/apps`]: hang,
        }),
        async ({ page }) => {
          await expectLoading(page, 'Carregando integrações…')
          expect(await page.getByText('Nenhum aplicativo').count()).toBe(0)
        },
      ))

    it('integracoes: empty', () =>
      using(
        harness,
        'integracoes',
        integrationRoutes({ 'GET /api/farms': farmPage() }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Nenhuma farm disponível')
          await page
            .getByRole('link', { name: 'Abrir a página da farm' })
            .waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
          setRoutes(
            integrationRoutes({
              [`GET /api/farms/${farm}/integrations/apps`]: reply({
                apps: [],
                printers: [],
              }),
            }),
          )
          await page.reload()
          await page.evaluate(() =>
            (window as unknown as { __mount: (n: string) => void }).__mount(
              'integracoes',
            ),
          )
          await heading(page, 'Nenhum aplicativo nesta farm')
          await page.getByLabel('Nome do aplicativo').waitFor(WAIT)
        },
      ))

    it('integracoes: error', () =>
      using(
        harness,
        'integracoes',
        integrationRoutes({
          [`GET /api/farms/${farm}/integrations/apps`]: rawFailure(),
        }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Integrações indisponíveis')
          await shows(page, 'Não foi possível carregar os aplicativos.')
          await expectNoRawText(page)
          expect(await page.getByText('Painel da oficina').count()).toBe(0)
          setRoutes(integrationRoutes())
          await page.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.getByText('Painel da oficina').waitFor(WAIT)
        },
      ))

    it('integracoes: stale', () =>
      // n/a by design: when switching farms fails, the previous farm's
      // applications are cleared; only the error state is shown.
      using(
        harness,
        'integracoes',
        integrationRoutes({
          'GET /api/farms': farmPage(farm, farm2),
          [`GET /api/farms/${farm2}/integrations/apps`]: rawFailure(),
        }),
        async ({ page }) => {
          await page.getByText('Painel da oficina').waitFor(WAIT)
          await page.locator('#integration-farm').selectOption(farm2)
          await heading(page, 'Integrações indisponíveis')
          expect(await page.getByText('Painel da oficina').count()).toBe(0)
          await expectNotStale(page)
          await expectNoRawText(page)
        },
      ))
  })

  describe('membros states', { timeout: 30_000 }, () => {
    it('membros: loading', () =>
      using(
        harness,
        'membros',
        memberRoutes({ [`GET /api/farms/${farm}/members`]: hang }),
        async ({ page }) => {
          await expectLoading(page, 'Carregando membros e convites…')
          expect(await page.getByText('Nenhum membro').count()).toBe(0)
        },
      ))

    it('membros: empty', () =>
      using(
        harness,
        'membros',
        memberRoutes({
          [`GET /api/farms/${farm}/members`]: reply({ members: [] }),
        }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Nenhum membro nesta farm')
          await heading(page, 'Nenhum convite pendente')
          await page
            .getByRole('link', { name: 'Convidar uma pessoa' })
            .waitFor(WAIT)
          await page
            .getByRole('link', { name: 'Gerar novo convite' })
            .waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
          setRoutes(memberRoutes({ 'GET /api/farms': farmPage() }))
          await page.reload()
          await page.evaluate(() =>
            (window as unknown as { __mount: (n: string) => void }).__mount(
              'membros',
            ),
          )
          await heading(page, 'Nenhuma farm disponível')
        },
      ))

    it('membros: error', () =>
      using(
        harness,
        'membros',
        memberRoutes({ [`GET /api/farms/${farm}/members`]: rawFailure() }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Membros indisponíveis')
          await shows(page, 'Não foi possível carregar membros e convites.')
          await expectNoRawText(page)
          expect(await page.getByText('Nenhum membro nesta farm').count()).toBe(
            0,
          )
          setRoutes(memberRoutes())
          await page.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.getByText('Admin', { exact: true }).waitFor(WAIT)
        },
      ))

    it('membros: stale', () =>
      // The change is saved but the reload fails: the old list stays, flagged.
      using(
        harness,
        'membros',
        memberRoutes({
          [`GET /api/farms/${farm}/members`]: ({ count }) =>
            count === 1
              ? {
                  status: 200,
                  body: {
                    members: [
                      {
                        accountId: 'admin-account',
                        username: 'Admin',
                        role: 'admin',
                      },
                    ],
                  },
                }
              : rawFailure(),
          [`POST /api/farms/${farm}/members/admin-account/remove`]: reply({}),
        }),
        async ({ page, setRoutes }) => {
          await page.getByRole('button', { name: 'Remover Admin' }).click()
          await page.getByLabel('Confirmei a remoção deste membro.').check()
          await page.getByRole('button', { name: 'Confirmar remoção' }).click()
          await page
            .getByRole('status')
            .filter({ hasText: 'Lista desatualizada' })
            .waitFor(WAIT)
          await page.getByText('Admin', { exact: true }).waitFor(WAIT)
          await expectNoRawText(page)
          setRoutes(
            memberRoutes({
              [`GET /api/farms/${farm}/members`]: reply({ members: [] }),
            }),
          )
          await page.getByRole('button', { name: 'Atualizar lista' }).click()
          await heading(page, 'Nenhum membro nesta farm')
          await expectNotStale(page)
        },
      ))
  })

  describe('convites states', { timeout: 30_000 }, () => {
    it('convites: loading', () =>
      using(
        harness,
        'convites',
        { 'GET /api/farms': hang },
        async ({ page }) => {
          await expectLoading(page, 'Carregando suas farms…')
          expect(
            await page.getByRole('button', { name: 'Criar convite' }).count(),
          ).toBe(0)
        },
      ))

    it('convites: empty', () =>
      using(
        harness,
        'convites',
        { 'GET /api/farms': farmPage() },
        async ({ page }) => {
          await heading(page, 'Nenhuma farm disponível')
          await page
            .getByRole('link', { name: 'Abrir a página da farm' })
            .waitFor(WAIT)
          expect(
            await page.getByRole('button', { name: 'Criar convite' }).count(),
          ).toBe(0)
          expect(await skeletons(page).count()).toBe(0)
        },
      ))

    it('convites: error', () =>
      using(
        harness,
        'convites',
        { 'GET /api/farms': rawFailure() },
        async ({ page, setRoutes }) => {
          await heading(page, 'Convites indisponíveis')
          await shows(page, 'Entre na sua conta para criar convites.')
          await expectNoRawText(page)
          setRoutes({ 'GET /api/farms': farmPage(farm) })
          await page.getByRole('button', { name: 'Tentar novamente' }).click()
          await page
            .getByRole('button', { name: 'Criar convite' })
            .waitFor(WAIT)
          expect(
            await page
              .getByRole('heading', { name: 'Convites indisponíveis' })
              .count(),
          ).toBe(0)
        },
      ))

    it('convites: stale', () =>
      // n/a by design: a form page keeps no cached data. A failed second
      // submit must not leave the previous one-time link on screen.
      using(
        harness,
        'convites',
        {
          'GET /api/farms': farmPage(farm),
          [`POST /api/farms/${farm}/invites`]: ({ count }) =>
            count === 1
              ? {
                  status: 200,
                  body: {
                    token: 'token-fixture',
                    expiresAt: '2030-01-01T00:00:00Z',
                  },
                }
              : rawFailure(),
        },
        async ({ page }) => {
          await page.getByRole('button', { name: 'Criar convite' }).click()
          await heading(page, 'Convite criado')
          await page.getByRole('button', { name: 'Criar convite' }).click()
          await shows(page, 'Não foi possível criar o convite agora.')
          expect(await page.locator('#invite-link').count()).toBe(0)
          await expectNotStale(page)
          await expectNoRawText(page)
        },
      ))
  })

  describe('parear states', { timeout: 30_000 }, () => {
    const pairingRoutes = (overrides: Routes = {}): Routes => ({
      'GET /api/connector-pairing/capability': reply({ enabled: true }),
      'GET /api/farms': farmPage(farm),
      ...overrides,
    })

    it('parear: loading', () =>
      using(
        harness,
        'parear',
        pairingRoutes({ 'GET /api/connector-pairing/capability': hang }),
        async ({ page }) => {
          await expectLoading(page, 'Carregando suas farms…')
          expect(await page.locator('#pairing-farm').count()).toBe(0)
        },
      ))

    it('parear: empty', () =>
      using(
        harness,
        'parear',
        pairingRoutes({ 'GET /api/farms': farmPage() }),
        async ({ page }) => {
          await heading(page, 'Nenhuma farm disponível')
          await page
            .getByRole('link', { name: 'Usar outra conta' })
            .waitFor(WAIT)
          expect(await page.locator('#pairing-farm').count()).toBe(0)
          expect(await skeletons(page).count()).toBe(0)
        },
      ))

    it('parear: error', () =>
      using(
        harness,
        'parear',
        pairingRoutes({
          'GET /api/connector-pairing/capability': rawFailure(),
        }),
        async ({ page, setRoutes }) => {
          await heading(page, 'Pareamento não concluído')
          await shows(page, 'Pareamento indisponível.')
          await expectNoRawText(page)
          setRoutes(pairingRoutes())
          await page
            .getByRole('button', { name: 'Recarregar formulário' })
            .click()
          await page
            .locator('#pairing-farm option', { hasText: farm })
            .waitFor({
              state: 'attached',
              ...WAIT,
            })
          expect(
            await page
              .getByRole('heading', { name: 'Pareamento não concluído' })
              .count(),
          ).toBe(0)
        },
      ))

    it('parear: stale', () =>
      // n/a by design: the approval form caches nothing. When the next farm
      // page fails, the farms already listed are cleared, not kept.
      using(
        harness,
        'parear',
        pairingRoutes({
          'GET /api/farms': ({ url }) =>
            url.searchParams.get('after')
              ? rawFailure()
              : reply({ farms: [{ farmId: farm }], nextAfter: nextCursor }),
        }),
        async ({ page }) => {
          await page
            .locator('#pairing-farm option', { hasText: farm })
            .waitFor({
              state: 'attached',
              ...WAIT,
            })
          await page
            .getByRole('button', { name: 'Próxima página de farms' })
            .click()
          await heading(page, 'Pareamento não concluído')
          expect(
            await page
              .locator('#pairing-farm option', { hasText: farm })
              .count(),
          ).toBe(0)
          await expectNotStale(page)
          await expectNoRawText(page)
        },
      ))
  })
}
