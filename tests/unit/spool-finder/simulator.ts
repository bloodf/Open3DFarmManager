// spec-derived, not captured: Spoolman REST API, https://donkie.github.io/Spoolman/
// Spools below are invented for these tests and posted to the Spoolman simulator.
import { startSpoolmanMock } from '../../../packages/sim-tools/src/mocks/spoolman-mock.ts'
import type { SpoolItem } from '../../../apps/farm/app/utils/spool-library-types.ts'

export const FARM = '33333333-3333-4333-8333-333333333333'

export async function startFinderSimulator() {
  const sim = await startSpoolmanMock({ seeded: false })
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${sim.origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`simulator ${path} ${response.status}`)
    return (await response.json()) as T
  }
  const filament = (body: Record<string, unknown>) =>
    post<{ id: number }>('/api/v1/filament', {
      density: 1.24,
      diameter: 1.75,
      weight: 1000,
      ...body,
    })
  const blue = await filament({
    name: 'Azul Royal',
    material: 'PLA',
    color_hex: '1F4FE0',
  })
  const red = await filament({
    name: 'Vermelho Fogo',
    material: 'PETG',
    color_hex: 'E02020',
  })
  const black = await filament({
    name: 'Preto Fosco',
    material: 'PLA',
    color_hex: '000000',
  })
  const spool = (filamentId: number, extra: Record<string, unknown> = {}) =>
    post<{ id: number }>('/api/v1/spool', { filament_id: filamentId, ...extra })
  const ids = {
    blueShelf: (await spool(blue.id, { location: 'Prateleira A1' })).id,
    redShelf: (await spool(red.id, { location: 'Prateleira B2' })).id,
    blackNone: (await spool(black.id)).id,
    blueBox: (await spool(blue.id, { location: 'Caixa seca' })).id,
    archived: (
      await spool(black.id, { location: 'Prateleira A1', archived: true })
    ).id,
  }
  async function list(): Promise<SpoolItem[]> {
    const response = await fetch(
      `${sim.origin}/api/v1/spool?allow_archived=true`,
    )
    return (await response.json()) as SpoolItem[]
  }
  const patches = () =>
    sim.calls.all.filter((call) => call.method === 'PATCH').length
  return { sim, ids, list, patches }
}

export const labelFor = (id: number, farm = FARM) =>
  `https://farm.example.invalid/api/farms/${farm}/spool-library/labels/spool/${id}`
