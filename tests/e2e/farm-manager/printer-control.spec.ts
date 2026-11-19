// E18 journey (#411): full Moonraker control on the E16 mock, from the printer
// detail page, through the signed Connector session. Mocks only, on loopback.
import type { Locator, Page } from '@playwright/test'
import type { MoonrakerSimulator } from '../../journey/moonraker-simulator.ts'
import { expect, test, type FarmManager } from './fixtures.ts'

const KEY = 'ctl-moon'
const CONFIRMED = 'Comando confirmado pelo Connector.'
// A refusal by the Connector wrote nothing: shown as "not sent".
const NOT_SENT = 'Comando não enviado.'
const UNKNOWN =
  'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'
// Moonraker extended actions carry no state effect the Connector can read back,
// so an acknowledged send settles as "unknown" (see control-extrude.test.ts).
const SENT = new RegExp(`^(${CONFIRMED}|${UNKNOWN})$`.replaceAll('.', '\\.'))

const SQUARE = (x: number, y: number) =>
  [
    [x - 10, y - 10],
    [x + 10, y - 10],
    [x + 10, y + 10],
    [x - 10, y + 10],
  ] as const
const MESH = (base: number) =>
  Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (_, col) => base + row * 0.01 - col * 0.005),
  )

const FULL_MOCK = {
  macros: ['PURGE_FILAMENT', 'PARK_HEAD'],
  configfileConfig: {
    'gcode_macro PURGE_FILAMENT': {
      gcode:
        'G1 E{params.LENGTH|default(20)} F{params.SPEED|default(300)}\nM117 {params.MSG}',
    },
    'gcode_macro PARK_HEAD': { gcode: 'G28 X Y' },
  },
  files: [
    { path: 'cubo.gcode', content: 'G28\nG1 X10\n' },
    { path: 'pecas/suporte.gcode', content: 'G28\n' },
  ],
  directories: [{ path: 'pecas' }],
  configFiles: [
    { path: 'printer.cfg', content: '[printer]\nkinematics: cartesian\n' },
  ],
  powerDevices: [{ device: 'Fonte', status: 'on' as const }],
  excludeObjects: [
    { name: 'cubo_1', center: [60, 60] as const, polygon: SQUARE(60, 60) },
    { name: 'cubo_2', center: [140, 60] as const, polygon: SQUARE(140, 60) },
  ],
  bedMeshProfiles: [
    { name: 'default', points: MESH(0.1) },
    { name: 'frio', points: MESH(-0.05) },
  ],
  activeMesh: 'default',
}

function simulator(farm: FarmManager) {
  return farm.printers[0]!.mock as MoonrakerSimulator
}

async function openDetail(farm: FarmManager, page: Page = farm.owner) {
  await farm.openFarm(page)
  await farm
    .printerCard(KEY, page)
    .getByRole('link', { name: /Abrir detalhes da impressora/ })
    .click()
  await expect(
    page.getByRole('heading', { name: KEY, exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Connector: conexão direta ativa', { exact: true }),
  ).toBeVisible({ timeout: 60_000 })
}

/** Every signed or file session needs the Connector's inbox listening. */
async function inboxReady(farm: FarmManager) {
  await expect
    .poll(() => farm.harness.simulatorObservation().pauseInboxReady, {
      timeout: 90_000,
    })
    .toBe(true)
}

/**
 * A session consumes the inbox; it is usable again only after a new listen
 * that started after the session did (a stale "ready" is not enough).
 */
async function inboxRearmed(farm: FarmManager, listensBefore: number) {
  await expect
    .poll(
      () => {
        const seen = farm.harness.simulatorObservation()
        return seen.pauseInboxReady && seen.pauseInboxes > listensBefore
      },
      { timeout: 90_000 },
    )
    .toBe(true)
}
const listens = (farm: FarmManager) =>
  farm.harness.simulatorObservation().pauseInboxes

/**
 * Clicks a control that opens a read session (file list, config files) and
 * waits for its result; repeated when the session closed before it was ready.
 */
async function readSession(farm: FarmManager, trigger: Locator, done: Locator) {
  for (let attempt = 1; ; attempt++) {
    await inboxReady(farm)
    const before = listens(farm)
    await trigger.click()
    try {
      await expect(done).toBeAttached({ timeout: 45_000 })
      await inboxRearmed(farm, before)
      return
    } catch (error) {
      if (attempt >= 3) throw error
    }
  }
}

/**
 * Click, confirm in the dialog, wait for the outcome, close the dialog. Every
 * command opens its own signed session, so the Connector's inbox must be
 * listening again first; a session that closed before it was ready is a
 * refusal to send (nothing reached the printer) and the click is repeated.
 */
async function command(
  farm: FarmManager,
  trigger: Locator,
  outcome: string | RegExp = SENT,
  /** Runs before every click (a form that clears itself on submit). */
  prepare: () => Promise<void> = async () => {},
) {
  const page = trigger.page()
  const dialog = page.getByRole('dialog')
  const confirm = dialog.getByRole('button', { name: 'Confirmar comando' })
  for (let attempt = 1; ; attempt++) {
    await inboxReady(farm)
    await expect(trigger).toBeEnabled({ timeout: 90_000 })
    await prepare()
    await trigger.click()
    // Ready, or a session that closed before it was ready ("nothing was sent").
    await expect
      .poll(
        async () => {
          if (!(await dialog.isVisible())) return 'waiting'
          if (await confirm.isEnabled()) return 'ready'
          const text = await dialog.getByRole('status').innerText()
          return text.includes('Nenhum comando foi enviado')
            ? 'closed'
            : 'waiting'
        },
        { timeout: 90_000 },
      )
      .not.toBe('waiting')
    if (await confirm.isEnabled()) break
    if (attempt >= 3) throw new Error('A sessão de comando fechou três vezes')
    await dialog.getByRole('button', { name: /^(Cancelar|Fechar)$/ }).click()
    await expect(dialog).toBeHidden()
  }
  const before = listens(farm)
  await confirm.click()
  await expect(dialog.getByRole('status')).toHaveText(outcome, {
    timeout: 60_000,
  })
  await dialog.getByRole('button', { name: 'Fechar' }).click()
  await expect(dialog).toBeHidden()
  await inboxRearmed(farm, before)
}

const ACTION_MS = 90_000

function scripts(farm: FarmManager) {
  return simulator(farm).control.gcodeScripts
}
function configFiles(farm: FarmManager) {
  return [...simulator(farm).control.files.values()].filter(
    (file) => file.root === 'config',
  )
}
async function stillLive(page: Page, step: string) {
  await expect(
    page.getByText('Connector: conexão direta ativa', { exact: true }),
    `conexão direta após: ${step}`,
  ).toBeVisible({ timeout: 90_000 })
}
async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click()
}

test('controle Moonraker no mock (1/2): temperatura, movimento, extrusão, macro, console, arquivos e fila', async ({
  bootFarm,
}) => {
  const farm = await bootFarm({
    printers: [{ family: 'moonraker', printerKey: KEY }],
    signedControl: true,
    consoleEnabled: true,
    moonraker: {
      initial: { state: 'standby', progress: 0, filename: '', extruder: 210 },
      mock: FULL_MOCK,
    },
  })
  const page = farm.owner
  page.setDefaultTimeout(ACTION_MS)
  const mock = simulator(farm)
  try {
    await openDetail(farm)

    await test.step('temperaturas', async () => {
      await page.getByLabel('Nova temperatura de Bico (°C)').fill('200')
      await command(farm, page.getByRole('button', { name: 'Definir Bico' }))
      await expect.poll(() => mock.control.model().extruderTarget).toBe(200)
      await page.getByLabel('Nova temperatura de Mesa (°C)').fill('60')
      await command(farm, page.getByRole('button', { name: 'Definir Mesa' }))
      await expect.poll(() => mock.control.model().bedTarget).toBe(60)
      // Above the printer's limit the browser refuses the form: nothing above
      // the limit is ever offered for signing (the Connector also refuses it).
      const nozzle = page.getByLabel('Nova temperatura de Bico (°C)')
      await nozzle.fill('400')
      await expect(nozzle).toHaveAttribute('max', '300')
      await page.getByRole('button', { name: 'Definir Bico' }).click()
      expect(
        await nozzle.evaluate(
          (el: HTMLInputElement) => el.validity.rangeOverflow,
        ),
      ).toBe(true)
      await expect(page.getByRole('dialog')).toBeHidden()
      expect(mock.control.model().extruderTarget).toBe(200)
      await stillLive(page, 'temperaturas')
    })

    await test.step('movimento e extrusão', async () => {
      await command(farm, page.getByRole('button', { name: /^X\+: mover/ }))
      await expect
        .poll(() => scripts(farm).some((line) => /G1[^\n]*X/.test(line)))
        .toBe(true)
      await command(farm, page.getByRole('button', { name: 'Extrudar' }))
      await expect
        .poll(() => scripts(farm).some((line) => line.includes('M83')))
        .toBe(true)
      await stillLive(page, 'movimento e extrusão')
    })

    await test.step('macro com parâmetros', async () => {
      await page.getByLabel('LENGTH', { exact: true }).fill('25')
      await command(
        farm,
        page.getByRole('button', { name: 'Executar PURGE_FILAMENT' }),
      )
      await expect
        .poll(() =>
          mock.control.macroCalls.some(
            ({ script }) =>
              script.includes('PURGE_FILAMENT') && script.includes('LENGTH=25'),
          ),
        )
        .toBe(true)
      await stillLive(page, 'macro com parâmetros')
    })

    await test.step('console G-code', async () => {
      await tab(page, 'Console')
      await command(
        farm,
        page.getByRole('button', { name: 'Enviar', exact: true }),
        SENT,
        () => page.getByLabel('Comando G-code').fill('M105'),
      )
      await expect(
        page.getByRole('log', { name: 'Saída do console' }),
      ).toContainText('> M105')
      await expect.poll(() => scripts(farm)).toContain('M105')
      await stillLive(page, 'console G-code')
    })

    await test.step('arquivos', async () => {
      await tab(page, 'Arquivos')
      await readSession(
        farm,
        page.getByRole('button', { name: 'Atualizar arquivos' }),
        page.getByText('Arquivos atualizados.'),
      )
      await expect(page.getByText('cubo.gcode', { exact: false })).toBeVisible()
      await page.getByLabel('Nome da nova pasta').fill('novos')
      await command(farm, page.getByRole('button', { name: 'Criar pasta' }))
      await expect
        .poll(() =>
          [...mock.control.directories].some((d) => d.endsWith('novos')),
        )
        .toBe(true)
      await page.getByRole('radio', { name: /cubo\.gcode/ }).check()
      await command(farm, page.getByRole('button', { name: 'Excluir arquivo' }))
      await expect
        .poll(() =>
          [...mock.control.files.values()].some(
            (file) => file.root === 'gcodes' && file.path === 'cubo.gcode',
          ),
        )
        .toBe(false)
      await stillLive(page, 'arquivos')
    })

    await test.step('fila', async () => {
      await tab(page, 'Fila')
      await page.getByLabel('Arquivos a adicionar').fill('pecas/suporte.gcode')
      await command(
        farm,
        page.getByRole('button', { name: 'Adicionar à fila' }),
      )
      await expect.poll(() => mock.control.jobQueue.jobs.length).toBe(1)
      await expect(
        page.getByRole('list', { name: 'Trabalhos na fila' }),
      ).toContainText('suporte.gcode', { timeout: 30_000 })
      await command(
        farm,
        page.getByRole('button', { name: /^Remover .* da fila$/ }),
      )
      await expect.poll(() => mock.control.jobQueue.jobs.length).toBe(0)
      await stillLive(page, 'fila')
    })

    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})

test('controle Moonraker no mock (2/2): malha, configuração, energia, reinício e impressão em andamento', async ({
  bootFarm,
}) => {
  const farm = await bootFarm({
    printers: [{ family: 'moonraker', printerKey: KEY }],
    signedControl: true,
    consoleEnabled: true,
    moonraker: {
      initial: { state: 'standby', progress: 0, filename: '', extruder: 210 },
      mock: FULL_MOCK,
    },
  })
  const page = farm.owner
  page.setDefaultTimeout(ACTION_MS)
  const mock = simulator(farm)
  try {
    await openDetail(farm)

    await test.step('malha e mapa de altura', async () => {
      await tab(page, 'Malha')
      await expect(
        page.getByRole('img', {
          name: 'Mapa de altura tridimensional da malha da mesa',
        }),
      ).toBeVisible()
      await page.getByLabel('Perfis salvos').selectOption('frio')
      await command(farm, page.getByRole('button', { name: 'Carregar perfil' }))
      await expect
        .poll(() =>
          scripts(farm).some((line) =>
            /BED_MESH_PROFILE\s+LOAD=frio/i.test(line),
          ),
        )
        .toBe(true)
      await stillLive(page, 'malha e mapa de altura')
    })

    await test.step('configuração com cópia de segurança', async () => {
      await tab(page, 'Configuração')
      const files = page.getByLabel('Arquivo de configuração')
      await readSession(
        farm,
        page.getByRole('button', { name: 'Listar arquivos' }),
        files.getByRole('option', { name: 'printer.cfg' }),
      )
      const editor = page.getByLabel('Conteúdo do arquivo')
      // Choosing a file opens it; "Abrir arquivo" appears only when that failed.
      await inboxReady(farm)
      const beforeOpen = listens(farm)
      await files.selectOption('printer.cfg')
      try {
        await expect(editor).toBeAttached({ timeout: 45_000 })
        await inboxRearmed(farm, beforeOpen)
      } catch {
        await readSession(
          farm,
          page.getByRole('button', { name: 'Abrir arquivo' }),
          editor,
        )
      }
      await editor.fill('[printer]\nkinematics: cartesian\n# editado\n')
      // The Connector refuses a write whose last state reading went stale
      // while it checked the file (nothing is written); the editor stays open
      // and the same save is offered again.
      const saved = () =>
        configFiles(farm).some((file) =>
          file.content.toString().includes('# editado'),
        )
      let beforeSave = 0
      for (let attempt = 1; !saved(); attempt++) {
        if (attempt > 3) throw new Error('A gravação foi recusada três vezes')
        await inboxReady(farm)
        beforeSave = listens(farm)
        await page.getByRole('button', { name: 'Salvar', exact: true }).click()
        await expect
          .poll(
            async () =>
              saved() ||
              (await page
                .getByText('Configuração: gravação recusada.')
                .isVisible()),
            { timeout: 60_000 },
          )
          .toBe(true)
      }
      await expect
        .poll(() =>
          configFiles(farm).some((file) => file.path.endsWith('.bak')),
        )
        .toBe(true)
      await inboxRearmed(farm, beforeSave)
      await stillLive(page, 'configuração com cópia de segurança')
    })

    await test.step('energia', async () => {
      await tab(page, 'Sistema')
      await command(farm, page.getByRole('button', { name: 'Desligar Fonte' }))
      await expect
        .poll(() => mock.control.powerDevices.get('Fonte')?.status)
        .toBe('off')
      await stillLive(page, 'energia')
    })

    await test.step('reiniciar Klipper', async () => {
      await command(
        farm,
        page.getByRole('button', { name: 'Reiniciar Klipper', exact: true }),
      )
      await expect
        .poll(
          () =>
            (mock.calls()['printer.restart'] ?? 0) +
            (mock.calls()['machine.services.restart'] ?? 0),
        )
        .toBeGreaterThan(0)
      // The link comes back once Klipper is ready again.
      await stillLive(page, 'reinício do Klipper')
    })

    await test.step('com impressão em andamento: exclusão de objeto, lista do console e recusas por estado', async () => {
      mock.update({ state: 'printing', progress: 0.25, filename: 'cubo.gcode' })
      await expect(page.getByText('Imprimindo', { exact: true })).toBeVisible({
        timeout: 90_000,
      })
      await tab(page, 'Painel')
      // Movement never runs during a job: refused here with its reason.
      await expect(
        page.getByRole('button', { name: /^X\+: mover/ }),
      ).toBeDisabled()
      await expect(
        page
          .getByText(
            'Comando indisponível. O estado da impressora não permite esta ação.',
          )
          .first(),
      ).toBeVisible()
      await command(
        farm,
        page.getByRole('button', { name: 'Excluir objeto cubo_2' }),
      )
      await expect(
        page.getByRole('listitem').filter({ hasText: 'cubo_2' }),
      ).toContainText('Excluído', { timeout: 30_000 })

      await tab(page, 'Console')
      await expect(
        page.getByText('Durante a impressão, só são aceitos:'),
      ).toBeVisible()
      await command(
        farm,
        page.getByRole('button', { name: 'Enviar', exact: true }),
        NOT_SENT,
        () => page.getByLabel('Comando G-code').fill('G28'),
      )
      expect(scripts(farm)).not.toContain('G28')
      await command(
        farm,
        page.getByRole('button', { name: 'Enviar', exact: true }),
        SENT,
        () => page.getByLabel('Comando G-code').fill('M220 S80'),
      )
      await expect.poll(() => scripts(farm)).toContain('M220 S80')

      // A configuration save is refused while printing; the editor says why.
      await tab(page, 'Configuração')
      await expect(
        page.getByRole('region', { name: 'Configuração do Klipper' }),
      ).toContainText(
        'Comando indisponível. O estado da impressora não permite esta ação.',
      )
      await expect(
        page.getByRole('button', { name: 'Listar arquivos' }),
      ).toBeDisabled()
      await stillLive(page, 'com impressão em andamento')
    })
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})

test('recusas: console desligado, recurso não suportado, função e estado de impressão', async ({
  bootFarm,
}) => {
  const bare = [
    'webhooks',
    'print_stats',
    'virtual_sdcard',
    'display_status',
    'gcode_move',
    'toolhead',
    'configfile',
    'extruder',
    'heater_bed',
    'fan',
  ]
  const farm = await bootFarm({
    printers: [{ family: 'moonraker', printerKey: KEY }],
    signedControl: true,
    // The console switch stays off, as shipped; no mesh and no object exclusion.
    consoleEnabled: false,
    moonraker: {
      initial: { state: 'printing', progress: 0.25, filename: 'cubo.gcode' },
      mock: { ...FULL_MOCK, objects: bare },
    },
  })
  const owner = farm.owner
  owner.setDefaultTimeout(ACTION_MS)
  try {
    await openDetail(farm)
    const unavailable = owner.getByRole('region', {
      name: 'Recursos indisponíveis',
    })
    // Console switched off for this printer: not offered, with the reason.
    await expect(
      owner.getByRole('tab', { name: 'Console', exact: true }),
    ).toHaveCount(0)
    await expect(unavailable).toContainText(
      'Console: Esta impressora não anuncia este recurso.',
    )
    // Capability the printer does not have (no bed mesh object).
    await expect(
      owner.getByRole('tab', { name: 'Malha', exact: true }),
    ).toHaveCount(0)
    await expect(unavailable).toContainText(
      'Malha: Esta impressora não anuncia este recurso.',
    )
    // Printing state: movement and extrusion are refused with their reason.
    await expect(
      owner.getByRole('button', { name: /^X\+: mover/ }),
    ).toBeDisabled()
    await expect(
      owner
        .getByText(
          'Comando indisponível. O estado da impressora não permite esta ação.',
        )
        .first(),
    ).toBeVisible()
    await expect(owner.getByRole('button', { name: 'Extrudar' })).toBeDisabled()
    await tab(owner, 'Configuração')
    await expect(
      owner.getByRole('region', { name: 'Configuração do Klipper' }),
    ).toContainText(
      'Comando indisponível. O estado da impressora não permite esta ação.',
    )
    await expect(
      owner.getByRole('button', { name: 'Listar arquivos' }),
    ).toBeDisabled()

    // Role: members without an approved device of their own see the printer
    // read-only; nothing can be signed from their page.
    for (const role of ['operator', 'viewer'] as const) {
      const member = await farm.signInAs(role)
      member.setDefaultTimeout(ACTION_MS)
      await farm.openFarm(member)
      await farm
        .printerCard(KEY, member)
        .getByRole('link', { name: /Abrir detalhes da impressora/ })
        .click()
      await expect(
        member.getByRole('heading', { name: KEY, exact: true }),
      ).toBeVisible()
      await expect(
        member.getByText('Somente leitura.', { exact: false }),
      ).toBeVisible()
      await expect(
        member.getByRole('button', { name: 'Parada de emergência' }),
      ).toBeDisabled()
      await expect(
        member.getByText('Indisponível sem conexão direta atual e autorizada.'),
      ).toBeVisible()
      await expect(member.getByRole('dialog')).toHaveCount(0)
    }
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})
