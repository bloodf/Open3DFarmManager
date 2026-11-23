<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import { fieldText } from '../../utils/printer-detail-view.ts'

/** Same name shape the signed commands accept; the Connector checks the list. */
const NAME = /^[A-Za-z0-9_]{1,64}$/

const props = defineProps<{
  /** Which of `set_fan`, `set_led` and `set_pin` the printer advertises. */
  advertised: { fan: boolean; led: boolean; pin: boolean }
  /** Names the printer reports, offered as suggestions when known. */
  fans?: readonly string[]
  leds?: readonly string[]
  pins?: readonly string[]
  /** False in degraded mode or while a command runs: forms stay visible but off. */
  canCommand: boolean
  /** Why the controls are off; the catalog reason when not advertised. */
  disabledReason?: string
}>()
const emit = defineEmits<{
  (e: 'set-fan', fan: string, percent: number, event: Event): void
  (
    e: 'set-led',
    name: string,
    channels: { r: number; g: number; b: number; w?: number },
    event: Event,
  ): void
  (e: 'set-pin', name: string, value: number, event: Event): void
}>()

const anyAdvertised = computed(
  () => props.advertised.fan || props.advertised.led || props.advertised.pin,
)
const disabled = computed(() => !props.canCommand)
const fanName = ref('')
const fanPercent = ref('100')
const ledName = ref('')
const ledColor = ref('#ffffff')
const ledWhite = ref('')
const pinName = ref('')
const pinPercent = ref('0')
const note = ref('')

function wholeNumber(text: string | number, min: number, max: number) {
  const value = Number(text)
  return fieldText(text) !== '' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined
}
function checkName(name: string, label: string) {
  if (NAME.test(name)) return true
  note.value = `Informe o nome ${label} usando apenas letras, números e _.`
  return false
}

function submitFan(event: Event) {
  if (disabled.value) return
  const percent = wholeNumber(fanPercent.value, 0, 100)
  if (!checkName(fanName.value, 'do ventilador')) return
  if (percent === undefined) {
    note.value = 'Informe uma velocidade inteira entre 0 e 100 %.'
    return
  }
  note.value = ''
  emit('set-fan', fanName.value, percent, event)
}
function submitLed(event: Event) {
  if (disabled.value) return
  if (!checkName(ledName.value, 'do LED')) return
  const white =
    fieldText(ledWhite.value) === ''
      ? undefined
      : wholeNumber(ledWhite.value, 0, 255)
  if (fieldText(ledWhite.value) !== '' && white === undefined) {
    note.value = 'Informe o branco como inteiro entre 0 e 255.'
    return
  }
  const hex = ledColor.value.replace('#', '')
  note.value = ''
  emit(
    'set-led',
    ledName.value,
    {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      ...(white === undefined ? {} : { w: white }),
    },
    event,
  )
}
function submitPin(event: Event) {
  if (disabled.value) return
  const percent = wholeNumber(pinPercent.value, 0, 100)
  if (!checkName(pinName.value, 'da saída')) return
  if (percent === undefined) {
    note.value = 'Informe um valor inteiro entre 0 e 100 %.'
    return
  }
  note.value = ''
  emit('set-pin', pinName.value, percent / 100, event)
}
</script>

<template>
  <section aria-labelledby="outputs-title">
    <h2 id="outputs-title">Ventiladores, LEDs e saídas</h2>
    <p v-if="!anyAdvertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <div v-else class="outputs">
      <p v-if="disabled" id="outputs-reason">
        {{
          disabledReason ??
          'Indisponível: o comando exige conexão direta ao vivo.'
        }}
      </p>

      <form
        v-if="advertised.fan"
        aria-labelledby="outputs-fan-title"
        @submit.prevent="submitFan($event)"
      >
        <h3 id="outputs-fan-title">Ventilador</h3>
        <label for="outputs-fan-name">Nome do ventilador</label>
        <input
          id="outputs-fan-name"
          v-model="fanName"
          list="outputs-fan-list"
          autocomplete="off"
          maxlength="64"
          :disabled="disabled"
          :aria-describedby="disabled ? 'outputs-reason' : undefined"
        />
        <datalist id="outputs-fan-list">
          <option v-for="name in fans ?? []" :key="name" :value="name" />
        </datalist>
        <label for="outputs-fan-percent">Velocidade (%)</label>
        <input
          id="outputs-fan-percent"
          v-model="fanPercent"
          type="number"
          inputmode="numeric"
          min="0"
          max="100"
          step="1"
          :disabled="disabled"
        />
        <Button type="submit" :disabled="disabled"
          >Aplicar ao ventilador</Button
        >
      </form>

      <form
        v-if="advertised.led"
        aria-labelledby="outputs-led-title"
        @submit.prevent="submitLed($event)"
      >
        <h3 id="outputs-led-title">LED</h3>
        <label for="outputs-led-name">Nome do LED</label>
        <input
          id="outputs-led-name"
          v-model="ledName"
          list="outputs-led-list"
          autocomplete="off"
          maxlength="64"
          :disabled="disabled"
          :aria-describedby="disabled ? 'outputs-reason' : undefined"
        />
        <datalist id="outputs-led-list">
          <option v-for="name in leds ?? []" :key="name" :value="name" />
        </datalist>
        <label for="outputs-led-color">Cor</label>
        <input
          id="outputs-led-color"
          v-model="ledColor"
          type="color"
          :disabled="disabled"
        />
        <label for="outputs-led-white">Branco (0 a 255, opcional)</label>
        <input
          id="outputs-led-white"
          v-model="ledWhite"
          type="number"
          inputmode="numeric"
          min="0"
          max="255"
          step="1"
          :disabled="disabled"
        />
        <Button type="submit" :disabled="disabled">Aplicar ao LED</Button>
      </form>

      <form
        v-if="advertised.pin"
        aria-labelledby="outputs-pin-title"
        @submit.prevent="submitPin($event)"
      >
        <h3 id="outputs-pin-title">Saída</h3>
        <label for="outputs-pin-name">Nome da saída</label>
        <input
          id="outputs-pin-name"
          v-model="pinName"
          list="outputs-pin-list"
          autocomplete="off"
          maxlength="64"
          :disabled="disabled"
          :aria-describedby="disabled ? 'outputs-reason' : undefined"
        />
        <datalist id="outputs-pin-list">
          <option v-for="name in pins ?? []" :key="name" :value="name" />
        </datalist>
        <label for="outputs-pin-percent">Valor (%)</label>
        <input
          id="outputs-pin-percent"
          v-model="pinPercent"
          type="number"
          inputmode="numeric"
          min="0"
          max="100"
          step="1"
          :disabled="disabled"
          aria-describedby="outputs-pin-hint"
        />
        <span id="outputs-pin-hint">
          Saídas digitais aceitam 0 % (desligada) ou 100 % (ligada).
        </span>
        <Button type="submit" :disabled="disabled">Aplicar à saída</Button>
      </form>

      <p v-if="note" role="status">{{ note }}</p>
    </div>
  </section>
</template>

<style scoped>
.outputs {
  display: grid;
  gap: var(--space-3);
  max-width: 24rem;
}
form {
  display: grid;
  gap: var(--space-2);
}
input {
  font: inherit;
  min-height: 2.75rem;
  max-width: 100%;
}
input:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
</style>
