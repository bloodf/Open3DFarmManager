<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import Button from '../ui/Button.vue'
import Field from '../ui/Field.vue'
import ProgressBar from '../ui/ProgressBar.vue'
import StatusBadge from '../ui/StatusBadge.vue'
import {
  extractApiError,
  reportRows,
  validateImportForm,
  type ImportFormState,
} from '../../utils/spool-library-format.ts'
import type {
  BundleProblem,
  ImportFormat,
  ImportReport,
} from '../../utils/spool-library-types.ts'

const props = defineProps<{
  farmId: string
  canImport: boolean
}>()

const form = reactive<ImportFormState>({
  format: 'spoolman-api',
  origin: '',
  bearerToken: '',
  jsonText: '',
  csvEntity: 'spools',
  csvText: '',
  source: '',
  dryRun: true,
  onCollision: 'adopt',
  onConflict: 'keep-local',
})

const running = ref(false)
const progressStep = ref('')
const progressValue = ref(0)
const fileName = ref('')
const error = ref('')
const problems = ref<BundleProblem[]>([])
const report = ref<ImportReport | null>(null)
const errorBox = ref<HTMLElement | null>(null)
const resultBox = ref<HTMLElement | null>(null)

const formats: readonly { id: ImportFormat; label: string; hint: string }[] = [
  {
    id: 'spoolman-api',
    label: 'API do Spoolman',
    hint: 'Lê fornecedores, filamentos, bobinas e campos diretamente de uma origem Spoolman autorizada.',
  },
  {
    id: 'json',
    label: 'Arquivo JSON',
    hint: 'Importa um pacote JSON exportado do Spoolman ou no formato da biblioteca.',
  },
  {
    id: 'csv',
    label: 'Arquivo CSV',
    hint: 'Importa uma tabela CSV de fornecedores, filamentos ou bobinas.',
  },
]

const rows = computed(() => (report.value ? reportRows(report.value) : []))

const originHint =
  'Use uma origem autorizada pelo servidor, ex.: http://spoolman.lan:7912'
const originPlaceholder = 'http://spoolman.lan:7912'

const conflictLabels: Record<string, string> = {
  vendor: 'Fornecedor',
  filament: 'Filamento',
  spool: 'Bobina',
  field: 'Campo extra',
  setting: 'Configuração',
}

function selectFormat(format: ImportFormat) {
  if (running.value) return
  form.format = format
  error.value = ''
  problems.value = []
  fileName.value = ''
}

async function onFileSelected(event: Event, kind: 'json' | 'csv') {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  problems.value = []
  fileName.value = file.name
  try {
    const text = await file.text()
    if (kind === 'json') form.jsonText = text
    else form.csvText = text
  } catch {
    error.value = 'Não foi possível ler o arquivo selecionado.'
    await nextTick()
    errorBox.value?.focus()
  }
}

async function runImport(overrideDryRun?: boolean) {
  if (running.value || !props.canImport) return
  error.value = ''
  problems.value = []
  const dryRun = overrideDryRun !== undefined ? overrideDryRun : form.dryRun
  const validated = validateImportForm({ ...form, dryRun })
  // Never keep secrets in reactive component state after preparing the payload.
  form.bearerToken = ''
  if (!validated.ok) {
    error.value = validated.error
    await nextTick()
    errorBox.value?.focus()
    return
  }

  running.value = true
  report.value = null
  progressValue.value = 25
  progressStep.value = dryRun
    ? 'Validando origem e preparando simulação…'
    : 'Validando origem e enviando dados para a farm…'

  try {
    await nextTick()
    progressValue.value = 60
    progressStep.value = dryRun
      ? 'Simulando importação na farm…'
      : 'Importando registros na biblioteca da farm…'

    const response = await $fetch<{ report: ImportReport }>(
      `/api/farms/${props.farmId}/spool-library/import`,
      {
        method: 'POST',
        body: validated.payload,
        retry: 0,
        timeout: 60_000,
      },
    )
    progressValue.value = 100
    progressStep.value = response.report.dryRun
      ? 'Simulação concluída.'
      : 'Importação concluída.'
    report.value = response.report
    await nextTick()
    resultBox.value?.focus()
  } catch (cause) {
    const parsed = extractApiError(
      cause,
      'Não foi possível concluir a importação. Tente novamente.',
    )
    error.value = parsed.message
    problems.value = parsed.problems
    await nextTick()
    errorBox.value?.focus()
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="import-layout">
    <section class="panel" aria-labelledby="import-form-heading">
      <h2 id="import-form-heading">Migrar ou importar biblioteca</h2>

      <p v-if="!canImport" role="status" class="notice">
        Apenas proprietários e administradores podem importar dados para a
        biblioteca de bobinas.
      </p>

      <form v-else class="import-form" novalidate @submit.prevent="runImport()">
        <fieldset class="format-fieldset" :disabled="running">
          <legend>Formato de origem</legend>
          <div class="format-buttons">
            <button
              v-for="item in formats"
              :key="item.id"
              type="button"
              class="format-option"
              :aria-pressed="form.format === item.id"
              @click="selectFormat(item.id)"
            >
              {{ item.label }}
            </button>
          </div>
          <p class="format-hint">
            {{ formats.find((f) => f.id === form.format)?.hint }}
          </p>
        </fieldset>

        <template v-if="form.format === 'spoolman-api'">
          <Field label="Endereço do Spoolman *" :hint="originHint">
            <template #default="{ control }">
              <input
                v-bind="control"
                v-model="form.origin"
                type="url"
                maxlength="255"
                :placeholder="originPlaceholder"
                :disabled="running"
                required
              />
            </template>
          </Field>

          <Field
            label="Token Bearer (opcional)"
            hint="Enviado apenas nesta leitura; nunca é salvo nem exibido novamente."
          >
            <template #default="{ control }">
              <input
                v-bind="control"
                v-model="form.bearerToken"
                type="password"
                autocomplete="off"
                maxlength="512"
                :disabled="running"
              />
            </template>
          </Field>
        </template>

        <template v-else-if="form.format === 'json'">
          <Field
            label="Carregar arquivo JSON"
            hint="Opcional: o conteúdo do arquivo será preenchido abaixo."
          >
            <template #default="{ control }">
              <input
                v-bind="control"
                type="file"
                accept=".json,application/json"
                :disabled="running"
                @change="onFileSelected($event, 'json')"
              />
            </template>
          </Field>
          <p v-if="fileName" role="status" class="file-meta">
            Arquivo carregado: {{ fileName }}
          </p>

          <Field
            label="Conteúdo JSON *"
            hint='Objeto contendo "vendors", "filaments" e/ou "spools".'
          >
            <template #default="{ control }">
              <textarea
                v-bind="control"
                v-model="form.jsonText"
                rows="8"
                spellcheck="false"
                placeholder='{"vendors": [], "filaments": [], "spools": []}'
                :disabled="running"
                required
              />
            </template>
          </Field>
        </template>

        <template v-else>
          <Field label="Tipo de registro no CSV *">
            <template #default="{ control }">
              <select
                v-bind="control"
                v-model="form.csvEntity"
                :disabled="running"
              >
                <option value="vendors">Fornecedores</option>
                <option value="filaments">Filamentos</option>
                <option value="spools">Bobinas</option>
              </select>
            </template>
          </Field>

          <Field
            label="Carregar arquivo CSV"
            hint="Exportações CSV do Spoolman são aceitas."
          >
            <template #default="{ control }">
              <input
                v-bind="control"
                type="file"
                accept=".csv,text/csv"
                :disabled="running"
                @change="onFileSelected($event, 'csv')"
              />
            </template>
          </Field>
          <p v-if="fileName" role="status" class="file-meta">
            Arquivo carregado: {{ fileName }}
          </p>

          <Field label="Conteúdo CSV *">
            <template #default="{ control }">
              <textarea
                v-bind="control"
                v-model="form.csvText"
                rows="8"
                spellcheck="false"
                placeholder="id,name,comment"
                :disabled="running"
                required
              />
            </template>
          </Field>
        </template>

        <div class="options-grid">
          <Field label="Registro igual sem vínculo">
            <template #default="{ control }">
              <select
                v-bind="control"
                v-model="form.onCollision"
                :disabled="running"
              >
                <option value="adopt">Vincular ao existente</option>
                <option value="create">Criar novo registro</option>
              </select>
            </template>
          </Field>

          <Field label="Conflito com alteração local">
            <template #default="{ control }">
              <select
                v-bind="control"
                v-model="form.onConflict"
                :disabled="running"
              >
                <option value="keep-local">Manter cópia local</option>
                <option value="overwrite">Sobrescrever com a origem</option>
              </select>
            </template>
          </Field>
        </div>

        <Field
          label="Identificador da origem (opcional)"
          hint="Reutilize o mesmo identificador em novas execuções para manter a importação idempotente."
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.source"
              type="text"
              maxlength="96"
              placeholder="ex.: spoolman-oficina"
              :disabled="running"
            />
          </template>
        </Field>

        <label class="checkbox-field">
          <input v-model="form.dryRun" type="checkbox" :disabled="running" />
          <span>Simulação (conferir resultado sem gravar alterações)</span>
        </label>

        <div v-if="running" aria-busy="true" class="progress-box">
          <p role="status">{{ progressStep }}</p>
          <ProgressBar label="Progresso da importação" :value="progressValue" />
        </div>

        <div
          v-if="error"
          ref="errorBox"
          role="alert"
          tabindex="-1"
          class="error-box"
        >
          <p>
            <strong>{{ error }}</strong>
          </p>
          <ul v-if="problems.length" class="problem-list">
            <li
              v-for="(item, index) in problems"
              :key="`${item.path}-${index}`"
            >
              <code>{{ item.path }}</code>: {{ item.problem }}
            </li>
          </ul>
        </div>

        <div class="form-actions">
          <Button type="submit" class="primary" :disabled="running">
            {{
              running
                ? 'Processando…'
                : form.dryRun
                  ? 'Simular importação'
                  : 'Executar importação'
            }}
          </Button>
        </div>
      </form>
    </section>

    <section
      v-if="report"
      ref="resultBox"
      tabindex="-1"
      class="panel result-panel"
      aria-labelledby="import-result-heading"
    >
      <div class="result-header">
        <h2 id="import-result-heading">Resultado da importação</h2>
        <StatusBadge
          :tone="report.dryRun ? 'paused' : 'idle'"
          :label="report.dryRun ? 'Simulação' : 'Concluída'"
        />
      </div>

      <p role="status" class="notice">
        <template v-if="report.dryRun">
          Simulação concluída sem gravar alterações. Origem:
          <strong>{{ report.sourceKey }}</strong>.
        </template>
        <template v-else>
          Importação aplicada com sucesso. Origem:
          <strong>{{ report.sourceKey }}</strong>.
        </template>
      </p>

      <div
        class="table-scroll"
        tabindex="0"
        role="region"
        aria-label="Resumo quantitativo da importação"
      >
        <table>
          <caption>
            Contagem por tipo de registro (execução
            {{
              report.runId.slice(0, 8)
            }})
          </caption>
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              <th scope="col">Criados</th>
              <th scope="col">Atualizados</th>
              <th scope="col">Vinculados</th>
              <th scope="col">Sem alteração</th>
              <th scope="col">Conflitos</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <th scope="row">{{ row.label }}</th>
              <td>{{ row.counts.created }}</td>
              <td>{{ row.counts.updated }}</td>
              <td>{{ row.counts.adopted }}</td>
              <td>{{ row.counts.unchanged }}</td>
              <td>{{ row.counts.conflicts }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="report.truncated > 0" class="meta-note">
        {{ report.truncated }} campo(s) foram ajustados ao limite de tamanho da
        biblioteca.
      </p>

      <p v-if="report.skippedSettings.length" class="meta-note">
        Configurações ignoradas da origem:
        {{ report.skippedSettings.join(', ') }}.
      </p>

      <div v-if="report.conflicts.length" class="conflicts-box">
        <h3>Conflitos detectados ({{ report.conflicts.length }})</h3>
        <ul>
          <li
            v-for="conflict in report.conflicts"
            :key="`${conflict.kind}-${conflict.id}`"
          >
            {{ conflictLabels[conflict.kind] ?? conflict.kind }} · origem
            <code>{{ conflict.id }}</code>
          </li>
        </ul>
      </div>

      <div class="result-actions">
        <Button
          v-if="report.dryRun && canImport"
          class="primary"
          :disabled="running"
          @click="runImport(false)"
        >
          Aplicar importação agora
        </Button>
        <NuxtLink
          :to="{ path: '/bobinas', query: { farm: farmId } }"
          class="cta"
        >
          Ver bobinas
        </NuxtLink>
        <NuxtLink
          :to="{ path: '/bobinas/filamentos', query: { farm: farmId } }"
          class="cta"
        >
          Ver filamentos
        </NuxtLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.import-layout {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.panel {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.panel h2,
.panel h3 {
  margin: 0;
  font-size: var(--font-size-lg);
}
.import-form {
  display: grid;
  gap: var(--space-3);
  max-width: 44rem;
  min-width: 0;
}
.format-fieldset {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.format-fieldset legend {
  padding-inline: var(--space-1);
  font-weight: var(--font-weight-semibold);
}
.format-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.format-option {
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}
.format-option[aria-pressed='true'] {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.format-hint,
.file-meta,
.meta-note {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.options-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
}
.import-form input:not([type='checkbox']),
.import-form select,
.import-form textarea {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.import-form textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-size-sm);
}
.checkbox-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
  font-weight: var(--font-weight-semibold);
}
.checkbox-field input {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}
.import-form input:focus-visible,
.import-form select:focus-visible,
.import-form textarea:focus-visible,
.format-option:focus-visible,
.cta:focus-visible,
.table-scroll:focus-visible,
.error-box:focus-visible,
.result-panel:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.progress-box {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--color-accent);
  border-radius: var(--radius-sm);
}
.progress-box p {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
.notice {
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--color-accent);
  border-radius: var(--radius-sm);
}
.error-box {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--printer-error);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}
.error-box p {
  margin: 0;
}
.problem-list {
  margin: 0;
  padding-inline-start: var(--space-4);
  font-size: var(--font-size-sm);
}
.form-actions,
.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: var(--font-weight-semibold);
}
.result-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}
.table-scroll {
  overflow-x: auto;
  max-inline-size: 100%;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}
caption {
  text-align: start;
  color: var(--color-text-muted);
  margin-bottom: var(--space-2);
}
th,
td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  text-align: start;
}
th {
  font-weight: var(--font-weight-semibold);
}
.conflicts-box ul {
  margin: var(--space-2) 0 0;
  padding-inline-start: var(--space-4);
  font-size: var(--font-size-sm);
}
.cta {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-3);
  }
}
</style>
