<script setup lang="ts">
type Farm = { farmId: string }
type App = { id: string; name: string; sandbox: boolean; createdAt: number }
type Printer = { assignmentId: string; printerKey: string }
type Grant = {
  id: string
  appId: string
  farmId: string
  printerAssignmentId: string | null
  scopes: string[]
  requiresApproval: boolean
}
type Directory = { apps: App[]; printers: Printer[] }
const farms = ref<Farm[]>([])
const farmId = ref('')
const apps = ref<App[]>([])
const printers = ref<Printer[]>([])
const grants = ref<Record<string, Grant[]>>({})
const loading = ref(true)
const pending = ref(false)
const error = ref('')
const status = ref('')
const appName = ref('')
const clientId = ref('')
const newSecret = ref('')
const grantDrafts = ref<
  Record<string, { scopes: string[]; printer: string; approval: boolean }>
>({})
const scopeOptions = [
  ['printers:read', 'Consultar impressoras'],
  ['files:read', 'Consultar arquivos'],
  ['inventory:read', 'Consultar inventário'],
  ['jobs:read', 'Consultar trabalhos'],
  ['jobs:start', 'Iniciar trabalhos'],
  ['control:basic', 'Controles básicos'],
  ['control:extended', 'Controles avançados'],
  ['events:subscribe', 'Receber eventos'],
] as const

async function load() {
  if (!farmId.value) return
  loading.value = true
  error.value = ''
  try {
    const directory = await $fetch<Directory>(
      `/api/farms/${farmId.value}/integrations/apps`,
      { retry: 0 },
    )
    apps.value = directory.apps
    printers.value = directory.printers
    const pages = await Promise.all(
      directory.apps.map(async (app) => {
        const result = await $fetch<{ grants: Grant[] }>(
          `/api/farms/${farmId.value}/integrations/apps/${app.id}/grants`,
          { retry: 0 },
        )
        return [app.id, result.grants] as const
      }),
    )
    grants.value = Object.fromEntries(pages)
  } catch (cause) {
    apps.value = []
    grants.value = {}
    const code =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : 0
    error.value =
      code === 401 || code === 403
        ? 'Entre como proprietária da farm para gerenciar integrações.'
        : 'Não foi possível carregar os aplicativos. Tente novamente.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  try {
    const page = await $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      retry: 0,
    })
    farms.value = page.farms
    farmId.value = farms.value[0]?.farmId ?? ''
    if (farmId.value) await load()
    else {
      loading.value = false
      error.value = 'Nenhuma farm disponível para gerenciar.'
    }
  } catch {
    loading.value = false
    error.value = 'Não foi possível carregar suas farms.'
  }
})
watch(farmId, () => {
  if (!loading.value) void load()
})

async function registerApp() {
  if (pending.value || !farmId.value) return
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    const result = await $fetch<{
      app: App
      credential: { clientId: string }
      secret: string
    }>(`/api/farms/${farmId.value}/integrations/apps`, {
      method: 'POST',
      body: { name: appName.value, sandbox: false },
      retry: 0,
    })
    newSecret.value = result.secret
    clientId.value = result.credential.clientId
    appName.value = ''
    status.value =
      'Aplicativo cadastrado. Copie o segredo agora; ele não será exibido novamente.'
    await load()
  } catch {
    error.value =
      'Não foi possível cadastrar o aplicativo. Confirme se você é proprietária da farm.'
  } finally {
    pending.value = false
  }
}

async function addGrant(app: App) {
  const draft = grantDraft(app.id)
  if (pending.value || draft.scopes.length === 0) return
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    await $fetch(
      `/api/farms/${farmId.value}/integrations/apps/${app.id}/grants`,
      {
        method: 'POST',
        body: {
          scopes: draft.scopes,
          ...(draft.printer ? { printerAssignmentId: draft.printer } : {}),
          requiresApproval: draft.approval,
        },
        retry: 0,
      },
    )
    status.value = `Acesso concedido ao aplicativo ${app.name}.`
    grantDrafts.value[app.id] = {
      scopes: ['printers:read'],
      printer: '',
      approval: false,
    }
    await load()
  } catch {
    error.value = 'Não foi possível conceder os escopos selecionados.'
  } finally {
    pending.value = false
  }
}

async function removeGrant(grant: Grant) {
  if (pending.value || !window.confirm('Remover este acesso do aplicativo?'))
    return
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    await $fetch(`/api/farms/${farmId.value}/integrations/grants/${grant.id}`, {
      method: 'DELETE',
      retry: 0,
    })
    status.value = 'Acesso removido.'
    await load()
  } catch {
    error.value = 'Não foi possível remover o acesso.'
  } finally {
    pending.value = false
  }
}

async function copySecret() {
  try {
    await navigator.clipboard.writeText(newSecret.value)
    status.value = 'Segredo copiado.'
  } catch {
    status.value = 'Selecione e copie o segredo manualmente.'
  }
}
function dismissSecret() {
  newSecret.value = ''
  clientId.value = ''
}
function labelScope(scope: string) {
  return scopeOptions.find(([value]) => value === scope)?.[1] ?? scope
}
function grantDraft(appId: string) {
  return (grantDrafts.value[appId] ??= {
    scopes: ['printers:read'],
    printer: '',
    approval: false,
  })
}
</script>

<template>
  <main>
    <h1>Integrações</h1>
    <p>
      Cadastre aplicativos e escolha quais dados ou ações podem acessar em cada
      farm ou impressora.
    </p>
    <label for="integration-farm">Farm</label>
    <select
      id="integration-farm"
      v-model="farmId"
      :disabled="loading || pending || farms.length === 0"
    >
      <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
        {{ farm.farmId }}
      </option>
    </select>
    <p v-if="error" role="alert" tabindex="-1">{{ error }}</p>
    <p role="status" aria-live="polite">{{ status }}</p>
    <p v-if="loading" role="status" aria-busy="true">Carregando integrações…</p>
    <template v-else-if="farmId">
      <section aria-labelledby="register-heading">
        <h2 id="register-heading">Cadastrar aplicativo</h2>
        <form @submit.prevent="registerApp">
          <label for="app-name">Nome do aplicativo</label>
          <input
            id="app-name"
            v-model.trim="appName"
            name="name"
            maxlength="128"
            required
            autocomplete="off"
          />
          <button type="submit" :disabled="pending || appName.length === 0">
            Cadastrar aplicativo
          </button>
        </form>
      </section>
      <section aria-labelledby="apps-heading">
        <h2 id="apps-heading">Aplicativos cadastrados</h2>
        <p v-if="apps.length === 0">
          Nenhum aplicativo nesta farm. Cadastre um para começar.
        </p>
        <article v-for="app in apps" :key="app.id" class="app-card">
          <h3>{{ app.name }}</h3>
          <p class="wrap">ID: {{ app.id }}</p>
          <form @submit.prevent="addGrant(app)">
            <fieldset>
              <legend>Escopos para conceder</legend>
              <label
                v-for="[scope, label] in scopeOptions"
                :key="scope"
                class="check"
              >
                <input
                  v-model="grantDraft(app.id).scopes"
                  type="checkbox"
                  :value="scope"
                />
                {{ label }} ({{ scope }})
              </label>
            </fieldset>
            <label :for="`printer-${app.id}`"
              >Limitar à impressora (opcional)</label
            >
            <select
              :id="`printer-${app.id}`"
              v-model="grantDraft(app.id).printer"
            >
              <option value="">Todas as impressoras da farm</option>
              <option
                v-for="printer in printers"
                :key="printer.assignmentId"
                :value="printer.assignmentId"
              >
                {{ printer.printerKey }} — {{ printer.assignmentId }}
              </option>
            </select>
            <label class="check"
              ><input v-model="grantDraft(app.id).approval" type="checkbox" />
              Exigir aprovação do proprietário para ações</label
            >
            <button
              type="submit"
              :disabled="pending || grantDraft(app.id).scopes.length === 0"
            >
              Conceder escopos
            </button>
          </form>
          <h4>Acessos ativos</h4>
          <p v-if="(grants[app.id] ?? []).length === 0">
            Nenhum acesso concedido.
          </p>
          <ul>
            <li v-for="grant in grants[app.id] ?? []" :key="grant.id">
              <span
                >{{
                  grant.printerAssignmentId
                    ? `Impressora ${grant.printerAssignmentId}`
                    : 'Todas as impressoras'
                }}
                — {{ grant.scopes.map(labelScope).join(', ')
                }}<span v-if="grant.requiresApproval">
                  — requer aprovação</span
                ></span
              >
              <button
                type="button"
                :disabled="pending"
                :aria-label="`Remover acesso de ${app.name}`"
                @click="removeGrant(grant)"
              >
                Remover acesso
              </button>
            </li>
          </ul>
        </article>
      </section>
    </template>
    <section
      v-if="newSecret"
      aria-labelledby="secret-heading"
      class="secret-panel"
    >
      <h2 id="secret-heading">Guarde o segredo do aplicativo</h2>
      <p>
        Este segredo aparece somente agora. Copie e armazene em local seguro.
      </p>
      <p>
        <strong>ID do cliente:</strong> <code class="wrap">{{ clientId }}</code>
      </p>
      <label for="one-time-secret">Segredo do cliente</label>
      <textarea
        id="one-time-secret"
        readonly
        rows="3"
        :value="newSecret"
        @focus="($event.target as HTMLTextAreaElement).select()"
      />
      <button type="button" @click="copySecret">Copiar segredo</button>
      <button type="button" @click="dismissSecret">
        Fechar e ocultar segredo
      </button>
    </section>
    <p><NuxtLink to="/farm">Voltar à farm</NuxtLink></p>
  </main>
</template>

<style scoped>
main {
  max-width: 56rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
label,
select,
input:not([type='checkbox']),
textarea {
  display: block;
  font: inherit;
}
label {
  margin-top: 0.75rem;
  font-weight: 600;
}
select,
input:not([type='checkbox']),
textarea {
  width: 100%;
  max-width: 38rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
}
button {
  min-height: 2.75rem;
  margin: 0.5rem 0.5rem 0.5rem 0;
  padding: 0.5rem 0.75rem;
  font: inherit;
}
fieldset {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: 0.25rem 1rem;
  margin: 1rem 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.check input {
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
}
.app-card,
.secret-panel {
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  padding: 1rem;
  margin: 1rem 0;
  min-width: 0;
}
.wrap {
  overflow-wrap: anywhere;
}
li {
  margin-block: 0.5rem;
}
:is(button, select, input, textarea, a):focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
