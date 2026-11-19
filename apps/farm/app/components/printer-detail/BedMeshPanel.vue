<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import ColorScaleLegend from '../ui/charts/ColorScaleLegend.vue'
import {
  DEFAULT_MESH_REASON,
  DEFAULT_VIEW,
  SCALE_STOPS,
  VIEW_STEP_DEG,
  drawHeightmap,
  meshMm,
  meshRequest,
  meshRowsFor,
  meshStats,
  meshSummary,
  meshTable,
  projectMesh,
  rotateView,
  type BedMeshData,
  type MeshAvailabilityMap,
  type MeshOp,
  type MeshSource,
} from './heightmap-view.ts'

const props = defineProps<{
  /** Last bed_mesh the printer reported; absent until one arrives. */
  mesh?: BedMeshData
  /** Per operation: whether it can run now and, if not, why. */
  availability: MeshAvailabilityMap
}>()
const emit = defineEmits<{
  (e: 'bed-mesh', args: { op: MeshOp; profile?: string }, event: Event): void
}>()

const WIDTH = 480
const HEIGHT = 360
const source = ref<MeshSource>('interpolated')
const view = ref(DEFAULT_VIEW)
const newName = ref('')
const saved = ref('')
const note = ref('')
const canvas = ref<HTMLCanvasElement | null>(null)

const hasProbed = computed(() => !!props.mesh?.probed?.length)
const shown = computed<MeshSource>(() =>
  source.value === 'probed' && hasProbed.value ? 'probed' : 'interpolated',
)
const rows = computed(() => meshRowsFor(props.mesh, shown.value))
const stats = computed(() => meshStats(rows.value))
const bounds = computed(() => ({
  min: props.mesh?.min ?? ([0, 0] as const),
  max: props.mesh?.max ?? ([1, 1] as const),
}))
const table = computed(() => meshTable(rows.value, bounds.value))
const summary = computed(() =>
  meshSummary(rows.value, shown.value, props.mesh?.profile ?? null),
)
const profiles = computed(() => props.mesh?.profiles ?? [])
const legendStops = computed(() =>
  SCALE_STOPS.map((color, index) => ({
    color,
    label: meshMm(
      stats.value
        ? stats.value.min +
            (stats.value.range * index) / (SCALE_STOPS.length - 1)
        : 0,
    ),
  })),
)
const reasons = computed(() => [
  ...new Set(
    (['calibrate', 'load', 'save', 'remove', 'clear'] as const)
      .map((op) =>
        props.availability[op]?.available
          ? ''
          : (props.availability[op]?.reason ?? DEFAULT_MESH_REASON),
      )
      .filter(Boolean),
  ),
])
const can = (op: MeshOp) => props.availability[op]?.available === true

function paint() {
  const context = canvas.value?.getContext('2d')
  if (!context || !props.mesh) return
  drawHeightmap(
    context,
    projectMesh(rows.value, bounds.value, view.value, {
      width: WIDTH,
      height: HEIGHT,
    }),
    { width: WIDTH, height: HEIGHT },
  )
}
onMounted(paint)
watch([rows, bounds, view], paint)

function rotate(dYaw: number, dPitch: number) {
  view.value = rotateView(view.value, dYaw, dPitch)
}
let drag: { x: number; y: number } | undefined
function press(event: PointerEvent) {
  drag = { x: event.clientX, y: event.clientY }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function move(event: PointerEvent) {
  if (!drag) return
  rotate((event.clientX - drag.x) * 0.5, (event.clientY - drag.y) * 0.5)
  drag = { x: event.clientX, y: event.clientY }
}
const release = () => {
  drag = undefined
}

function run(op: MeshOp, name: string, event: Event) {
  if (!can(op)) return
  const request = meshRequest(op, name)
  if ('note' in request) {
    note.value = request.note
    return
  }
  note.value = ''
  emit('bed-mesh', request.args, event)
}
</script>

<template>
  <section aria-labelledby="mesh-title">
    <h2 id="mesh-title">Malha da mesa</h2>
    <p v-for="reason in reasons" :key="reason" class="mesh-note">
      {{ reason }}
    </p>
    <template v-if="table && stats">
      <p id="mesh-summary">{{ summary }}</p>
      <ul class="mesh-stats" aria-label="Resumo da malha">
        <li>Mínimo: {{ meshMm(stats.min) }}</li>
        <li>Máximo: {{ meshMm(stats.max) }}</li>
        <li>Variação: {{ meshMm(stats.range) }}</li>
      </ul>
      <fieldset class="mesh-field">
        <legend>Pontos exibidos</legend>
        <label class="mesh-radio">
          <input
            v-model="source"
            type="radio"
            name="mesh-source"
            value="interpolated"
          />
          Interpolados
        </label>
        <label class="mesh-radio">
          <input
            v-model="source"
            type="radio"
            name="mesh-source"
            value="probed"
            :disabled="!hasProbed"
          />
          Sondados
        </label>
        <p v-if="!hasProbed">A impressora não informou os pontos sondados.</p>
      </fieldset>
      <canvas
        ref="canvas"
        class="mesh-canvas"
        :width="WIDTH"
        :height="HEIGHT"
        role="img"
        aria-label="Mapa de altura tridimensional da malha da mesa"
        aria-describedby="mesh-summary"
        @pointerdown="press"
        @pointermove="move"
        @pointerup="release"
        @pointercancel="release"
      ></canvas>
      <div role="group" aria-label="Girar o mapa de altura" class="mesh-rotate">
        <Button type="button" @click="rotate(-VIEW_STEP_DEG, 0)"
          >Girar para a esquerda</Button
        >
        <Button type="button" @click="rotate(VIEW_STEP_DEG, 0)"
          >Girar para a direita</Button
        >
        <Button type="button" @click="rotate(0, VIEW_STEP_DEG)"
          >Inclinar para cima</Button
        >
        <Button type="button" @click="rotate(0, -VIEW_STEP_DEG)"
          >Inclinar para baixo</Button
        >
        <Button type="button" @click="view = DEFAULT_VIEW"
          >Restaurar a vista</Button
        >
      </div>
      <ColorScaleLegend
        class="mesh-legend"
        label="Escala de cores: do mais baixo, azul escuro, ao mais alto, amarelo"
        :stops="legendStops"
      />
      <h3 id="mesh-grid-title">Grade de cores (vista de cima)</h3>
      <div
        class="mesh-grid"
        role="img"
        aria-labelledby="mesh-grid-title"
        aria-describedby="mesh-summary"
        :style="{ gridTemplateColumns: `repeat(${stats.columns}, 1fr)` }"
      >
        <template v-for="row in [...table.rows].reverse()" :key="row.label">
          <span
            v-for="(cell, index) in row.cells"
            :key="index"
            :style="{ background: cell.fill }"
          ></span>
        </template>
      </div>
      <div
        class="mesh-table"
        role="region"
        aria-label="Tabela de alturas da malha"
        tabindex="0"
      >
        <table>
          <caption>
            Alturas em milímetros. Linhas: posição Y; colunas: posição X.
          </caption>
          <thead>
            <tr>
              <th scope="col">Y \ X</th>
              <th
                v-for="(label, index) in table.columns"
                :key="index"
                scope="col"
              >
                {{ label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in table.rows" :key="row.label">
              <th scope="row">{{ row.label }}</th>
              <td v-for="(cell, index) in row.cells" :key="index">
                {{ cell.text }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else>Sem malha de mesa disponível. Calibre a mesa para gerar uma.</p>
    <form class="mesh-field" @submit.prevent>
      <label for="mesh-name">Nome do perfil (calibrar ou salvar)</label>
      <input
        id="mesh-name"
        v-model="newName"
        type="text"
        maxlength="32"
        autocomplete="off"
        spellcheck="false"
        aria-describedby="mesh-name-help"
      />
      <p id="mesh-name-help">
        Até 32 letras sem acento, números ou sublinhado. Em branco, a calibração
        usa o perfil padrão.
      </p>
      <Button
        type="button"
        :disabled="!can('calibrate')"
        @click="run('calibrate', newName, $event)"
        >Calibrar malha</Button
      >
      <Button
        type="button"
        :disabled="!can('save')"
        @click="run('save', newName, $event)"
        >Salvar perfil</Button
      >
      <Button
        type="button"
        :disabled="!can('clear')"
        @click="run('clear', '', $event)"
        >Limpar malha ativa</Button
      >
    </form>
    <form v-if="profiles.length" class="mesh-field" @submit.prevent>
      <label for="mesh-profile">Perfis salvos</label>
      <select id="mesh-profile" v-model="saved">
        <option value="" disabled>Escolha um perfil</option>
        <option v-for="name in profiles" :key="name" :value="name">
          {{ name }}
        </option>
      </select>
      <Button
        type="button"
        :disabled="!can('load')"
        @click="run('load', saved, $event)"
        >Carregar perfil</Button
      >
      <Button
        type="button"
        :disabled="!can('remove')"
        @click="run('remove', saved, $event)"
        >Remover perfil</Button
      >
    </form>
    <p v-if="note" role="status">{{ note }}</p>
  </section>
</template>

<style scoped>
.mesh-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: 0;
  list-style: none;
}
.mesh-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-block: var(--space-3);
}
.mesh-radio {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
}
.mesh-canvas {
  display: block;
  max-width: 100%;
  height: auto;
  touch-action: none;
  cursor: grab;
}
.mesh-rotate {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-block: var(--space-3);
}
.mesh-legend {
  margin-block: var(--space-3);
}
.mesh-grid {
  display: grid;
  max-width: 24rem;
  grid-auto-rows: 1fr;
  aspect-ratio: 1;
  gap: 1px;
}
.mesh-table {
  max-width: 100%;
  overflow: auto;
  margin-block: var(--space-3);
}
.mesh-table:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
.mesh-table table {
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.mesh-table th,
.mesh-table td {
  padding: var(--space-1) var(--space-2);
  border: 1px solid currentcolor;
  text-align: right;
  white-space: nowrap;
}
select,
input:not([type='radio']) {
  font: inherit;
  min-height: 2.75rem;
  max-width: 100%;
}
select:focus-visible,
input:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
</style>
