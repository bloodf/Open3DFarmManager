// SPDX-License-Identifier: AGPL-3.0-or-later
// Render and axe checks of the settings screens restyled by design-settings-b,
// in both sizes and themes, against synthetic in-process replies. With
// DESIGN_SCREENSHOTS=1 it also writes the comparison captures; DESIGN_PHASE
// names them "before" or "after". No printer or Connector is contacted.
import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

const farm = '00000000-0000-4000-8000-000000000001'
const agent = '7a1c3e90-0000-4000-8000-000000000002'
const secondAgent = 'b42f9d11-0000-4000-8000-000000000003'
const when = Date.UTC(2026, 10, 19, 12)
const WAIT = { timeout: 15_000 }

const farms = reply({ farms: [{ farmId: farm }], nextAfter: null })
const deviceList = (devices: unknown[]) =>
  reply({
    currentAccountId: 'account_fixture',
    currentRole: 'owner',
    devices,
    nextAfter: null,
    limits: {
      pendingLifetimeMs: 86_400_000,
      proofLifetimeMs: 60_000,
      maxChallengesPerKey: 3,
    },
  })
const device = (index: number, status: string, proofAt: number | null) => ({
  keyId: `55555555-5555-4555-8555-55555555555${index}`,
  accountId: `conta_${index}`,
  thumbprint: `${String(index).repeat(42)}A`,
  status,
  proofAt,
  createdAt: when,
  pendingExpiresAt: status === 'pending' ? when + 86_400_000 : null,
})
const connector = (agentId: string, status: string, fingerprint: string) => ({
  agentId,
  fingerprint,
  status,
})

type Screen = {
  name: string
  routes: () => Routes
  ready: (page: Page) => Promise<unknown>
}

const screens: Screen[] = [
  {
    name: 'spoolman',
    routes: () => ({
      'GET /api/farms': farms,
      'GET /api/browser-devices': deviceList([]),
      [`GET /api/farms/${farm}/connectors`]: reply({
        connectors: [connector(agent, 'approved', 'ab12')],
        nextAfter: null,
      }),
      [`GET /api/farms/${farm}/spoolman`]: reply({
        canManage: true,
        settings: [
          {
            agentId: agent,
            origin: 'http://192.168.1.60:7912',
            serviceId: '9f8b7c6d-1234-4abc-8def-0123456789ab',
            status: 'reachable',
            configured: true,
            checkedAt: when,
          },
          {
            agentId: secondAgent,
            origin: 'http://spoolman.oficina.lan:7912',
            serviceId: null,
            status: 'unauthorized',
            configured: false,
            checkedAt: when,
          },
        ],
      }),
    }),
    ready: (page) =>
      page.getByText('http://192.168.1.60:7912', { exact: true }).waitFor(WAIT),
  },
  {
    name: 'connectors',
    routes: () => ({
      'GET /api/farms': farms,
      'GET /api/connector-pairing/capability': reply({ enabled: true }),
      [`GET /api/farms/${farm}/connectors`]: reply({
        connectors: [
          connector(agent, 'approved', 'sha256:4f9a1c77e0b2d5a8'),
          connector(secondAgent, 'pending', 'sha256:c031be5a97d4f612'),
        ],
        nextAfter: null,
      }),
    }),
    ready: (page) => page.getByText(secondAgent).first().waitFor(WAIT),
  },
  {
    name: 'dispositivos',
    routes: () => ({
      'GET /api/auth/me': reply({ accountId: 'account_fixture' }),
      'GET /api/farms': farms,
      'GET /api/browser-devices': deviceList([
        device(1, 'pending', null),
        device(2, 'approved', when),
        device(3, 'revoked', when),
      ]),
    }),
    ready: (page) => page.getByText('conta_3').waitFor(WAIT),
  },
  {
    name: 'rede',
    routes: () => ({
      'GET /api/auth/me': reply({ accountId: 'account-one' }),
      'GET /api/farms': farms,
      'GET /api/browser-devices': reply({
        currentAccountId: 'account-one',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
      }),
      [`GET /api/farms/${farm}/printers`]: reply({
        printers: [],
        nextAfter: null,
        canManage: true,
      }),
      [`GET /api/farms/${farm}/printer-states`]: reply({ states: [] }),
      [`GET /api/farms/${farm}/status-summary`]: reply({
        generatedAt: Date.now(),
        total: 0,
        counts: {},
        truncated: false,
        printers: [],
      }),
      [`GET /api/farms/${farm}/network`]: reply({
        canManage: true,
        connectors: [
          {
            agentId: agent,
            fingerprint: 'ab12',
            status: 'approved',
            lastSeenAt: Date.now(),
            health: { version: '1.0.0', storage: 'healthy' },
          },
          {
            agentId: secondAgent,
            fingerprint: 'cd34',
            status: 'approved',
            lastSeenAt: Date.now() - 600_000,
            health: { version: '1.0.0', storage: 'healthy' },
          },
        ],
        printers: [
          {
            assignmentId: 'assignment-1',
            agentId: agent,
            printerKey: 'voron-24',
            displayName: 'Voron da bancada',
            link: {
              state: 'connected',
              lastSuccessAt: Date.now(),
              p50Ms: 20,
              p95Ms: 40,
            },
          },
        ],
        discovered: [
          {
            agentId: agent,
            vendor: 'moonraker',
            model: 'Ender 3',
            name: 'Impressora nova',
            adopted: false,
            lastSeen: Date.now(),
          },
        ],
      }),
    }),
    ready: (page) => page.getByText('Voron da bancada').first().waitFor(WAIT),
  },
  {
    name: 'compatibilidade',
    routes: () => ({}),
    ready: (page) =>
      page.getByRole('heading', { name: 'Modelos revisados' }).waitFor(WAIT),
  },
  {
    name: 'bambu-cloud',
    routes: () => ({
      'GET /api/farms': farms,
      [`GET /api/farms/${farm}/bambu-cloud`]: reply({
        connected: true,
        region: 'global',
        account: 'oficina@exemplo.test',
        expiresAt: new Date(when).toISOString(),
        expired: false,
        mqtt: null,
      }),
    }),
    ready: (page) =>
      page.getByRole('heading', { name: 'Conta conectada' }).waitFor(WAIT),
  },
]

const sizes = [
  ['desktop', 1440, 900],
  ['mobile', 390, 844],
] as const
const themes = ['light', 'dark'] as const

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

it.each(screens)(
  'renders /$name without overflow or axe violations in both sizes and themes',
  async ({ name, routes, ready }) => {
    for (const [size, width, height] of sizes)
      for (const theme of themes) {
        const opened = await harness.open(name, routes(), { width })
        try {
          const { page } = opened
          await page.setViewportSize({ width, height })
          await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: 'reduce',
          })
          await page.evaluate(
            (choice) =>
              document.documentElement.setAttribute('data-theme', choice),
            theme,
          )
          await ready(page)
          if (process.env.DESIGN_SCREENSHOTS === '1') {
            await mkdir('docs/fullfarmmanager/design', { recursive: true })
            const phase =
              process.env.DESIGN_PHASE === 'after' ? 'after' : 'before'
            await page.screenshot({
              path: `docs/fullfarmmanager/design/settings-b-${name}-${phase}-${size}-${theme}.png`,
            })
          }
          const label = `${name} ${size} ${theme}`
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
            label,
          ).toBe(width)
          expect(
            (await new AxeBuilder({ page }).analyze()).violations,
            label,
          ).toEqual([])
        } finally {
          await opened.close()
        }
      }
  },
  120_000,
)
