<script setup lang="ts">
import { computed, reactive } from 'vue'
import {
  MACRO_PARAM_MAX_VALUE_CHARS,
  MacroParams,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'
import Button from '../ui/Button.vue'

type MacroEntry = {
  name: string
  params: readonly { name: string; default?: string }[]
}

const props = defineProps<{
  /** True only when the printer advertises the `run_macro` control. */
  advertised: boolean
  /** Public macros (never `_`-prefixed) with the parameters they read. */
  macros: readonly MacroEntry[]
  /** False in degraded mode, for a role without the scope or in flight. */
  canCommand: boolean
  /** Why the control is off; the catalog reason when not advertised. */
  disabledReason?: string
}>()
const emit = defineEmits<{
  (
    e: 'run-macro',
    name: string,
    params: Record<string, string> | undefined,
    event: Event,
  ): void
}>()

const values = reactive<Record<string, string>>({})
const notes = reactive<Record<string, string>>({})
const visible = computed(() =>
  props.macros.filter(({ name }) => !name.startsWith('_')),
)

const fieldId = (macro: string, param: string) => `macro-${macro}-${param}`
const key = (macro: string, param: string) => `${macro}\u0000${param}`

function run(macro: MacroEntry, event: Event) {
  if (!props.canCommand) return
  // A blank field is left out so the macro applies its own default.
  const entered = Object.fromEntries(
    macro.params.flatMap(({ name }) => {
      const value = (values[key(macro.name, name)] ?? '').trim()
      return value === '' ? [] : [[name, value]]
    }),
  )
  if (!Object.keys(entered).length) {
    notes[macro.name] = ''
    emit('run-macro', macro.name, undefined, event)
    return
  }
  if (!MacroParams.safeParse(entered).success) {
    notes[macro.name] =
      `Use até ${MACRO_PARAM_MAX_VALUE_CHARS} caracteres por valor, sem espaços, ponto e vírgula, # ou *.`
    return
  }
  notes[macro.name] = ''
  emit('run-macro', macro.name, entered, event)
}
</script>

<template>
  <section aria-labelledby="macros-title">
    <h2 id="macros-title">Macros</h2>
    <p v-if="!advertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <template v-else>
      <p v-if="!canCommand" id="macros-reason">
        {{
          disabledReason ??
          'Indisponível: apenas administradores podem executar macros.'
        }}
      </p>
      <p v-if="!visible.length">Nenhuma macro pública encontrada.</p>
      <ul v-else class="macros">
        <li v-for="macro in visible" :key="macro.name">
          <form class="macro" @submit.prevent>
            <h3>{{ macro.name }}</h3>
            <template v-if="macro.params.length">
              <div v-for="param in macro.params" :key="param.name">
                <label :for="fieldId(macro.name, param.name)">{{
                  param.name
                }}</label>
                <input
                  :id="fieldId(macro.name, param.name)"
                  v-model="values[key(macro.name, param.name)]"
                  type="text"
                  :maxlength="MACRO_PARAM_MAX_VALUE_CHARS"
                  :placeholder="
                    param.default !== undefined
                      ? `Padrão: ${param.default}`
                      : 'Opcional'
                  "
                  :disabled="!canCommand"
                  :aria-describedby="!canCommand ? 'macros-reason' : undefined"
                />
              </div>
            </template>
            <div class="macro__actions">
              <Button
                type="button"
                :disabled="!canCommand"
                :aria-describedby="!canCommand ? 'macros-reason' : undefined"
                @click="run(macro, $event)"
                >Executar {{ macro.name }}</Button
              >
            </div>
            <p v-if="notes[macro.name]" role="status">
              {{ notes[macro.name] }}
            </p>
          </form>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.macros {
  display: grid;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
}
.macro {
  display: grid;
  gap: var(--space-2);
  max-width: 24rem;
}
.macro__actions {
  display: flex;
  flex-wrap: wrap;
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
