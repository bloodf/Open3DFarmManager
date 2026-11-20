<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  bambuCloudPrinterLabel,
  fetchBambuCloudPrinters,
  type BambuCloudPrinterDiscovery,
} from '../../utils/bambu-cloud-printers.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const { farmId, bambuSerial, onboardingFamily, kobraLabel } = usePrinterSetup()

const printers = ref<BambuCloudPrinterDiscovery[]>([])
const skippedMalformed = ref(0)
const busy = ref(false)
const message = ref('')
const failed = ref(false)
const summary = ref<HTMLElement | null>(null)

async function report(text: string, isError: boolean) {
  message.value = text
  failed.value = isError
  await nextTick()
  summary.value?.focus()
}

async function load() {
  if (!farmId.value || busy.value) return
  busy.value = true
  message.value = ''
  failed.value = false
  try {
    const known = bambuSerial.value.trim()
      ? [bambuSerial.value.trim().toUpperCase()]
      : []
    const response = await fetchBambuCloudPrinters(farmId.value, known)
    printers.value = response.printers
    skippedMalformed.value = response.skippedMalformed
    const base = response.printers.length
      ? `${response.printers.length} impressora(s) na conta Bambu Cloud.`
      : 'Nenhuma impressora nova na conta Bambu Cloud.'
    await report(
      response.skippedMalformed > 0
        ? `${base} ${response.skippedMalformed} entrada(s) inválida(s) ignorada(s).`
        : base,
      false,
    )
  } catch {
    printers.value = []
    skippedMalformed.value = 0
    await report(
      'Não foi possível listar as impressoras da conta Bambu Cloud.',
      true,
    )
  } finally {
    busy.value = false
  }
}

function select(printer: BambuCloudPrinterDiscovery) {
  onboardingFamily.value = 'bambu-lan'
  bambuSerial.value = printer.serial
  kobraLabel.value = printer.name
}

watch(farmId, () => {
  printers.value = []
  skippedMalformed.value = 0
  message.value = ''
  failed.value = false
})
</script>

<template>
  <section aria-labelledby="bambu-cloud-printers-title">
    <h2 id="bambu-cloud-printers-title">Impressoras da conta Bambu Cloud</h2>
    <p class="help">
      Prefill do formulário Bambu Lab (LAN) com série, apelido, modelo e bico. O
      IP e o código de acesso LAN ainda são informados manualmente.
    </p>
    <button type="button" :disabled="busy || !farmId" @click="load">
      {{ busy ? 'Carregando…' : 'Listar impressoras da conta' }}
    </button>
    <p
      ref="summary"
      tabindex="-1"
      role="status"
      aria-live="polite"
      :class="{ error: failed }"
    >
      {{ message }}
    </p>
    <ul v-if="printers.length">
      <li v-for="printer in printers" :key="printer.serial">
        {{ bambuCloudPrinterLabel(printer) }}
        <button type="button" @click="select(printer)">
          Usar {{ printer.name }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped src="./printer-setup.css"></style>
