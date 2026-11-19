<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DataTable from '../ui/DataTable.vue'
import {
  defaultView,
  filterEntries,
  formatAge,
  formatLatency,
  layoutMap,
  MAP_MIN_WIDTH_PX,
  noFilter,
  statusInfo,
  type NetworkEntry,
  type NetworkFilter,
  type NetworkStatus,
} from '../../utils/network-map.ts'

const props = defineProps<{
  entries: readonly NetworkEntry[]
  now: number
  /** True while a direct browser-to-Connector session feeds the data. */
  live: boolean
  /** When the server data was read; shown as its age when not live. */
  asOf: number | null
  initialView?: 'map' | 'table'
}>()

// Server render and first paint start on the table (narrow screens);
// from tablet width up the map takes over once the browser is known.
const view = ref<'map' | 'table'>(props.initialView ?? 'table')
onMounted(() => {
  if (props.initialView) return
  view.value = defaultView(window.innerWidth)
})

const agentId = ref(noFilter.agentId)
const status = ref<NetworkFilter['status']>(noFilter.status)
const filter = computed<NetworkFilter>(() => ({
  agentId: agentId.value,
  status: status.value,
}))

const connectors = computed(() =>
  props.entries.filter((entry) => entry.kind === 'connector'),
)
const visible = computed(() => filterEntries(props.entries, filter.value))
const layout = computed(() => layoutMap(visible.value))
const shownCount = computed(() => visible.value.length)

const source = computed(() =>
  props.live
    ? 'Dados ao vivo pela conexão direta do navegador com o Connector.'
    : `Dados do servidor, lidos ${formatAge(props.now, props.asOf)}. Sem conexão direta ao vivo.`,
)

const kindLabel = {
  connector: 'Connector',
  printer: 'Impressora',
  discovered: 'Impressora descoberta',
} as const

function latencyText(entry: NetworkEntry) {
  if (entry.kind !== 'printer') return '—'
  return entry.p95Ms === null
    ? formatLatency(entry.latencyMs)
    : `${formatLatency(entry.latencyMs)} (p95 ${formatLatency(entry.p95Ms)})`
}
function linkLabel(entry: NetworkEntry) {
  const info = statusInfo[entry.status]
  const latency =
    entry.kind === 'printer' ? ` · ${formatLatency(entry.latencyMs)}` : ''
  return `${info.glyph} ${entry.statusText}${latency} · ${formatAge(props.now, entry.lastSeenAt)}`
}
function nodeDescription(entry: NetworkEntry) {
  return `${truncate(entry.name, 22)} ${kindLabel[entry.kind]}. ${linkLabel(entry)}.${entry.href ? ' Abrir detalhes da impressora.' : ''}`
}
function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const columns = [
  { id: 'name', label: 'Nome' },
  { id: 'kind', label: 'Tipo' },
  { id: 'connector', label: 'Connector' },
  { id: 'status', label: 'Status' },
  { id: 'latency', label: 'Latência' },
  { id: 'seen', label: 'Visto por último' },
] as const
const rows = computed(() =>
  visible.value.map((entry) => ({
    id: entry.id,
    cells: {
      name: entry.name,
      kind: kindLabel[entry.kind],
      connector: entry.connectorName,
      status: `${statusInfo[entry.status].glyph} ${entry.statusText}`,
      latency: latencyText(entry),
      seen: formatAge(props.now, entry.lastSeenAt),
    },
  })),
)
const hrefById = computed(
  () => new Map(visible.value.map((entry) => [entry.id, entry.href])),
)
const statuses = Object.keys(statusInfo) as NetworkStatus[]
</script>

<template>
  <section class="farm-map" aria-label="Rede da farm">
    <p class="source">{{ source }}</p>
    <div class="controls">
      <div role="group" aria-label="Visualização">
        <button
          type="button"
          :aria-pressed="view === 'map'"
          @click="view = 'map'"
        >
          Mapa
        </button>
        <button
          type="button"
          :aria-pressed="view === 'table'"
          @click="view = 'table'"
        >
          Tabela
        </button>
      </div>
      <label for="rede-connector">Connector</label>
      <select id="rede-connector" v-model="agentId">
        <option value="all">Todos</option>
        <option v-for="c in connectors" :key="c.agentId" :value="c.agentId">
          {{ c.name }}
        </option>
      </select>
      <label for="rede-status">Status</label>
      <select id="rede-status" v-model="status">
        <option value="all">Todos</option>
        <option v-for="s in statuses" :key="s" :value="s">
          {{ statusInfo[s].label }}
        </option>
      </select>
    </div>
    <p role="status">
      Mostrando {{ shownCount }} de {{ entries.length }} itens.
    </p>

    <p v-if="!connectors.length">Nenhum Connector nesta farm.</p>
    <div
      v-else-if="view === 'map'"
      class="map-scroll"
      role="region"
      aria-label="Mapa da farm"
      tabindex="0"
    >
      <svg
        role="group"
        aria-label="Mapa da farm: servidor, Connectors e impressoras. A tabela traz os mesmos dados."
        :width="layout.width"
        :height="layout.height"
        :viewBox="`0 0 ${layout.width} ${layout.height}`"
      >
        <rect
          class="node"
          :x="layout.server.x"
          :y="layout.server.y"
          :width="layout.server.width"
          :height="layout.server.height"
          rx="6"
        />
        <text
          class="name"
          :x="layout.server.x + layout.server.width / 2"
          :y="layout.server.y + 23"
          text-anchor="middle"
        >
          Servidor
        </text>
        <g v-for="node in layout.nodes" :key="node.entry.id" class="item">
          <path
            class="link"
            :d="
              node.entry.kind === 'connector'
                ? `M${node.fromX},${node.fromY} L${node.linkX},${node.linkY}`
                : `M${node.fromX},${node.fromY} V${node.linkY} H${node.linkX}`
            "
            :stroke="statusInfo[node.entry.status].tone"
            :stroke-dasharray="statusInfo[node.entry.status].dash"
          />
          <text
            :id="`link-${node.entry.id}`"
            class="link-label"
            :x="node.x"
            :y="node.labelY"
            :fill="statusInfo[node.entry.status].tone"
          >
            {{ truncate(linkLabel(node.entry), 30) }}
          </text>
          <component
            :is="node.entry.href ? 'a' : 'g'"
            :href="node.entry.href ?? undefined"
            :aria-label="
              node.entry.href ? undefined : nodeDescription(node.entry)
            "
            :aria-describedby="
              node.entry.href ? `link-${node.entry.id}` : undefined
            "
            :role="node.entry.href ? undefined : 'group'"
          >
            <rect
              class="node"
              :class="{ dashed: node.entry.kind === 'discovered' }"
              :x="node.x"
              :y="node.y"
              :width="node.width"
              :height="node.height"
              rx="6"
            />
            <text class="name" :x="node.x + 8" :y="node.y + 17">
              {{ truncate(node.entry.name, 22) }}
            </text>
            <text class="kind" :x="node.x + 8" :y="node.y + 32">
              {{ kindLabel[node.entry.kind] }}
            </text>
          </component>
        </g>
      </svg>
    </div>
    <DataTable
      v-else
      caption="Rede da farm: Connectors e impressoras"
      :columns="columns"
      :rows="rows"
    >
      <template #name="{ row }">
        <a v-if="hrefById.get(row.id)" :href="hrefById.get(row.id)!">{{
          row.cells.name
        }}</a>
        <template v-else>{{ row.cells.name }}</template>
      </template>
    </DataTable>
  </section>
</template>

<style scoped>
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
button,
select {
  min-block-size: 2.75rem;
  max-inline-size: 100%;
}
button[aria-pressed='true'] {
  font-weight: 700;
  text-decoration: underline;
}
.map-scroll {
  overflow: auto;
  max-inline-size: 100%;
}
.map-scroll:focus-visible,
a:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset);
}
svg {
  display: block;
  font-family: inherit;
}
.node {
  fill: var(--surface-raised);
  stroke: var(--text);
  stroke-width: 1.5;
}
.node.dashed {
  stroke-dasharray: 4 4;
}
.link {
  fill: none;
  stroke-width: 2.5;
}
.name {
  fill: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.kind {
  fill: var(--text-muted);
  font-size: 11px;
}
.link-label {
  font-size: 11px;
  font-weight: 600;
}
a:focus-visible .node {
  stroke-width: 3;
}
</style>
