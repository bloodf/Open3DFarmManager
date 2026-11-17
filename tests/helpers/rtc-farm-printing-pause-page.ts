import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import type { ProvisionedSignallingFixture } from './signalling-https-fixture-contract.ts'
import { runPrintingPause, PAUSED_UI } from './rtc-farm-printing-pause.ts'

const Journal = z.array(
  z.object({
    cmd_id: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
  }),
)
const State = z.object({
  result: z.object({
    status: z.object({ print_stats: z.object({ state: z.string() }) }),
  }),
})

/** Explicitly admitted, task-owned infra/sim sv06 only. No hardware origins. */
export async function testPrintingPausePage(input: {
  fixture: ProvisionedSignallingFixture
  directory: string
  note(value: string): Promise<void>
}) {
  assert.equal(process.env.SIGNALLING_HTTPS_SIM_PRINTING_PAUSE, 'sv06')
  const origin = process.env.SIGNALLING_HTTPS_SIM_MOONRAKER!
  const url = new URL(origin)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.protocol, 'http:')
  // Prove the target is the explicitly supplied infra/sim sv06 container,
  // rather than trusting a loopback origin (which may front real hardware).
  const container = process.env.SIGNALLING_HTTPS_SIM_CONTAINER ?? ''
  assert.match(
    container,
    /^[a-f0-9]{64}$/,
    'Explicit task-owned simulator container ID required',
  )
  const inspected = await promisify(execFile)(
    'docker',
    ['inspect', container],
    { timeout: 10000 },
  )
  const metadata = z
    .array(
      z.object({
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        NetworkSettings: z.object({
          Ports: z.record(
            z.string(),
            z
              .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
              .nullable(),
          ),
        }),
      }),
    )
    .parse(JSON.parse(inspected.stdout))[0]!
  assert.equal(metadata.Config.Labels['com.docker.compose.service'], 'sv06')
  assert.ok(
    metadata.Config.Labels['com.docker.compose.project.config_files']
      ?.split(',')
      .some((path) => path.endsWith('/infra/sim/docker-compose.yml')),
  )
  assert.ok(
    metadata.NetworkSettings.Ports['7125/tcp']?.some(
      (binding) =>
        binding.HostIp === '127.0.0.1' && binding.HostPort === url.port,
    ),
    'Origin must be the sv06 published loopback port',
  )
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(origin + path, {
      ...init,
      signal: AbortSignal.timeout(10000),
    })
    assert.ok(response.ok, `${path}: HTTP ${response.status}`)
    return response.json()
  }
  const state = async () =>
    State.parse(await request('/printer/objects/query?print_stats=state'))
      .result.status.print_stats.state
  const journal = () => {
    const db = new DatabaseSync(
      join(input.directory, 'data/pause-journal/pause-commands.sqlite'),
      { readOnly: true },
    )
    try {
      return Journal.parse(
        db
          .prepare(
            'SELECT cmd_id,status,reason FROM pause_commands ORDER BY claimed_at,cmd_id',
          )
          .all(),
      )
    } finally {
      db.close()
    }
  }
  const page = await input.fixture.ownerContext.newPage()
  const filename = 'o3dfm-accept-pause-' + randomUUID() + '.gcode'
  let uploaded = false
  const abort = () => {
    void page.close().catch(() => {})
  }
  input.fixture.signal.addEventListener('abort', abort, { once: true })
  try {
    await runPrintingPause({
      async start() {
        assert.ok(
          ['standby', 'complete', 'cancelled'].includes(await state()),
          'Owned simulator must be idle',
        )
        const form = new FormData()
        form.set('root', 'gcodes')
        // No heating or movement. Long enough to keep printing through admission.
        form.set(
          'file',
          new Blob(['; acceptance pause\n' + 'G4 P1000\n'.repeat(600)]),
          filename,
        )
        await request('/server/files/upload', { method: 'POST', body: form })
        uploaded = true
        await request(
          '/printer/print/start?filename=' + encodeURIComponent(filename),
          { method: 'POST' },
        )
        await expect.poll(state, { timeout: 15000 }).toBe('printing')
        await page.goto(input.fixture.origin + '/farm', {
          waitUntil: 'domcontentloaded',
        })
      },
      async confirm() {
        const assignment = input.fixture.assignmentRefs[0]!
        const row = page.getByRole('article').filter({
          has: page.getByRole('heading', {
            name: assignment.printerKey,
            exact: true,
          }),
        })
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 15000 })
        const button = row.getByRole('button', {
          name: 'Pausar impressão',
          exact: true,
        })
        await expect(button).toBeEnabled()
        await button.click()
        const dialog = page.getByRole('dialog', {
          name: /^Pausar impressão de/,
        })
        await expect(dialog.getByRole('status')).toHaveText(
          /^Autorização pronta\./,
          { timeout: 20000 },
        )
        assert.deepEqual(journal(), [])
        await dialog
          .getByRole('button', { name: 'Confirmar pausa', exact: true })
          .click()
        // Poll only state/UI reads; no automatic second confirmation on failure.
        await expect(dialog.getByRole('status')).toHaveText(PAUSED_UI, {
          timeout: 10000,
        })
        await expect(row.getByText('Pausada', { exact: true })).toBeVisible()
        await expect(button).toBeDisabled()
        await expect.poll(state).toBe('paused')
      },
      async observe() {
        return {
          klipper: await state(),
          journal: journal(),
          ui: await page.getByRole('dialog').getByRole('status').innerText(),
        }
      },
      async resume() {
        await request('/printer/print/resume', { method: 'POST' })
      },
      async resumed() {
        await expect.poll(state, { timeout: 10000 }).toBe('printing')
        const row = page.getByRole('article').filter({
          has: page.getByRole('heading', {
            name: input.fixture.assignmentRefs[0]!.printerKey,
            exact: true,
          }),
        })
        await expect(row.getByText('Imprimindo', { exact: true })).toBeVisible()
        await page.waitForTimeout(2000)
      },
      note: input.note,
    })
  } finally {
    // Cancel only this row's uniquely named file, even after uncertain pause.
    // A cleanup request is never a retry of the signed pause.
    try {
      if (uploaded) {
        const current = z
          .object({
            result: z.object({
              status: z.object({
                print_stats: z.object({
                  filename: z.string(),
                  state: z.string(),
                }),
              }),
            }),
          })
          .parse(await request('/printer/objects/query?print_stats'))
        if (
          current.result.status.print_stats.filename === filename &&
          ['printing', 'paused'].includes(
            current.result.status.print_stats.state,
          )
        )
          await request('/printer/print/cancel', { method: 'POST' })
        // Moonraker can keep the virtual SD file open briefly after cancel.
        // Retry only deletion of our file, never a printer command.
        await expect
          .poll(
            async () => {
              const response = await fetch(
                origin + '/server/files/gcodes/' + filename,
                { method: 'DELETE', signal: AbortSignal.timeout(10000) },
              )
              if (response.status === 403) return false
              assert.ok(
                response.ok,
                `Owned file cleanup: HTTP ${response.status}`,
              )
              return true
            },
            { timeout: 10000 },
          )
          .toBe(true)
      }
    } finally {
      input.fixture.signal.removeEventListener('abort', abort)
      await page.close()
    }
  }
}
