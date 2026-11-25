<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import { formatDateTime, formatNumber } from '../../utils/ui-format.ts'
import type { ResinLedgerSummary } from '../../../common/resin-ledger/summary-types.ts'
import {
  emptyResinForm,
  resinEntryFromForm,
  resinKindLabels,
  sourceLabel,
  unknownText,
  type ResinKind,
} from './resin-form.ts'

const props = defineProps<{ farmId: string; printerKey: string }>()
const summary = ref<ResinLedgerSummary | null>(null)
const loadError = ref('')
const status = ref('')
const saving = ref(false)
const form = ref(emptyResinForm())
const needsName = computed(() =>
  ['vat', 'bottle', 'volume'].includes(form.value.kind),
)

const volumeText = (value: number | null) =>
  value === null ? unknownText : `${formatNumber(value)} mL`
const when = (at: number) => formatDateTime(at) ?? unknownText

async function load() {
  loadError.value = ''
  if (!props.farmId || !props.printerKey) return
  try {
    const result = await $fetch<{ summary: ResinLedgerSummary }>(
      '/api/resin-ledger',
      { query: { farmId: props.farmId, printerKey: props.printerKey } },
    )
    summary.value = result.summary
  } catch {
    summary.value = null
    loadError.value = 'Não foi possível carregar o registro de resina.'
  }
}
watch(() => [props.farmId, props.printerKey], load, { immediate: true })

async function submit() {
  status.value = ''
  const built = resinEntryFromForm(form.value)
  if (!built.ok) {
    status.value = built.message
    return
  }
  saving.value = true
  try {
    await $fetch('/api/resin-ledger', {
      method: 'POST',
      body: {
        farmId: props.farmId,
        printerKey: props.printerKey,
        entry: built.entry,
      },
    })
    form.value = emptyResinForm()
    status.value = 'Registro salvo.'
    await load()
  } catch {
    status.value = 'Não foi possível salvar o registro. Nada foi alterado.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="panel resin-ledger" aria-labelledby="resin-ledger-title">
    <h2 id="resin-ledger-title">Resina</h2>
    <p v-if="loadError" role="status">{{ loadError }}</p>
    <template v-else-if="summary">
      <dl class="resin-summary">
        <div>
          <dt>Cuba atual</dt>
          <dd>
            <template v-if="summary.vat">
              {{ summary.vat.name }} · {{ sourceLabel(summary.vat.source) }}
            </template>
            <template v-else>{{ unknownText }}</template>
          </dd>
        </div>
        <div>
          <dt>Volume da cuba</dt>
          <dd>
            {{ volumeText(summary.vatVolumeMl?.value ?? null) }}
            <template v-if="summary.vatVolumeMl">
              · {{ sourceLabel(summary.vatVolumeMl.source) }} ·
              {{ when(summary.vatVolumeMl.recordedAt) }}
            </template>
          </dd>
        </div>
        <div>
          <dt>Filme (camadas)</dt>
          <dd>
            <template v-if="summary.film">
              {{ formatNumber(summary.film.value) }} ·
              {{ sourceLabel(summary.film.source) }}
            </template>
            <template v-else>{{ unknownText }}</template>
          </dd>
        </div>
        <div>
          <dt>LCD (horas)</dt>
          <dd>
            <template v-if="summary.lcd">
              {{ formatNumber(summary.lcd.value) }} ·
              {{ sourceLabel(summary.lcd.source) }}
            </template>
            <template v-else>{{ unknownText }}</template>
          </dd>
        </div>
      </dl>
      <h3>Garrafas</h3>
      <p v-if="!summary.bottles.length">Nenhuma garrafa registrada.</p>
      <ul v-else>
        <li v-for="bottle in summary.bottles" :key="bottle.name">
          {{ bottle.name }} · {{ volumeText(bottle.volumeMl) }} ·
          {{ sourceLabel(bottle.source) }}
        </li>
      </ul>
    </template>
    <p v-else>Carregando…</p>

    <form class="resin-form" @submit.prevent="submit">
      <label>
        Tipo de registro
        <select v-model="form.kind">
          <option
            v-for="(label, kind) in resinKindLabels"
            :key="kind"
            :value="kind as ResinKind"
          >
            {{ label }}
          </option>
        </select>
      </label>
      <label v-if="form.kind === 'volume'">
        Ajustar
        <select v-model="form.target">
          <option value="vat">Cuba</option>
          <option value="bottle">Garrafa</option>
        </select>
      </label>
      <label v-if="needsName">
        Nome
        <input v-model="form.name" maxlength="128" autocomplete="off" />
      </label>
      <label v-if="form.kind === 'bottle' || form.kind === 'volume'">
        Volume (mL)
        <input v-model="form.volume" inputmode="decimal" />
        <small v-if="form.kind === 'bottle'"
          >Deixe em branco se o volume não for informado.</small
        >
      </label>
      <label v-if="form.kind === 'film'">
        Camadas
        <input v-model="form.layers" inputmode="numeric" />
      </label>
      <label v-if="form.kind === 'lcd'">
        Horas
        <input v-model="form.hours" inputmode="decimal" />
      </label>
      <Button type="submit" :disabled="saving">Salvar registro</Button>
      <p v-if="status" role="status">{{ status }}</p>
    </form>
  </section>
</template>

<style scoped>
.resin-summary {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}
.resin-summary dt {
  font-weight: var(--font-weight-semibold);
}
.resin-summary dd {
  margin: 0;
}
.resin-form {
  display: grid;
  gap: var(--space-3);
  justify-items: start;
}
.resin-form label {
  display: grid;
  gap: var(--space-1);
}
</style>
