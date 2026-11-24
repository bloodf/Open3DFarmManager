import { createApp } from 'vue/dist/vue.esm-bundler.js'
import FarmMaterials from '../../apps/farm/app/components/FarmMaterials.vue'
import SpoolInventory from '../../apps/farm/app/components/SpoolInventory.vue'
import PrinterWallCard from '../../apps/farm/app/components/farm/PrinterWallCard.vue'
import PrinterWallTable from '../../apps/farm/app/components/farm/PrinterWallTable.vue'
import ReplayDialog from '../../apps/farm/app/components/library/ReplayDialog.vue'
import SpoolIllustration from '../../apps/farm/app/components/spool-library/SpoolIllustration.vue'
import { activeSlotSpools } from '../../apps/farm/app/utils/slot-spools.ts'
import '../../apps/farm/app/assets/tokens/tokens.css'

const now = { wall: 2000, mono: 1000 }
const materials = [
  {
    slot: 'ams:0:0',
    colorHex: 'E04030FF',
    materialType: 'PLA',
    remainingPercent: 70,
  },
  {
    slot: 'ams:0:1',
    colorHex: '3080E0FF',
    materialType: 'PETG',
    remainingPercent: 0,
  },
  { slot: '0:0', materialType: 'ASA' },
]
const observation = {
  state: {
    printerKey: 'fixture',
    state: 'idle',
    observedAt: now.wall,
    materials,
  },
  received: now,
  historical: false,
  sourceClockComparable: true,
}
const row = {
  assignment: {
    assignmentId: 'fixture-id',
    agentId: 'connector-fixture',
    printerKey: 'fixture',
  },
  observation,
  connection: 'authenticated',
}
const stock = [
  {
    agentId: 'connector-fixture',
    received: now,
    historical: false,
    inventory: {
      observedAt: now.wall,
      serviceId: 'fixture-service',
      stale: false,
      total: 2,
      spools: [
        {
          spoolId: 11,
          name: 'PLA com peso inicial',
          material: 'PLA',
          colorHex: 'e04030',
          remainingPercent: 25,
          remainingGrams: 250,
          archived: false,
        },
        {
          name: 'Bobina antiga',
          colorHex: null,
          remainingGrams: 400,
          archived: false,
        },
      ],
    },
  },
]
const activeSpools = activeSlotSpools({
  farmId: 'fixture-farm',
  row,
  inventory: stock,
  now,
  assignments: { 'ams:0:0': 11 },
})
const replaySource = {
  sha256: 'a'.repeat(64),
  name: 'Fixture.3mf',
  kind: '3mf',
  plateCount: 1,
  metadata: { tools: [{ filamentType: 'PLA' }] },
  storageLocation: 'server',
  agentId: null,
}
const printers = [
  {
    key: 'fixture',
    label: 'Bambu de teste',
    agentId: 'connector-fixture',
    model: 'P1S',
    nozzleDiameters: [0.4],
    backend: 'bambu',
    connectorOnline: true,
    live: true,
    materials: materials.map((material) => ({
      ...material,
      spoolmanRemainingPercent: activeSpools.find(
        (spool) => spool.slot === material.slot,
      )?.remainingPercent,
    })),
  },
]

createApp({
  components: {
    FarmMaterials,
    PrinterWallCard,
    PrinterWallTable,
    ReplayDialog,
    SpoolIllustration,
    SpoolInventory,
  },
  data: () => ({
    entries: [
      { name: 'Cor', filament: { color_hex: 'E04030' }, printer: 70 },
      { name: 'Azul', filament: { color_hex: '3080E0' }, printer: 70 },
      { name: 'Zero do Spoolman', spoolman: 0, printer: 85 },
      { name: 'Desconhecido' },
    ],
    now,
    materials,
    activeSpools,
    observation,
    row,
    stock,
    replaySource,
    printers,
    replayOpen: false,
  }),
  methods: {
    liveNow: () => now,
    send: () => {
      throw new Error('Fixture must never send a command')
    },
  },
  template: `
    <main style="background:var(--color-surface);color:var(--color-text);padding:1rem">
      <section aria-label="Níveis da bobina">
        <div v-for="entry in entries" :key="entry.name" style="display:inline-grid;padding:.5rem">
          <SpoolIllustration :filament="entry.filament" :spoolman-percent="entry.spoolman" :printer-percent="entry.printer" />
          <span>{{ entry.name }}</span>
        </div>
      </section>
      <SpoolInventory :items="stock" :now="now" :rows="[row]" connected />
      <FarmMaterials title="Slots ACE" :heading-level="2" :materials="materials.slice(2)" />
      <FarmMaterials title="Materiais" :heading-level="2" :materials="materials" :active-spools="activeSpools" />
      <PrinterWallCard name="Inspetor" detail-href="/impressoras/fixture" :now="now" :observation="observation" :active-spools="activeSpools" />
      <PrinterWallTable :rows="[row]" :live-now="liveNow" />
      <button type="button" @click="replayOpen = true">Abrir mapeamento</button>
      <ReplayDialog v-model="replayOpen" :source="replaySource" :printers="printers" :send="send" />
    </main>
  `,
}).mount('#app')
