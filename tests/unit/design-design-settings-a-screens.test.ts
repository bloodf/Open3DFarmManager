// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

// Account, members, invites, integrations and admin screens inside the shell,
// against synthetic replies. Normal runs assert render, width and axe;
// DESIGN_SCREENSHOTS=1 also writes the evidence PNGs.
const farm = '00000000-0000-4000-8000-0000000000f1'
const appId = '00000000-0000-4000-8000-0000000000e1'
const revokedId = '00000000-0000-4000-8000-0000000000e2'
const assignmentId = '00000000-0000-4000-8000-0000000000b1'
const expiresAt = '2030-01-01T12:00:00.000Z'

const base: Routes = {
  'GET /api/auth/me': reply({ accountId: 'conta-sintetica' }),
  'GET /api/farms': reply({ farms: [{ farmId: farm }], nextAfter: null }),
  'GET /api/browser-devices': reply({ currentRole: 'owner' }),
}

type Screen = {
  name: string
  page: string
  path: string
  routes: Routes
  /** Brings the screen to the state worth capturing. */
  ready: (page: Page) => Promise<void>
}

const heading = (page: Page, name: string) =>
  page.getByRole('heading', { name, exact: true }).waitFor()

const screens: Screen[] = [
  {
    name: 'conta',
    page: 'conta',
    path: '/conta',
    routes: {
      'GET /api/auth/identities': reply({
        google: { available: true, linked: true, canUnlink: true },
      }),
    },
    ready: async (page) => {
      await page.getByRole('button', { name: 'Desvincular Google' }).waitFor()
    },
  },
  {
    name: 'membros',
    page: 'membros',
    path: '/membros',
    routes: {
      [`GET /api/farms/${farm}/members`]: reply({
        members: [
          { accountId: 'owner-account', username: 'Dona', role: 'owner' },
          { accountId: 'admin-account', username: 'Admin', role: 'admin' },
          {
            accountId: 'viewer-account',
            username: `pessoa-com-um-nome-muito-longo-${'x'.repeat(40)}`,
            role: 'viewer',
          },
        ],
      }),
      [`GET /api/farms/${farm}/invites`]: reply({
        invites: [
          {
            id: 'invite-1',
            role: 'operator',
            createdAt: '2026-01-01T12:00:00.000Z',
            expiresAt,
            status: 'pending',
          },
        ],
      }),
    },
    ready: (page) => heading(page, 'Convites pendentes'),
  },
  {
    name: 'convites',
    page: 'convites',
    path: '/convites',
    routes: {
      [`POST /api/farms/${farm}/invites`]: reply({
        token: 'codigo-sintetico-de-convite',
        expiresAt,
      }),
    },
    ready: async (page) => {
      await page.getByRole('button', { name: 'Criar convite' }).click()
      await heading(page, 'Convite criado')
      await page.evaluate(() => (document.activeElement as HTMLElement).blur())
      await page.mouse.move(0, 0)
    },
  },
  {
    name: 'integracoes',
    page: 'integracoes',
    path: '/integracoes',
    routes: {
      [`GET /api/farms/${farm}/integrations/apps`]: reply({
        apps: [
          {
            id: appId,
            name: 'Painel da oficina',
            sandbox: false,
            createdAt: 1000,
            revokedAt: null,
          },
          {
            id: revokedId,
            name: 'Integração antiga',
            sandbox: false,
            createdAt: 1000,
            revokedAt: 2000,
          },
        ],
        printers: [{ assignmentId, printerKey: 'ender-da-bancada' }],
      }),
      [`GET /api/farms/${farm}/integrations/apps/${appId}/grants`]: reply({
        grants: [
          {
            id: 'grant-1',
            appId,
            farmId: farm,
            printerAssignmentId: assignmentId,
            scopes: ['printers:read', 'jobs:read'],
            requiresApproval: true,
          },
        ],
      }),
      [`GET /api/farms/${farm}/integrations/apps/${revokedId}/grants`]: reply({
        grants: [],
      }),
    },
    ready: (page) => heading(page, 'Painel da oficina'),
  },
  {
    name: 'provedores-entrada',
    page: 'admin/provedores-entrada',
    path: '/admin/provedores-entrada',
    routes: {
      'GET /api/admin/sign-in-providers': reply({
        providers: [
          {
            id: 'google',
            enabled: true,
            clientId: '1234567890-exemplo.apps.googleusercontent.com',
            hasClientSecret: true,
            redirectUri: 'https://farm.example/api/auth/google/callback',
            issuer: 'https://accounts.google.com',
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
            emailVerifiedRequired: true,
          },
        ],
      }),
    },
    ready: (page) => heading(page, 'Google'),
  },
]

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 120_000)
afterAll(async () => {
  await harness?.close()
})

it.each(screens)(
  '$name renders without page overflow or axe violations',
  async (screen) => {
    for (const size of sizes)
      for (const theme of ['light', 'dark'] as const) {
        const opened = await harness.open(
          screen.page,
          { ...base, ...screen.routes },
          {
            layout: true,
            width: size.width,
            route: { path: screen.path, query: { farm } },
          },
        )
        try {
          const { page } = opened
          await page.setViewportSize(size)
          await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: 'reduce',
          })
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme
          }, theme)
          await screen.ready(page)
          expect(await page.locator('#conteudo h1').count()).toBe(1)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
            `${size.name} ${theme}`,
          ).toBeLessThanOrEqual(size.width)
          expect(
            (await new AxeBuilder({ page }).include('#conteudo').analyze())
              .violations,
            `${size.name} ${theme}`,
          ).toEqual([])
          if (process.env.DESIGN_SCREENSHOTS === '1') {
            await mkdir('docs/fullfarmmanager/design', { recursive: true })
            await page.screenshot({
              path: `docs/fullfarmmanager/design/settings-a-${screen.name}-${process.env.DESIGN_PHASE ?? 'after'}-${size.name}-${theme}.png`,
              fullPage: true,
            })
          }
        } finally {
          await opened.close()
        }
      }
  },
  120_000,
)
