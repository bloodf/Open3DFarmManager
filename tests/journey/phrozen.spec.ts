import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openFarmInspector } from '../helpers/farm-inspector.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import { provisionPhrozenPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import {
  PHROZEN_QUALIFIED_WRITES,
  PHROZEN_START_MESSAGE,
  type PhrozenQualification,
} from '../../packages/connector/src/phrozen/qualification.ts'
import { uploadFile } from '../../packages/connector/src/runtime/file-upload.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import data from '../fixtures/phrozen/synthetic-revo-14k-v153.json' with { type: 'json' }
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { statusJourney } from './status-journey.ts'
import type { startStatusFixture } from './status-fixtures.ts'

// Simulator only: synthetic state, never a physical printer. The shipped write
// qualification list is empty; QUALIFIED exists only in this test.
const MODEL = 'Sonic Mighty Revo 14K'
const QUALIFIED: PhrozenQualification[] = [
  { model: MODEL, firmwareVersion: 'V153' },
]
/** SDCP start, pause, stop, resume and video; upload is HTTP. */
const WRITES = [128, 129, 130, 131, 386]

// Shipped list: status only, with no control offered anywhere.
statusJourney('phrozen')

if (journeyEnabled()) {
  test('phrozen: file transfer needs a qualified pair, and start is always refused', async () => {
    expect(PHROZEN_QUALIFIED_WRITES).toEqual([])
    const simulator = await startPhrozenSimulator(structuredClone(data))
    simulator.reset()
    const directory = await mkdtemp(join(tmpdir(), 'journey-phrozen-file-'))
    try {
      const filePath = join(directory, 'staged')
      await writeFile(filePath, 'synthetic sliced file')
      const binding = provisionPhrozenPrinter(
        {
          assignment_id: crypto.randomUUID(),
          farm_id: crypto.randomUUID(),
          agent_id: crypto.randomUUID(),
          printer_key: 'revo',
        },
        {
          family: 'phrozen',
          printerKey: 'revo',
          origin: `ws://127.0.0.1:${simulator.wsPort}`,
          discoveryPort: simulator.udpPort,
          simulated: true,
          expect: {
            id: data.Id,
            board: data.Data.MainboardID,
            model: MODEL,
            firmware: 'V153',
          },
        },
      )
      const upload = (
        qualifiedWrites: PhrozenQualification[] | undefined,
        authorized = true,
      ) =>
        uploadFile({
          target: { backend: 'phrozen', binding, qualifiedWrites },
          filePath,
          name: 'part.ctb',
          signal: new AbortController().signal,
          authorize: () => authorized,
          standalone: true,
        })

      for (const unqualified of [
        undefined,
        [{ model: MODEL, firmwareVersion: 'V138' }],
        [{ model: 'Sonic Mighty Revo 16K', firmwareVersion: 'V153' }],
      ])
        await expect(upload(unqualified)).rejects.toThrow('unsupported')
      await expect(upload(QUALIFIED, false)).rejects.toThrow('unauthorized')
      expect(simulator.state().uploads).toEqual([])
      expect(simulator.commands).toEqual([])

      const routes = createPauseDriverRouter({
        allowedOrigins: [],
        limits: {} as never,
        clock: { monotonicNow: () => performance.now() },
        observe: () => true,
        phrozenQualifiedWrites: QUALIFIED,
      })
      const signal = new AbortController().signal
      await routes.prepare({ binding, signal })
      await expect(
        routes.execute(
          'start_print',
          { file: 'part.ctb' },
          { binding, signal, beforeSend: () => true },
        ),
      ).rejects.toMatchObject({ userMessage: PHROZEN_START_MESSAGE })
      await routes.closeAttempt(binding)

      await upload(QUALIFIED)
      expect(await readFile(filePath)).toEqual(
        simulator.state().files.get('part.ctb'),
      )
      // Never overwrites, and says so before any byte leaves.
      await expect(upload(QUALIFIED)).rejects.toBeInstanceOf(DriverRefusalError)
      expect(simulator.state().uploads).toHaveLength(1)
      expect(simulator.commands.filter((cmd) => WRITES.includes(cmd))).toEqual(
        [],
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
      await simulator.close()
    }
  })

  test('phrozen: a qualified pair accepts signed pause, resume and cancel', async ({
    browser,
  }) => {
    test.setTimeout(15 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'phrozen',
      signedControl: true,
      // The server issues authority from the controls telemetry advertises.
      history: true,
      connectorEntry: new URL(
        '../helpers/phrozen-qualified-connector.ts',
        import.meta.url,
      ),
    })
    try {
      const { simulator } = journey.vendor?.raw as Extract<
        Awaited<ReturnType<typeof startStatusFixture>>,
        { simulator: unknown }
      >
      const info = () =>
        simulator.state().status.PrintInfo as Record<string, unknown>
      const writes = () =>
        simulator.commands.filter((cmd) => WRITES.includes(cmd))
      simulator.beginPrint('part.ctb')

      const page = journey.ownerPage
      const dialog = page.locator(
        'dialog[aria-labelledby="pause-dialog-title"]',
      )
      const card = () =>
        page
          .getByRole('dialog', { name: 'Inspeção da impressora', exact: true })
          .getByRole('article')
          .filter({
            has: page.getByRole('heading', { name: journey.printerKey }),
          })
      const openCard = async () => {
        await journey.openFarm(page)
        await openFarmInspector(page, journey.printerKey)
      }
      await openCard()

      /**
       * Opens a command dialog, confirms it and returns its settled text. An
       * authorization that never reached the printer is asked again, as a
       * person would; a sent command is never repeated.
       */
      let inboxesUsed = 0
      async function command(open: () => Promise<void>, confirm: string) {
        const status = dialog.getByRole('status')
        let last = ''
        for (let attempt = 0; attempt < 10; attempt++) {
          await expect
            .poll(
              () => {
                const seen = journey.simulatorObservation()
                return seen.pauseInboxReady && seen.pauseInboxes > inboxesUsed
              },
              { timeout: 45_000 },
            )
            .toBe(true)
            .catch(() => {})
          try {
            await open()
            await expect(dialog).toBeVisible({ timeout: 5000 })
          } catch {
            await openCard()
            continue
          }
          const button = dialog.getByRole('button', {
            name: confirm,
            exact: true,
          })
          const ready = await expect(button)
            .toBeEnabled({ timeout: 45_000 })
            .then(
              () => true,
              () => false,
            )
          if (ready) {
            inboxesUsed = journey.simulatorObservation().pauseInboxes
            await button.click()
            await expect(
              dialog.getByRole('button', { name: 'Fechar', exact: true }),
            ).toBeVisible({ timeout: 60_000 })
          }
          last = (await status.innerText()).trim()
          await dialog
            .getByRole('button', { name: /^(Fechar|Cancelar)$/ })
            .click()
          await expect(dialog).toBeHidden()
          // Only an outcome that says nothing was sent is asked again.
          if (ready && !/Nenhum comando foi enviado/.test(last)) return last
        }
        throw new Error('Command was never settled: ' + last)
      }
      const lifecycle = (label: string, confirm: string) => {
        const button = () =>
          card()
            .getByRole('group', {
              name: 'Controles da impressora ' + journey.printerKey,
            })
            .getByRole('button', { name: label, exact: true })
        return command(async () => {
          await expect(button()).toHaveAttribute('aria-disabled', 'false', {
            timeout: 60_000,
          })
          await button().click({ timeout: 5000 })
        }, confirm)
      }

      expect(await lifecycle('Pausar', 'Confirmar pausa')).toContain(
        'confirmou',
      )
      expect(info().Status).toBe(6)
      expect(writes()).toEqual([129])

      expect(await lifecycle('Retomar', 'Confirmar retomada')).toContain(
        'confirmou',
      )
      expect([2, 3, 4]).toContain(info().Status)
      expect(writes()).toEqual([129, 131])

      expect(await lifecycle('Cancelar', 'Confirmar cancelamento')).toContain(
        'confirmou',
      )
      expect(info().Status).toBe(8)
      expect(writes()).toEqual([129, 131, 130])

      // The page offers no start: resin detail has no start form, and the
      // Connector would refuse one (test above).
      await expect(card()).toBeVisible()
      await expect(
        card().getByRole('button', { name: /iniciar impressão/i }),
      ).toHaveCount(0)
    } finally {
      await journey.close()
    }
  })
}
