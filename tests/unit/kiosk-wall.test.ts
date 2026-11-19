import { readFile } from 'node:fs/promises'
import { parse } from 'vue/compiler-sfc'
import { expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import type { LastKnownState } from '../../apps/farm/app/composables/useLastKnownStates-core.ts'
import {
  KIOSK_POLL_MS,
  clampKioskPage,
  kioskCapacity,
  kioskPageCount,
  kioskPageItems,
} from '../../apps/farm/app/utils/kiosk-wall.ts'

const file = 'PrinterKiosk.vue'
const now = Date.UTC(2026, 10, 19, 12)

function printer(index: number, ageSeconds = 2): LastKnownState {
  return {
    assignmentId: `a-${index}`,
    printerKey: `impressora-${index}`,
    state: 'printing',
    progress: 0.5,
    temperatures: { toolCelsius: 210, bedCelsius: undefined },
    observedAt: now - ageSeconds * 1000,
  }
}
const seven = Array.from({ length: 7 }, (_, i) => printer(i + 1))
const props = { states: seven, nowWallMs: now, fetchedAt: now - 1000 }

it('pages through printers that do not fit', async () => {
  const second = await renderFarmComponent(file, {
    ...props,
    perPage: 3,
    page: 1,
  })
  expect(second).toContain('Página 2 de 3')
  for (const n of [4, 5, 6]) expect(second).toContain(`impressora-${n}<`)
  for (const n of [1, 2, 3, 7]) expect(second).not.toContain(`impressora-${n}<`)
  const last = await renderFarmComponent(file, {
    ...props,
    perPage: 3,
    page: 99,
  })
  expect(last).toContain('Página 3 de 3')
  expect(last).toContain('impressora-7<')
  const all = await renderFarmComponent(file, {
    ...props,
    perPage: 12,
    page: 0,
  })
  expect(all).not.toContain('Página')
  expect((all.match(/<article/g) ?? []).length).toBe(7)
})

it('computes pages and capacity for 1080p and 4K', () => {
  expect(kioskPageCount(0, 5)).toBe(1)
  expect(kioskPageCount(7, 3)).toBe(3)
  expect(clampKioskPage(-1, 7, 3)).toBe(0)
  expect(clampKioskPage(Number.NaN, 7, 3)).toBe(0)
  expect(kioskPageItems([1, 2, 3, 4], 1, 3)).toEqual([4])
  const hd = kioskCapacity(1920, 1080)
  expect(hd).toBeGreaterThan(1)
  expect(kioskCapacity(3840, 2160)).toBe(hd)
  expect(kioskCapacity(320, 200)).toBeGreaterThanOrEqual(1)
})

it('shows the data age and flags stale readings', async () => {
  const fresh = await renderFarmComponent(file, props)
  expect(fresh).toContain('Dados atualizados há 1 s')
  expect(fresh).toContain('Observado há 2 s')
  expect(fresh).not.toContain('Dados desatualizados')

  const old = await renderFarmComponent(file, {
    ...props,
    states: [printer(1, 45)],
  })
  expect(old).toContain('Observado há 45 s · Dados desatualizados')

  const silent = await renderFarmComponent(file, {
    ...props,
    fetchedAt: now - 40_000,
  })
  expect(silent).toContain('Dados atualizados há 40 s · Dados desatualizados')
  expect(silent).toContain('kiosk__card--stale')

  const failed = await renderFarmComponent(file, { ...props, failed: true })
  expect(failed).toContain('Falha na atualização')
  expect(failed).toContain('kiosk__card--stale')
})

it('never presents unconfirmed or missing data as current', async () => {
  const future = await renderFarmComponent(file, {
    ...props,
    states: [printer(1, -60)],
  })
  expect(future).toContain('Idade não confirmada · Dados desatualizados')
  const waiting = await renderFarmComponent(file, {
    ...props,
    states: [],
    fetchedAt: null,
  })
  expect(waiting).toContain('Aguardando dados')
  expect(waiting).not.toContain('Nenhuma impressora')
  const empty = await renderFarmComponent(file, { ...props, states: [] })
  expect(empty).toContain('Nenhuma impressora com estado registrado')
  expect(waiting).not.toContain('<article')
  expect(seven[0]?.temperatures.bedCelsius).toBeUndefined()
  expect(await renderFarmComponent(file, props)).toContain('Mesa')
  expect(await renderFarmComponent(file, props)).toContain('Indisponível')
})

it('renders no control, in the component or in the page', async () => {
  const control =
    /<(button|a|input|select|textarea|form|dialog)[\s>]|tabindex|@click|NuxtLink/i
  expect(await renderFarmComponent(file, { ...props, perPage: 3 })).not.toMatch(
    control,
  )
  for (const name of ['pages/painel.vue', 'components/farm/PrinterKiosk.vue']) {
    const source = await readFile(
      new URL(`../../apps/farm/app/${name}`, import.meta.url),
      'utf8',
    )
    const template = parse(source).descriptor.template?.content ?? ''
    expect(template).not.toMatch(control)
  }
})

it('polls every 5 s and requests the screen wake lock', async () => {
  expect(KIOSK_POLL_MS).toBe(5000)
  const page = await readFile(
    new URL('../../apps/farm/app/pages/painel.vue', import.meta.url),
    'utf8',
  )
  expect(page).toContain("wakeLock?.request('screen')")
  expect(page).toContain('setInterval(poll, KIOSK_POLL_MS)')
  expect(page).toContain('/printer-states')
  expect(page).toContain('background: #0b0d10')
})
