<script setup lang="ts">
import { formatDateTime, formatNumber } from '../../../utils/ui-format.ts'
import { computed, ref } from 'vue'
import { scale, sortedPoints, type ChartPoint } from './points.ts'

interface Series {
  label: string
  color: string
  points: readonly ChartPoint[]
}

interface Target {
  label: string
  value: number
}

const props = defineProps<{
  label: string
  series: readonly Series[]
  targets?: readonly Target[]
  unit?: string
}>()

const series = computed(() =>
  props.series.map((entry) => ({
    ...entry,
    points: sortedPoints(entry.points),
  })),
)
const targets = computed(() =>
  (props.targets ?? []).filter(({ value }) => Number.isFinite(value)),
)
const times = computed(() =>
  [
    ...new Set(
      series.value.flatMap(({ points }) => points.map(({ time }) => time)),
    ),
  ].sort((a, b) => a - b),
)
const values = computed(() =>
  series.value.map(
    ({ points }) => new Map(points.map(({ time, value }) => [time, value])),
  ),
)
const x = computed(() =>
  scale(times.value[0] ?? 0, times.value.at(-1) ?? 0, 56, 584),
)
const limits = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const { value } of [
    ...series.value.flatMap(({ points }) => points),
    ...targets.value,
  ]) {
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return min === max ? [min] : [min, max]
})
const y = computed(() => scale(limits.value[0]!, limits.value.at(-1)!, 152, 16))
const index = ref(0)
const selected = computed(
  () => times.value[Math.min(index.value, times.value.length - 1)],
)
const formatTime = (time: number) => formatDateTime(time, 'utc')
const formatValue = (value: number) => {
  const number = formatNumber(value, { maximumSignificantDigits: 15 })
  return props.unit ? `${number} ${props.unit}` : number
}
const readout = computed(() => {
  const time = selected.value
  if (time === undefined) return ''
  const readings = series.value.flatMap(({ label }, i) => {
    const value = values.value[i]?.get(time)
    return value === undefined ? [] : [`${label}: ${formatValue(value)}`]
  })
  return [formatTime(time) + ' UTC', ...readings].join(' · ')
})

function pointAtPointer(event: PointerEvent) {
  const svg = event.currentTarget as SVGSVGElement
  const matrix = svg.getScreenCTM()
  if (!matrix) return
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    matrix.inverse(),
  )
  index.value = times.value.reduce(
    (nearest, time, i) =>
      Math.abs(x.value(time) - point.x) <
      Math.abs(x.value(times.value[nearest]!) - point.x)
        ? i
        : nearest,
    0,
  )
}
</script>

<template>
  <figure class="chart">
    <figcaption>{{ label }}</figcaption>
    <p v-if="!times.length">Sem dados para exibir.</p>
    <template v-else>
      <svg
        viewBox="0 0 600 172"
        aria-hidden="true"
        @pointermove="pointAtPointer"
      >
        <path d="M56 16 V152 H584" fill="none" stroke="currentColor" />
        <text
          v-for="limit in limits"
          :key="limit"
          x="50"
          :y="y(limit)"
          text-anchor="end"
        >
          {{ formatNumber(limit, { maximumSignificantDigits: 15 }) }}
        </text>
        <line
          v-for="(target, i) in targets"
          :key="i"
          x1="56"
          x2="584"
          :y1="y(target.value)"
          :y2="y(target.value)"
          stroke="currentColor"
          stroke-dasharray="5 4"
        />
        <g v-for="(entry, i) in series" :key="i">
          <polyline
            v-if="entry.points.length > 1"
            :points="
              entry.points
                .map(({ time, value }) => `${x(time)},${y(value)}`)
                .join(' ')
            "
            fill="none"
            :stroke="entry.color"
            stroke-width="2"
            :stroke-dasharray="i === 0 ? undefined : `${i * 2 + 2} 3`"
            stroke-linejoin="round"
          />
          <circle
            v-else-if="entry.points[0]"
            :cx="x(entry.points[0].time)"
            :cy="y(entry.points[0].value)"
            r="3"
            :fill="entry.color"
          />
        </g>
        <line
          v-if="selected !== undefined"
          :x1="x(selected)"
          :x2="x(selected)"
          y1="16"
          y2="152"
          stroke="currentColor"
          opacity=".5"
        />
      </svg>
      <div class="axis" aria-label="Eixo de tempo em UTC">
        <span>{{ formatTime(times[0]!) }} UTC</span>
        <span v-if="times.length > 1">{{ formatTime(times.at(-1)!) }} UTC</span>
      </div>
      <ul class="legend" aria-label="Legenda do gráfico">
        <li v-for="(entry, i) in series" :key="i">
          <svg viewBox="0 0 24 8" width="24" height="8" aria-hidden="true">
            <path
              d="M0 4 H24"
              :stroke="entry.color"
              stroke-width="2"
              :stroke-dasharray="i === 0 ? undefined : `${i * 2 + 2} 3`"
            />
          </svg>
          {{ entry.label }}
        </li>
        <li v-for="(target, i) in targets" :key="`target-${i}`">
          Meta tracejada · {{ target.label }} ({{ formatValue(target.value) }})
        </li>
      </ul>
      <label class="readout">
        Explorar por horário
        <input
          type="range"
          :value="Math.min(index, times.length - 1)"
          min="0"
          :max="times.length - 1"
          :aria-valuetext="readout"
          @input="
            index = ($event.currentTarget as HTMLInputElement).valueAsNumber
          "
        />
      </label>
      <p>{{ readout }}</p>
      <details>
        <summary>Ver tabela de dados</summary>
        <div class="table">
          <table>
            <caption>
              {{
                label
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Horário (UTC)</th>
                <th v-for="(entry, i) in series" :key="i" scope="col">
                  {{ entry.label }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="time in times" :key="time">
                <th scope="row">{{ formatTime(time) }}</th>
                <td v-for="(column, i) in values" :key="i">
                  {{
                    column.has(time)
                      ? formatValue(column.get(time)!)
                      : 'Sem dado'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </template>
  </figure>
</template>

<style scoped>
.chart {
  margin: 0;
  min-inline-size: 0;
}
.chart > svg {
  display: block;
  width: 100%;
}
text {
  fill: currentColor;
  font-size: 11px;
}
.axis,
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}
.axis {
  justify-content: space-between;
  font-size: 0.875rem;
}
.legend {
  padding-inline-start: 0;
  list-style: none;
}
.readout {
  display: grid;
  gap: 0.5rem;
}
.readout input {
  width: 100%;
  accent-color: var(--accent, currentColor);
}
.table {
  overflow-x: auto;
}
th,
td {
  padding: 0.25rem 0.5rem;
  text-align: start;
}
</style>
