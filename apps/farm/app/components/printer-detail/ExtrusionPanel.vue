<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'

/** Same bounds the signed `extrude` command accepts. */
const MAX_EXTRUDE_MM = 100
const MAX_RETRACT_MM = 50
const MAX_FEED = 6000

const props = defineProps<{
  /** True only when the printer advertises the `extrude` control. */
  advertised: boolean
  /** Tool indexes the printer reports (0 is the first extruder). */
  tools: readonly number[]
  /** False in degraded mode or while printing: the form stays visible but off. */
  canCommand: boolean
  /** Why the control is off; the catalog reason when not advertised. */
  disabledReason?: string
}>()
const emit = defineEmits<{
  (
    e: 'extrude',
    tool: number,
    lengthMm: number,
    feed: number,
    event: Event,
  ): void
}>()

const tool = ref<number>(props.tools[0] ?? 0)
const length = ref('10')
const feed = ref('300')
const note = ref('')
const disabled = computed(() => !props.canCommand || !props.tools.length)

function toolLabel(index: number) {
  return `Ferramenta ${index + 1}`
}

function submit(direction: 1 | -1, event: Event) {
  if (disabled.value) return
  const max = direction === 1 ? MAX_EXTRUDE_MM : MAX_RETRACT_MM
  const mm = Number(length.value)
  const rate = Number(feed.value)
  if (length.value.trim() === '' || !(mm >= 0.1 && mm <= max)) {
    note.value = `Informe um comprimento entre 0,1 e ${max} mm.`
    return
  }
  if (feed.value.trim() === '' || !(rate >= 1 && rate <= MAX_FEED)) {
    note.value = `Informe uma velocidade entre 1 e ${MAX_FEED} mm/min.`
    return
  }
  note.value = ''
  const selected = props.tools.includes(tool.value)
    ? tool.value
    : props.tools[0]!
  emit('extrude', selected, direction * mm, rate, event)
}
</script>

<template>
  <section aria-labelledby="extrusion-title">
    <h2 id="extrusion-title">Extrusão</h2>
    <p v-if="!advertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <form v-else class="extrusion" @submit.prevent>
      <p v-if="disabled" id="extrusion-reason">
        {{
          disabledReason ??
          'Indisponível: o bico precisa estar quente e a impressora parada.'
        }}
      </p>
      <label for="extrusion-tool">Ferramenta</label>
      <select
        id="extrusion-tool"
        v-model.number="tool"
        :disabled="disabled"
        :aria-describedby="disabled ? 'extrusion-reason' : undefined"
      >
        <option v-for="index in tools" :key="index" :value="index">
          {{ toolLabel(index) }}
        </option>
      </select>
      <label for="extrusion-length">Comprimento (mm)</label>
      <input
        id="extrusion-length"
        v-model="length"
        type="number"
        inputmode="decimal"
        min="0.1"
        :max="MAX_EXTRUDE_MM"
        step="0.1"
        :disabled="disabled"
        aria-describedby="extrusion-length-hint"
      />
      <span id="extrusion-length-hint">
        Extrusão até {{ MAX_EXTRUDE_MM }} mm; retração até
        {{ MAX_RETRACT_MM }} mm.
      </span>
      <label for="extrusion-feed">Velocidade (mm/min)</label>
      <input
        id="extrusion-feed"
        v-model="feed"
        type="number"
        inputmode="numeric"
        min="1"
        :max="MAX_FEED"
        step="1"
        :disabled="disabled"
      />
      <div class="extrusion__actions">
        <Button type="button" :disabled="disabled" @click="submit(1, $event)"
          >Extrudar</Button
        >
        <Button type="button" :disabled="disabled" @click="submit(-1, $event)"
          >Retrair</Button
        >
      </div>
      <p v-if="note" role="status">{{ note }}</p>
    </form>
  </section>
</template>

<style scoped>
.extrusion {
  display: grid;
  gap: var(--space-2);
  max-width: 24rem;
}
.extrusion__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
input,
select {
  font: inherit;
  min-height: 2.75rem;
  max-width: 100%;
}
input:focus-visible,
select:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
</style>
