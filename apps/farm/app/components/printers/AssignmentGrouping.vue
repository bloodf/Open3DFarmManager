<script setup lang="ts">
import { ref } from 'vue'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'
import {
  usePrinterSetup,
  type Printer,
} from '../../utils/printer-setup-state.ts'

const { printer } = defineProps<{ printer: Printer }>()
const { canManage, farmId, pending, printers } = usePrinterSetup()
const { run } = usePrinterSetupActions()

const editing = ref(false)
const feedback = ref('')
const displayName = ref('')
const groupName = ref('')
const location = ref('')
const sortOrder = ref<number | ''>('')

function startEdit() {
  displayName.value = printer.displayName ?? ''
  groupName.value = printer.groupName ?? ''
  location.value = printer.location ?? ''
  sortOrder.value = printer.sortOrder ?? ''
  feedback.value = ''
  editing.value = true
}

async function save() {
  if (!canManage.value || printer.status !== 'active') return
  const target = printer
  const farm = farmId.value
  const grouping = {
    displayName: displayName.value.trim() || null,
    groupName: groupName.value.trim() || null,
    location: location.value.trim() || null,
    sortOrder: sortOrder.value === '' ? null : sortOrder.value,
  }

  await run(async (signal) => {
    feedback.value = ''
    try {
      await $fetch(
        '/api/farms/' + farm + '/printers/' + target.assignmentId + '/grouping',
        {
          method: 'POST',
          credentials: 'same-origin',
          signal,
          retry: 0,
          body: {
            agentId: target.agentId,
            printerKey: target.printerKey,
            ...grouping,
          },
        },
      )
      if (signal.aborted || farmId.value !== farm) return
      printers.value = printers.value.map((row) =>
        row.assignmentId === target.assignmentId
          ? { ...row, ...grouping }
          : row,
      )
      editing.value = false
      feedback.value = 'Dados da impressora salvos.'
    } catch (error) {
      if (signal.aborted || farmId.value !== farm) return
      feedback.value =
        error instanceof Error && 'status' in error && error.status === 409
          ? 'Já existe uma impressora com este nome na farm.'
          : 'Não foi possível salvar os dados da impressora.'
    }
  })
}
</script>

<template>
  <dl
    v-if="
      printer.displayName ||
      printer.groupName ||
      printer.location ||
      printer.sortOrder != null
    "
  >
    <template v-if="printer.displayName">
      <dt>Nome de exibição</dt>
      <dd>{{ printer.displayName }}</dd>
    </template>
    <template v-if="printer.groupName">
      <dt>Grupo</dt>
      <dd>{{ printer.groupName }}</dd>
    </template>
    <template v-if="printer.location">
      <dt>Localização</dt>
      <dd>{{ printer.location }}</dd>
    </template>
    <template v-if="printer.sortOrder != null">
      <dt>Ordem de exibição</dt>
      <dd>{{ printer.sortOrder }}</dd>
    </template>
  </dl>
  <template v-if="canManage && printer.status === 'active'">
    <button
      v-if="!editing"
      type="button"
      :disabled="pending"
      @click="startEdit"
    >
      Editar dados de {{ printer.displayName || printer.printerKey }}
    </button>
    <form v-else @submit.prevent="save">
      <fieldset :disabled="pending">
        <legend>
          Dados de {{ printer.displayName || printer.printerKey }}
        </legend>
        <label
          >Nome de exibição <input v-model="displayName" maxlength="128"
        /></label>
        <label>Grupo <input v-model="groupName" maxlength="128" /></label>
        <label>Localização <input v-model="location" maxlength="128" /></label>
        <label
          >Ordem de exibição
          <input
            v-model.number="sortOrder"
            type="number"
            min="0"
            max="9999"
            step="1"
        /></label>
        <button type="submit">Salvar</button>
        <button
          type="button"
          @click="
            editing = false
            feedback = ''
          "
        >
          Cancelar
        </button>
      </fieldset>
    </form>
    <p role="status">{{ feedback }}</p>
  </template>
</template>
