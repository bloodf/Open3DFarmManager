<script setup lang="ts">
import { reactive, ref } from 'vue'
import {
  PROFILE_FIELDS,
  SOURCE_LABELS,
  bodyFromForm,
  displayValue,
  formFromOverride,
  type ProfileForm,
  type ProfileView,
} from './fields.ts'

const props = defineProps<{
  farmId: string
  assignmentId: string
  label: string
  canManage: boolean
}>()

const base = () =>
  '/api/farms/' + props.farmId + '/printers/' + props.assignmentId + '/profile'
const prefix = 'machine-profile-' + props.assignmentId
const open = ref(false)
const loading = ref(false)
const editing = ref(false)
const profile = ref<ProfileView | null>(null)
const errorText = ref('')
const feedback = ref('')
const form = reactive<ProfileForm>({
  values: {} as ProfileForm['values'],
  compatibleModels: '',
  notes: '',
})
let controller: AbortController | undefined

async function load() {
  controller?.abort()
  const current = (controller = new AbortController())
  loading.value = true
  errorText.value = ''
  try {
    const result = await $fetch<{ profile: ProfileView }>(base(), {
      credentials: 'same-origin',
      signal: current.signal,
      retry: 0,
    })
    if (!current.signal.aborted) profile.value = result.profile
  } catch {
    if (!current.signal.aborted)
      errorText.value = 'Não foi possível carregar o perfil da máquina.'
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}

async function toggle() {
  open.value = !open.value
  if (open.value && !profile.value) await load()
}

function startEdit() {
  if (!profile.value) return
  const next = formFromOverride(profile.value.override)
  form.values = next.values
  form.compatibleModels = next.compatibleModels
  form.notes = next.notes
  feedback.value = ''
  errorText.value = ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  errorText.value = ''
}

async function save() {
  const built = bodyFromForm(form)
  if (!built.ok) {
    errorText.value =
      'Informe números maiores que zero em: ' + built.invalid.join(', ') + '.'
    return
  }
  loading.value = true
  errorText.value = ''
  try {
    const result = await $fetch<{ profile: ProfileView }>(base(), {
      method: 'PUT',
      credentials: 'same-origin',
      retry: 0,
      body: built.body,
    })
    profile.value = result.profile
    editing.value = false
    feedback.value = 'Perfil da máquina salvo.'
  } catch {
    errorText.value = 'Não foi possível salvar o perfil da máquina.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section :aria-labelledby="prefix + '-title'" class="machine-profile">
    <h3 :id="prefix + '-title'">Perfil da máquina de {{ label }}</h3>
    <button
      type="button"
      :aria-expanded="open"
      :aria-controls="prefix + '-panel'"
      @click="toggle"
    >
      {{ open ? 'Ocultar perfil da máquina' : 'Ver perfil da máquina' }}
    </button>
    <div :id="prefix + '-panel'" :hidden="!open">
      <p v-if="loading" role="status">Carregando perfil da máquina…</p>
      <p v-if="errorText" role="alert">{{ errorText }}</p>
      <p v-if="feedback" role="status">{{ feedback }}</p>
      <template v-if="profile && !editing">
        <table>
          <caption>
            Valores detectados e definidos pelo proprietário
          </caption>
          <thead>
            <tr>
              <th scope="col">Campo</th>
              <th scope="col">Detectado</th>
              <th scope="col">Definido pelo proprietário</th>
              <th scope="col">Valor efetivo</th>
              <th scope="col">Origem</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in PROFILE_FIELDS" :key="field.key">
              <th scope="row">{{ field.label }}</th>
              <td>{{ displayValue(profile.detected[field.key]) }}</td>
              <td>{{ displayValue(profile.override[field.key]) }}</td>
              <td>{{ displayValue(profile.effective.values[field.key]) }}</td>
              <td>{{ SOURCE_LABELS[profile.effective.sources[field.key]] }}</td>
            </tr>
          </tbody>
        </table>
        <dl>
          <dt>Modelos compatíveis</dt>
          <dd>
            {{
              profile.effective.compatibleModels.length
                ? profile.effective.compatibleModels.join(', ')
                : 'Nenhum informado'
            }}
          </dd>
          <dt>Observações</dt>
          <dd>{{ profile.effective.notes ?? 'Nenhuma observação' }}</dd>
        </dl>
        <button v-if="canManage" type="button" @click="startEdit">
          Editar perfil da máquina de {{ label }}
        </button>
        <p v-else>
          Somente proprietários e administradores podem editar o perfil.
        </p>
      </template>
      <form v-if="profile && editing" @submit.prevent="save">
        <fieldset :disabled="loading">
          <legend>Valores do proprietário para {{ label }}</legend>
          <p :id="prefix + '-hint'">
            Deixe um campo vazio para usar o valor detectado.
          </p>
          <p v-for="field in PROFILE_FIELDS" :key="field.key">
            <label :for="prefix + '-' + field.key">{{ field.label }}</label>
            <input
              :id="prefix + '-' + field.key"
              v-model="form.values[field.key]"
              type="text"
              :inputmode="field.kind === 'number' ? 'decimal' : undefined"
              :aria-describedby="prefix + '-hint'"
              maxlength="64"
            />
          </p>
          <p>
            <label :for="prefix + '-models'"
              >Modelos compatíveis (um por linha)</label
            >
            <textarea
              :id="prefix + '-models'"
              v-model="form.compatibleModels"
              rows="3"
            ></textarea>
          </p>
          <p>
            <label :for="prefix + '-notes'">Observações</label>
            <textarea
              :id="prefix + '-notes'"
              v-model="form.notes"
              rows="3"
              maxlength="1000"
            ></textarea>
          </p>
          <button type="submit">Salvar perfil da máquina</button>
          <button type="button" @click="cancelEdit">Cancelar</button>
        </fieldset>
      </form>
    </div>
  </section>
</template>
