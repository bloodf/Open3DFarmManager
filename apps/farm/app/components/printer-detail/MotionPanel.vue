<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import {
  BABYSTEP_STEPS_MM,
  DEFAULT_MOTION_REASON,
  JOG_FEEDS_MM_MIN,
  JOG_STEPS_MM,
  mmText,
  babystepDelta,
  factorRequest,
  jogRequest,
  positionText,
  unhomedAxes,
  type JogAxis,
  type MotionAvailabilityMap,
  type MotionControl,
} from './motion-view.ts'

const props = defineProps<{
  /** Per control: whether it can run now and, if not, why. */
  availability: MotionAvailabilityMap
  /** X, Y, Z (and E) as the printer reports them. */
  position?: readonly number[]
  homedAxes?: readonly string[]
  speedPct?: number
  flowPct?: number
  /** False when the printer does not advertise speed and flow factors. */
  factors?: boolean
  factorsReason?: string
}>()
const emit = defineEmits<{
  (e: 'home', event: Event): void
  (
    e: 'jog',
    axis: JogAxis,
    distanceMm: number,
    feed: number,
    event: Event,
  ): void
  (e: 'motors-off', event: Event): void
  (e: 'z-babystep', deltaMm: number, event: Event): void
  (e: 'set-factor', speedPct: number, flowPct: number, event: Event): void
}>()

const step = ref(String(JOG_STEPS_MM[1]))
const feed = ref(String(JOG_FEEDS_MM_MIN[2]))
const babystep = ref(String(BABYSTEP_STEPS_MM[1]))
const speed = ref(String(props.speedPct ?? 100))
const flow = ref(String(props.flowPct ?? 100))
const note = ref('')

const can = (control: MotionControl) =>
  props.availability[control]?.available === true
const reasonFor = (control: MotionControl) =>
  props.availability[control]?.available
    ? ''
    : (props.availability[control]?.reason ?? DEFAULT_MOTION_REASON)
// One shared explanation per distinct reason keeps the page short.
const reasons = computed(() => [
  ...new Set(
    (['jog', 'z_babystep', 'set_factor', 'home', 'motors_off'] as const)
      .map(reasonFor)
      .filter(Boolean),
  ),
])
const missing = computed(() => unhomedAxes(props.homedAxes))
const axes = [
  { axis: 'x', minus: 'para a esquerda', plus: 'para a direita' },
  { axis: 'y', minus: 'para frente', plus: 'para trás' },
  { axis: 'z', minus: 'para baixo', plus: 'para cima' },
] as const
const canJog = (axis: JogAxis) =>
  can('jog') &&
  (props.homedAxes === undefined || props.homedAxes.includes(axis))

function jog(axis: JogAxis, sign: 1 | -1, event: Event) {
  const request = jogRequest(sign, step.value, feed.value)
  if (canJog(axis) && request)
    emit('jog', axis, request.distanceMm, request.feed, event)
}
function adjustZ(sign: 1 | -1, event: Event) {
  const delta = babystepDelta(sign, babystep.value)
  if (can('z_babystep') && delta !== undefined) emit('z-babystep', delta, event)
}
function applyFactors(event: Event) {
  if (!can('set_factor')) return
  const request = factorRequest(speed.value, flow.value)
  if ('note' in request) {
    note.value = request.note
    return
  }
  note.value = ''
  emit('set-factor', request.speedPct, request.flowPct, event)
}
</script>

<template>
  <section aria-labelledby="motion-title">
    <h2 id="motion-title">Movimento</h2>
    <p v-for="reason in reasons" :key="reason" class="motion-note">
      {{ reason }}
    </p>
    <ul class="motion-position" aria-label="Posição atual">
      <li v-for="item in axes" :key="item.axis">
        {{ positionText(item.axis, position) }}
      </li>
    </ul>
    <p v-if="missing.length">
      Não referenciado:
      {{ missing.map((axis) => axis.toUpperCase()).join(', ') }}.
    </p>
    <p>
      <Button
        type="button"
        :disabled="!can('home')"
        @click="emit('home', $event)"
        >Referenciar eixos</Button
      >
      <Button
        type="button"
        :disabled="!can('motors_off')"
        @click="emit('motors-off', $event)"
        >Desligar motores</Button
      >
    </p>
    <fieldset class="motion-field">
      <legend>Passo de movimento</legend>
      <label v-for="size in JOG_STEPS_MM" :key="size" class="motion-radio">
        <input
          v-model="step"
          type="radio"
          name="jog-step"
          :value="String(size)"
        />
        {{ mmText(size) }}
      </label>
    </fieldset>
    <p class="motion-field">
      <label for="jog-feed">Velocidade do movimento (mm/min)</label>
      <select id="jog-feed" v-model="feed">
        <option
          v-for="value in JOG_FEEDS_MM_MIN"
          :key="value"
          :value="String(value)"
        >
          {{ value }}
        </option>
      </select>
    </p>
    <div role="group" aria-label="Direcional de movimento" class="motion-pad">
      <template v-for="item in axes" :key="item.axis">
        <Button
          type="button"
          :aria-label="`${item.axis.toUpperCase()}−: mover ${item.minus}`"
          :disabled="!canJog(item.axis)"
          @click="jog(item.axis, -1, $event)"
          >{{ item.axis.toUpperCase() }}−</Button
        >
        <Button
          type="button"
          :aria-label="`${item.axis.toUpperCase()}+: mover ${item.plus}`"
          :disabled="!canJog(item.axis)"
          @click="jog(item.axis, 1, $event)"
          >{{ item.axis.toUpperCase() }}+</Button
        >
      </template>
    </div>
    <fieldset class="motion-field">
      <legend>Ajuste fino do Z</legend>
      <label for="babystep-size">Tamanho do ajuste (mm)</label>
      <select id="babystep-size" v-model="babystep">
        <option
          v-for="value in BABYSTEP_STEPS_MM"
          :key="value"
          :value="String(value)"
        >
          {{ value.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) }}
        </option>
      </select>
      <Button
        type="button"
        :disabled="!can('z_babystep')"
        @click="adjustZ(-1, $event)"
        >Descer o Z</Button
      >
      <Button
        type="button"
        :disabled="!can('z_babystep')"
        @click="adjustZ(1, $event)"
        >Subir o Z</Button
      >
    </fieldset>
    <form v-if="factors" class="motion-field" @submit.prevent="applyFactors">
      <label for="factor-speed">Velocidade (%)</label>
      <input
        id="factor-speed"
        v-model="speed"
        type="number"
        inputmode="numeric"
        min="10"
        max="300"
        step="1"
        :disabled="!can('set_factor')"
      />
      <label for="factor-flow">Fluxo (%)</label>
      <input
        id="factor-flow"
        v-model="flow"
        type="number"
        inputmode="numeric"
        min="50"
        max="150"
        step="1"
        :disabled="!can('set_factor')"
      />
      <Button type="submit" :disabled="!can('set_factor')"
        >Aplicar fatores</Button
      >
      <p v-if="note" role="status">{{ note }}</p>
    </form>
    <p v-else>
      {{ factorsReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
  </section>
</template>

<style scoped>
.motion-position {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: 0;
  list-style: none;
}
.motion-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-block: var(--space-3);
}
.motion-radio {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
}
.motion-pad {
  display: grid;
  grid-template-columns: repeat(2, minmax(2.75rem, 7rem));
  gap: var(--space-2);
  margin-block: var(--space-3);
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
