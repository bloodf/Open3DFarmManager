<script setup lang="ts">
import { computed } from 'vue'
import type { z } from 'zod'
import type { PrinterDetailStreamUpdate } from '../../../../../packages/farm-protocol/src/printer-detail.ts'
import { DEFAULT_UNSUPPORTED_REASON } from '../../utils/printer-detail-view.ts'
import Button from '../ui/Button.vue'
import { formatPercentage } from '../../utils/ui-format.ts'
import { printStatusEta } from './print-status-eta.ts'
import { ExcludeObjectArguments } from '../../../../../packages/farm-protocol/src/control-actions.ts'

const props = defineProps<{
  frame: z.infer<typeof PrinterDetailStreamUpdate>
  canExclude: boolean
  excludeReason?: string | undefined
  objectReason?: string | undefined
}>()
const emit = defineEmits<{ exclude: [name: string, event: Event] }>()
const print = computed(() => props.frame.detail.print)
const active = computed(
  () => print.value?.state === 'printing' || print.value?.state === 'paused',
)
const objects = computed(() => props.frame.detail.objects)
const polygons = computed(() => objects.value?.polygons ?? [])
const mapBounds = computed(() => {
  const points = polygons.value.flatMap(({ points }) => points)
  if (!points.length) return undefined
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => -y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return [
    left - 1,
    top - 1,
    Math.max(...xs) - left + 2,
    Math.max(...ys) - top + 2,
  ].join(' ')
})
const estimates = computed(() => {
  const { print, virtualFile, speedFactor } = props.frame.detail
  if (!print || !active.value) return []
  const eta = printStatusEta({
    elapsed: print.elapsedSeconds ?? Number.NaN,
    progress: virtualFile?.progress,
    estimatedSeconds: print.estimatedSeconds,
    filamentUsed: print.filamentUsedMm,
    filamentTotal: print.filamentTotalMm,
    speed: speedFactor,
  })
  return [
    { label: 'Pelo progresso do arquivo', seconds: eta.file },
    { label: 'Pelo fatiador', seconds: eta.slicer },
    { label: 'Pelo filamento usado', seconds: eta.filament },
  ]
})
const clock = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
})
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
function duration(seconds?: number) {
  return seconds === undefined
    ? 'Indisponível'
    : `${Math.floor(seconds / 3600)} h ${Math.floor(seconds / 60) % 60} min ${Math.floor(seconds) % 60} s`
}
function factor(value?: number) {
  return value === undefined
    ? 'Indisponível'
    : (formatPercentage(value * 100) ?? 'Indisponível')
}
</script>

<template>
  <section v-if="print" aria-labelledby="print-status-title">
    <h2 id="print-status-title">Status da impressão</h2>
    <dl>
      <dt>Arquivo</dt>
      <dd>{{ print.file ?? 'Indisponível' }}</dd>
      <dt>Tempo de impressão</dt>
      <dd>{{ duration(print.elapsedSeconds) }}</dd>
      <dt>Camada</dt>
      <dd>{{ print.currentLayer ?? '—' }} / {{ print.totalLayers ?? '—' }}</dd>
      <dt>Velocidade</dt>
      <dd>{{ factor(frame.detail.speedFactor) }}</dd>
      <dt>Fluxo</dt>
      <dd>{{ factor(frame.detail.flowFactor) }}</dd>
      <dt>Filamento usado</dt>
      <dd>
        {{
          print.filamentUsedMm === undefined
            ? 'Indisponível'
            : `${number.format(print.filamentUsedMm)} mm`
        }}
      </dd>
      <template v-for="{ label, seconds } in estimates" :key="label">
        <dt>{{ label }}</dt>
        <dd v-if="seconds === null">Estimativa indisponível</dd>
        <dd v-else-if="print.state === 'paused'">
          {{ duration(seconds) }} restantes após retomar
        </dd>
        <dd v-else>
          {{ duration(seconds) }} restantes · término previsto
          {{ clock.format(Date.now() + seconds * 1000) }}
        </dd>
      </template>
    </dl>

    <h3>Objetos da impressão</h3>
    <p v-if="!frame.capabilities.includes('exclude-object')">
      {{ objectReason ?? DEFAULT_UNSUPPORTED_REASON }}
    </p>
    <template v-else>
      <p v-if="!objects?.names.length">Nenhum objeto disponível.</p>
      <p v-if="objects?.current">Objeto atual: {{ objects.current }}</p>
      <svg
        v-if="mapBounds"
        :viewBox="mapBounds"
        role="img"
        aria-label="Mapa dos objetos na mesa"
      >
        <polygon
          v-for="({ name, points }, index) in polygons"
          :key="index"
          :points="points.map(([x, y]) => `${x},${-y}`).join(' ')"
          :class="{
            current: name === objects?.current,
            excluded: objects?.excluded.includes(name),
          }"
        >
          <title>{{ name }}</title>
        </polygon>
      </svg>
      <p v-if="objects?.names.length && (!canExclude || !active)">
        {{
          active
            ? (excludeReason ?? objectReason ?? DEFAULT_UNSUPPORTED_REASON)
            : 'A exclusão exige uma impressão em andamento ou pausada.'
        }}
      </p>
      <ul v-if="objects?.names.length">
        <li v-for="name in objects.names" :key="name">
          {{ name }}
          <span v-if="objects.excluded.includes(name)"> · Excluído</span>
          <Button
            v-else
            :disabled="
              !canExclude ||
              !active ||
              !ExcludeObjectArguments.safeParse({ name }).success
            "
            :aria-label="`Excluir objeto ${name}`"
            @click="emit('exclude', name, $event)"
            >Excluir objeto</Button
          >
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
svg {
  display: block;
  width: 100%;
  max-width: 24rem;
  max-height: 18rem;
}
polygon {
  fill: currentColor;
  fill-opacity: 0.15;
  stroke: currentColor;
  vector-effect: non-scaling-stroke;
}
.current {
  fill-opacity: 0.5;
  stroke-width: 2;
}
.excluded {
  fill: none;
  stroke-dasharray: 3 3;
}
</style>
