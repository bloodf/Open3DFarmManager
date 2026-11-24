import { describe, expect, it } from 'vitest'
import {
  slotBindingKey,
  verifiedSlotBindings,
} from '../../apps/farm/app/utils/farm-slot-view.ts'
import type { SpoolItem } from '../../apps/farm/app/utils/spool-library-types.ts'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import type {
  FarmObservation,
  FarmRow,
} from '../../apps/farm/app/utils/farm-view.ts'

const now = { wall: Date.UTC(2026, 10, 19, 12), mono: 3000 }

type Material = NonNullable<FarmObservation['state']['materials']>[number]
const live: Material = {
  slot: 'ams:0:0',
  active: true,
  colorHex: 'FF4400FF',
  materialType: 'PETG-HF',
  remainingPercent: 77,
}
const unknownLevel: Material = {
  slot: 'ams:0:1',
  colorHex: '00AA55FF',
  materialType: 'PLA-SEDA',
}
const noColor: Material = {
  slot: 'external',
  materialType: 'ABS',
  remainingPercent: 40,
}

function observation(
  materials: Material[],
  historical = false,
): FarmObservation {
  return {
    state: {
      printerKey: '1',
      state: 'printing',
      observedAt: now.wall - 2000,
      progress: 0.4,
      materials,
    },
    received: { wall: now.wall - 2000, mono: 1000 },
    historical,
    sourceClockComparable: true,
  } as FarmObservation
}

function row(materials: Material[], historical = false): FarmRow {
  return {
    assignment: {
      assignmentId: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000009',
      printerKey: 'Impressora 1',
      displayName: 'Impressora 1',
      groupName: 'Produção',
      location: 'Sala 1',
      sortOrder: null,
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: historical ? 'closed' : 'authenticated',
    observation: observation(materials, historical),
    localOrigin: null,
  } as FarmRow
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('drawn spool on printer slots', () => {
  it('draws a live slot at the printer-reported percentage', async () => {
    const html = await renderFarmComponent('../FarmMaterials.vue', {
      materials: [live],
    })
    expect(html).toContain('data-level-source="printer"')
    // 77 % is closest to the 70 % render.
    expect(html).toContain('data-level="3"')
    expect(html).toContain('--farm-spool-paint:#FF4400')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="77"')
    // Colour is never the only signal: material, slot and amount are text.
    const content = text(html)
    for (const word of ['AMS 1, bandeja 1', 'PETG-HF', 'Bandeja ativa'])
      expect(content).toContain(word)
    expect(content).toContain('informado pela impressora')
    expect(html).not.toContain('farm-spool-unknown')
  })

  it('draws a Spoolman-bound slot from the bound weights, not the printer percent', async () => {
    const current = row([live])
    const printerId = current.assignment.assignmentId
    const bindings = verifiedSlotBindings(
      [
        {
          id: 'retired',
          printerId,
          slotKind: 'ams',
          slotIndex: 0,
          spoolId: 1,
          assignedAt: 0,
          unassignedAt: 1,
        },
        {
          id: 'current',
          printerId,
          slotKind: 'ams',
          slotIndex: 0,
          spoolId: 2,
          assignedAt: 1,
          unassignedAt: null,
        },
      ],
      [
        {
          id: 1,
          remaining_weight: 99,
          initial_weight: 100,
          filament: {},
          archived: false,
        } as SpoolItem,
        {
          id: 2,
          remaining_weight: 250,
          initial_weight: 1000,
          filament: {},
          archived: false,
        } as SpoolItem,
      ],
    )
    const html = await renderFarmComponent('FarmPrinterCard.vue', {
      row: current,
      farmId: 'farm-1',
      cameraFor: () => null,
      liveNow: () => now,
      bindings: {
        [live.slot]: bindings.get(printerId)?.get(slotBindingKey(live.slot)),
      },
    })
    expect(html).toContain('data-level-source="spoolman"')
    expect(html).toContain('aria-valuenow="25"')
    expect(html).toContain('data-level="6"')
    expect(html).not.toContain('informado pela impressora')
  })

  it('falls back to the printer percent when the binding has no usable weights', async () => {
    const html = await renderFarmComponent('../FarmMaterials.vue', {
      materials: [live],
      bindings: { 'ams:0:0': { remainingGrams: 250, initialGrams: null } },
    })
    expect(html).toContain('data-level-source="printer"')
    expect(html).toContain('aria-valuenow="77"')
  })

  it('shows an unknown level as the full reel with a desconhecido badge, never a made-up level', async () => {
    const html = await renderFarmComponent('../FarmMaterials.vue', {
      materials: [unknownLevel],
    })
    expect(html).toContain('data-level-source="unknown"')
    expect(html).toContain('data-unknown="true"')
    expect(html).toContain('data-level="1"')
    expect(html).not.toContain('role="meter"')
    const content = text(html)
    expect(content).toContain('desconhecido')
    expect(content).toContain('Quantidade desconhecida')
    expect(content).toContain('PLA-SEDA')
  })

  it('paints a missing colour with the neutral token and says so in text', async () => {
    const html = await renderFarmComponent('../FarmMaterials.vue', {
      materials: [noColor],
    })
    expect(html).toContain('data-color="missing"')
    expect(html).toContain('--farm-spool-paint:var(--ops-idle)')
    expect(text(html)).toContain('Cor não informada')
    expect(text(html)).toContain('Bobina externa')
  })

  it('keeps an empty tray list as text', async () => {
    const html = await renderFarmComponent('../FarmMaterials.vue', {
      materials: [],
    })
    expect(text(html)).toContain('Nenhuma bandeja informada.')
    expect(html).not.toContain('farm-spool')
  })

  it('draws the slots on the printer card and the wall card', async () => {
    const card = await renderFarmComponent('FarmPrinterCard.vue', {
      row: row([live, unknownLevel]),
      farmId: 'farm-1',
      cameraFor: () => null,
      liveNow: () => now,
    })
    expect(card).toContain('--farm-spool-paint:#FF4400')
    // The slot assignment form draws the same spools next to each slot.
    expect(card).toContain('active-spool-assign')
    expect((card.match(/class="farm-spool"/g) ?? []).length).toBeGreaterThan(2)
    const wall = await renderFarmComponent('PrinterWallCard.vue', {
      name: 'Impressora 1',
      detailHref: '/impressoras/1',
      now,
      observation: observation([live, unknownLevel]),
    })
    expect(wall).toContain('aria-label="Slots de filamento"')
    expect(wall).toContain('--farm-spool-paint:#FF4400')
    expect(text(wall)).toContain('Em uso')
  })

  it('shows the stale state, not a reel, for a historical observation', async () => {
    const stale = [live, unknownLevel]
    const card = await renderFarmComponent('FarmPrinterCard.vue', {
      row: row(stale, true),
      farmId: 'farm-1',
      cameraFor: () => null,
      liveNow: () => now,
    })
    const wall = await renderFarmComponent('PrinterWallCard.vue', {
      name: 'Impressora 1',
      detailHref: '/impressoras/1',
      now,
      observation: observation(stale, true),
    })
    const detail = await renderFarmComponent(
      '../printer-detail/PrinterDetailMaterials.vue',
      { materials: stale, historical: true },
    )
    for (const html of [card, wall, detail]) {
      expect(html).not.toContain('farm-spool')
      expect(html).not.toContain('spool-art')
      for (const value of ['PETG-HF', 'PLA-SEDA', 'FF4400', '00AA55', '77%'])
        expect(html).not.toContain(value)
      expect(text(html)).toContain(
        'Materiais indisponíveis: os dados estão desatualizados.',
      )
    }
  })

  it('keeps the filament load slot choice working', async () => {
    const { kobraXInputs } =
      await import('../../apps/farm/app/utils/kobra-x-inputs.ts')
    const { filamentLoadArgs } =
      await import('../../apps/farm/app/utils/filament-load.ts')
    const inputs = kobraXInputs([
      { slot: '-1:0', materialType: 'PLA' },
      { slot: '0:2', materialType: 'PETG' },
    ])
    expect(inputs.map((input) => input.id)).toEqual([0, 6])
    expect(filamentLoadArgs(inputs[1])).toEqual({ tray: 6 })
    expect(filamentLoadArgs(undefined)).toBeUndefined()
  })
})
