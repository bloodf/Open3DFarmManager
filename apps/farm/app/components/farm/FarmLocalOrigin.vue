<script setup lang="ts">
import {
  localInterfaceOrigin,
  resolvedLocalInterfaceOrigin,
  type FarmRow,
} from '../../utils/farm-view.ts'

defineProps<{
  row: FarmRow & {
    draft?: { value: string; confirmed: boolean; error: string }
  }
}>()

const emit = defineEmits<{
  setup: [assignmentId: string]
  save: [assignmentId: string]
  cancel: [assignmentId: string]
}>()

function displayLocalOrigin(row: FarmRow) {
  return resolvedLocalInterfaceOrigin(
    row.localOrigin,
    row.observation?.state.localWebUiOrigin,
  )
}
</script>

<template>
  <template v-if="displayLocalOrigin(row)">
    <p class="opaque">
      Interface local da impressora:
      {{ displayLocalOrigin(row) }}
    </p>
    <a
      :href="displayLocalOrigin(row) ?? undefined"
      target="_blank"
      rel="noopener noreferrer"
      referrerpolicy="no-referrer"
      :aria-describedby="`local-help-${row.assignment.assignmentId}`"
      >Abrir interface local de
      <span class="opaque">{{ row.assignment.printerKey }}</span></a
    >
    <p>Abre em outra aba.</p>
  </template>
  <button type="button" @click="emit('setup', row.assignment.assignmentId)">
    {{
      displayLocalOrigin(row)
        ? 'Alterar interface local'
        : 'Configurar interface local'
    }}
  </button>
  <form
    v-if="row.draft"
    @submit.prevent="emit('save', row.assignment.assignmentId)"
  >
    <label :for="`origin-${row.assignment.assignmentId}`"
      >Origem da interface local</label
    >
    <input
      :id="`origin-${row.assignment.assignmentId}`"
      v-model="row.draft.value"
      type="url"
      required
      autocomplete="off"
      spellcheck="false"
      :aria-describedby="`local-help-${row.assignment.assignmentId}`"
      @input="row.draft.confirmed = false"
    />
    <p class="opaque">
      Origem para conferir:
      {{
        localInterfaceOrigin(row.draft.value) ?? 'Informe uma origem válida.'
      }}
    </p>
    <label class="confirmation"
      ><input v-model="row.draft.confirmed" type="checkbox" required />Conferi
      que este endereço abre a interface local desta impressora.</label
    >
    <p v-if="row.draft.error" role="alert">
      {{ row.draft.error }}
    </p>
    <div class="actions">
      <button type="submit">Confirmar interface local</button
      ><button
        type="button"
        @click="emit('cancel', row.assignment.assignmentId)"
      >
        Cancelar
      </button>
    </div>
  </form>
  <p :id="`local-help-${row.assignment.assignmentId}`">
    Acessível apenas se este navegador alcançar a rede da impressora. O endereço
    não foi verificado. O endereço fica somente na memória desta aba e precisa
    ser confirmado novamente após recarregar.
  </p>
</template>
