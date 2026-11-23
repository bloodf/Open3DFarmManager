<script setup lang="ts">
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
type Farm = { farmId: string }
type App = {
  id: string
  name: string
  sandbox: boolean
  createdAt: number
  revokedAt: number | null
}
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
const route = useRoute()
const router = useRouter()
const farms = ref<Farm[]>([])
const farmId = ref('')
let generation = 0
let controller = new AbortController()
function currentScope() {
  const id = farmId.value,
    mine = generation,
    signal = controller.signal
  return {
    id,
    signal,
    current: () =>
      id === farmId.value && mine === generation && !signal.aborted,
  }
}
const apps = ref<App[]>([])
const printers = ref<Printer[]>([])
const grants = ref<Record<string, Grant[]>>({})
const loading = ref(true)
const pending = ref(false)
const error = ref('')
const loadError = ref('')
const status = ref('')
const appName = ref('')
const clientId = ref('')
const credentialId = ref('')
const newSecret = ref('')
const alertBox = ref<HTMLElement | null>(null)
const secretPanel = ref<HTMLElement | null>(null)
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
  ['environment:read', 'Consultar ambiente'],
  ['plates:confirm', 'Confirmar placa livre'],
  ['alerts:write', 'Enviar alertas'],
  ['camera:view', 'Ver câmera'],
] as const

async function load() {
  if (!farmId.value) return
  const request = currentScope()
  loading.value = true
  error.value = ''
  loadError.value = ''
  try {
    const directory = await $fetch<Directory>(
      `/api/farms/${request.id}/integrations/apps`,
      { retry: 0, signal: request.signal },
    )
    if (!request.current()) return
    apps.value = directory.apps
    printers.value = directory.printers
    const pages = await Promise.all(
      directory.apps.map(async (app) => {
        const result = await $fetch<{ grants: Grant[] }>(
          `/api/farms/${request.id}/integrations/apps/${app.id}/grants`,
          { retry: 0, signal: request.signal },
        )
        return [app.id, result.grants] as const
      }),
    )
    if (!request.current()) return
    grants.value = Object.fromEntries(pages)
  } catch (cause) {
    if (!request.current()) return
    apps.value = []
    grants.value = {}
    const code =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : 0
    loadError.value =
      code === 401 || code === 403
        ? 'Entre como proprietária da farm para gerenciar integrações.'
        : 'Não foi possível carregar os aplicativos. Tente novamente.'
  } finally {
    if (request.current()) loading.value = false
  }
}

async function start() {
  loading.value = true
  loadError.value = ''
  try {
    const page = await $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      retry: 0,
    })
    farms.value = page.farms
    const selected =
      farms.value.find((farm) => farm.farmId === route.query.farm)?.farmId ??
      farms.value[0]?.farmId ??
      ''
    if (selected === farmId.value && selected) await load()
    else if (selected) farmId.value = selected
    else loading.value = false
    if (selected && route.query.farm !== selected)
      void router.replace({ query: { ...route.query, farm: selected } })
  } catch {
    loading.value = false
    loadError.value = 'Não foi possível carregar suas farms.'
  }
}
onMounted(start)
watch(
  farmId,
  (id, old) => {
    if (id === old) return
    generation++
    controller.abort()
    controller = new AbortController()
    apps.value = []
    printers.value = []
    grants.value = {}
    grantDrafts.value = {}
    newSecret.value = ''
    clientId.value = ''
    credentialId.value = ''
    error.value = ''
    status.value = ''
    pending.value = false
    if (id) void load()
    else loading.value = false
  },
  { flush: 'sync' },
)
watch(
  () => route.query.farm,
  (id) => {
    farmId.value =
      typeof id === 'string' && farms.value.some((farm) => farm.farmId === id)
        ? id
        : ''
  },
)
function selectFarm(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  void router.replace({ query: { ...route.query, farm: id || undefined } })
}

async function registerApp() {
  if (pending.value || !farmId.value) return
  const request = currentScope()
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    const result = await $fetch<{
      app: App
      credential: { id: string; clientId: string }
      secret: string
    }>(`/api/farms/${request.id}/integrations/apps`, {
      method: 'POST',
      body: { name: appName.value, sandbox: false },
      retry: 0,
      signal: request.signal,
    })
    if (!request.current()) return
    newSecret.value = result.secret
    clientId.value = result.credential.clientId
    credentialId.value = result.credential.id
    appName.value = ''
    status.value =
      'Aplicativo cadastrado. Copie o segredo agora; ele não será exibido novamente.'
    await load()
  } catch {
    if (!request.current()) return
    error.value =
      'Não foi possível cadastrar o aplicativo. Confirme se você é proprietária da farm.'
  } finally {
    if (request.current()) pending.value = false
  }
}

async function addGrant(app: App) {
  const draft = grantDraft(app.id)
  if (pending.value || draft.scopes.length === 0) return
  const request = currentScope()
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    await $fetch(
      `/api/farms/${request.id}/integrations/apps/${app.id}/grants`,
      {
        method: 'POST',
        body: {
          scopes: draft.scopes,
          ...(draft.printer ? { printerAssignmentId: draft.printer } : {}),
          requiresApproval: draft.approval,
        },
        retry: 0,
        signal: request.signal,
      },
    )
    if (!request.current()) return
    status.value = `Acesso concedido ao aplicativo ${app.name}.`
    grantDrafts.value[app.id] = {
      scopes: ['printers:read'],
      printer: '',
      approval: false,
    }
    await load()
  } catch {
    if (!request.current()) return
    error.value = 'Não foi possível conceder os escopos selecionados.'
  } finally {
    if (request.current()) pending.value = false
  }
}

async function removeGrant(grant: Grant) {
  if (pending.value || !window.confirm('Remover este acesso do aplicativo?'))
    return
  const request = currentScope()
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    await $fetch(`/api/farms/${request.id}/integrations/grants/${grant.id}`, {
      method: 'DELETE',
      retry: 0,
      signal: request.signal,
    })
    if (!request.current()) return
    status.value = 'Acesso removido.'
    await load()
  } catch {
    if (!request.current()) return
    error.value = 'Não foi possível remover o acesso.'
  } finally {
    if (request.current()) pending.value = false
  }
}

async function revokeApp(app: App) {
  if (
    pending.value ||
    app.revokedAt ||
    !window.confirm(
      `Revogar o aplicativo ${app.name}? Todos os acessos e webhooks serão interrompidos.`,
    )
  )
    return
  const request = currentScope()
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    await $fetch(`/api/farms/${request.id}/integrations/apps/${app.id}`, {
      method: 'DELETE',
      retry: 0,
      signal: request.signal,
    })
    if (!request.current()) return
    status.value = `Aplicativo ${app.name} revogado.`
    await load()
  } catch {
    if (!request.current()) return
    error.value = 'Não foi possível revogar o aplicativo.'
  } finally {
    if (request.current()) pending.value = false
  }
}

async function revokeCredential() {
  if (
    pending.value ||
    !credentialId.value ||
    !window.confirm(
      'Revogar esta credencial? Ela deixará de autenticar imediatamente.',
    )
  )
    return
  const request = currentScope()
  pending.value = true
  error.value = ''
  status.value = ''
  try {
    await $fetch(
      `/api/farms/${request.id}/integrations/credentials/${credentialId.value}`,
      { method: 'DELETE', retry: 0, signal: request.signal },
    )
    if (!request.current()) return
    status.value = 'Credencial revogada.'
    dismissSecret()
  } catch {
    if (!request.current()) return
    error.value = 'Não foi possível revogar a credencial.'
  } finally {
    if (request.current()) pending.value = false
  }
}

onBeforeUnmount(() => {
  generation++
  controller.abort()
})

async function copySecret() {
  const request = currentScope()
  try {
    await navigator.clipboard.writeText(newSecret.value)
    if (!request.current()) return
    status.value = 'Segredo copiado.'
  } catch {
    if (!request.current()) return
    status.value = 'Selecione e copie o segredo manualmente.'
  }
}
function dismissSecret() {
  newSecret.value = ''
  clientId.value = ''
  credentialId.value = ''
}
// Failures and the one-time secret take focus so keyboard and screen-reader
// users land on them instead of hunting for what changed.
watch([error, loadError], async ([action, load]) => {
  if (!action && !load) return
  await nextTick()
  alertBox.value?.focus()
})
watch(newSecret, async (secret) => {
  if (!secret) return
  await nextTick()
  secretPanel.value?.focus()
})
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
  <main id="conteudo" class="integrations-page" :aria-busy="loading || pending">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Integrações</h1>
      <p class="intro">
        Cadastre aplicativos e escolha quais dados ou ações podem acessar em
        cada farm ou impressora.
      </p>
    </header>
    <div ref="alertBox" class="alert" role="alert" tabindex="-1">
      <p v-if="error" class="notice notice-error">{{ error }}</p>
      <ErrorState
        v-if="loadError && !loading"
        title="Integrações indisponíveis"
        :description="loadError"
      >
        <Button @click="farmId ? load() : start()">Tentar novamente</Button>
      </ErrorState>
    </div>
    <p v-if="status" class="notice" role="status" aria-live="polite">
      {{ status }}
    </p>
    <section
      v-if="newSecret"
      ref="secretPanel"
      class="panel secret-panel"
      aria-labelledby="secret-heading"
      tabindex="-1"
    >
      <h2 id="secret-heading">Guarde o segredo do aplicativo</h2>
      <p>
        Este segredo aparece somente agora. Copie e armazene em local seguro.
      </p>
      <p>
        <strong>ID do cliente:</strong> <code class="wrap">{{ clientId }}</code>
      </p>
      <div class="field">
        <label for="one-time-secret">Segredo do cliente</label>
        <textarea
          id="one-time-secret"
          readonly
          rows="3"
          :value="newSecret"
          @focus="($event.target as HTMLTextAreaElement).select()"
        />
      </div>
      <div class="actions">
        <Button @click="copySecret">Copiar segredo</Button>
        <Button class="danger" :disabled="pending" @click="revokeCredential">
          Revogar esta credencial
        </Button>
        <Button @click="dismissSecret">Fechar e ocultar segredo</Button>
      </div>
    </section>
    <section class="panel" aria-labelledby="farm-heading">
      <h2 id="farm-heading">Escolha a farm</h2>
      <div class="field">
        <label for="integration-farm">Farm</label>
        <select
          id="integration-farm"
          :value="farmId"
          :disabled="loading || pending || farms.length === 0"
          @change="selectFarm"
        >
          <option value="" disabled>Selecione</option>
          <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
            {{ farm.farmId }}
          </option>
        </select>
      </div>
    </section>
    <div v-if="loading" aria-busy="true" class="loading panel">
      <p role="status">Carregando integrações…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <EmptyState
      v-else-if="!farmId && !loadError"
      title="Nenhuma farm disponível"
      description="Sua conta ainda não tem uma farm para gerenciar integrações. Crie ou peça acesso a uma farm e volte a esta página."
    >
      <NuxtLink to="/farm">Abrir a página da farm</NuxtLink>
    </EmptyState>
    <template v-else-if="farmId && !loadError">
      <section class="panel" aria-labelledby="register-heading">
        <h2 id="register-heading">Cadastrar aplicativo</h2>
        <form class="register" @submit.prevent="registerApp">
          <div class="field">
            <label for="app-name">Nome do aplicativo</label>
            <input
              id="app-name"
              v-model.trim="appName"
              name="name"
              maxlength="128"
              required
              autocomplete="off"
            />
          </div>
          <Button type="submit" :disabled="pending || appName.length === 0">
            Cadastrar aplicativo
          </Button>
        </form>
      </section>
      <section class="apps" aria-labelledby="apps-heading">
        <h2 id="apps-heading">Aplicativos cadastrados</h2>
        <EmptyState
          v-if="apps.length === 0"
          title="Nenhum aplicativo nesta farm"
          description="Cadastre um aplicativo no formulário acima para começar a conceder acessos."
        />
        <article v-for="app in apps" :key="app.id" class="panel app-card">
          <header class="app-head">
            <h3>{{ app.name }}</h3>
            <StatusBadge
              v-if="app.revokedAt"
              tone="error"
              label="Aplicativo revogado."
            />
            <StatusBadge v-else tone="idle" label="Ativo" />
          </header>
          <p class="meta wrap">ID: {{ app.id }}</p>
          <div class="actions">
            <Button
              class="danger"
              :disabled="pending || !!app.revokedAt"
              @click="revokeApp(app)"
            >
              Revogar aplicativo
            </Button>
          </div>
          <form
            v-if="!app.revokedAt"
            class="grant-form"
            @submit.prevent="addGrant(app)"
          >
            <fieldset>
              <legend>Escopos para conceder</legend>
              <div class="scopes">
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
                  <span>{{ label }} ({{ scope }})</span>
                </label>
              </div>
            </fieldset>
            <div class="field">
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
            </div>
            <label class="check">
              <input v-model="grantDraft(app.id).approval" type="checkbox" />
              <span>Exigir aprovação do proprietário para ações</span>
            </label>
            <div class="actions">
              <Button
                type="submit"
                :disabled="pending || grantDraft(app.id).scopes.length === 0"
              >
                Conceder escopos
              </Button>
            </div>
          </form>
          <h4>Acessos ativos</h4>
          <p v-if="(grants[app.id] ?? []).length === 0" class="meta">
            Nenhum acesso concedido.
          </p>
          <ul v-else class="grants">
            <li v-for="grant in grants[app.id] ?? []" :key="grant.id">
              <span class="wrap"
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
              <Button
                class="danger"
                :disabled="pending"
                :aria-label="`Remover acesso de ${app.name}`"
                @click="removeGrant(grant)"
              >
                Remover acesso
              </Button>
            </li>
          </ul>
        </article>
      </section>
    </template>
    <p class="back"><NuxtLink to="/farm">Voltar à farm</NuxtLink></p>
  </main>
</template>

<style scoped>
.integrations-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.eyebrow {
  margin: 0;
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.page-header h1 {
  margin: 0;
  overflow-wrap: anywhere;
}
.intro {
  margin: 0;
  color: var(--color-text-muted);
}
.alert:focus-visible,
.secret-panel:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-md);
}
.alert:empty {
  display: none;
}
.notice {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.notice:empty {
  display: none;
}
.notice-error {
  border-color: var(--printer-error);
  color: var(--printer-error);
  font-weight: var(--font-weight-semibold);
}
.panel {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel > p {
  margin-block: 0 var(--space-3);
}
h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
h3 {
  margin: 0;
  font-size: var(--font-size-lg);
  overflow-wrap: anywhere;
}
h4 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--font-size-base);
}
.loading {
  display: grid;
  gap: var(--space-3);
}
.apps {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.apps > h2 {
  margin: 0;
}
.secret-panel {
  border-color: var(--printer-paused);
}
.field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
label,
legend {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
legend {
  padding: 0;
  margin-bottom: var(--space-2);
}
select,
input:not([type='checkbox']),
textarea {
  width: 100%;
  max-width: 38rem;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
textarea {
  font-family: ui-monospace, monospace;
  resize: vertical;
}
select:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
select:disabled,
input:disabled {
  opacity: 0.6;
}
.register {
  display: grid;
  grid-template-columns: minmax(0, 38rem) auto;
  gap: var(--space-3) var(--space-4);
  align-items: end;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  align-items: center;
  margin-top: var(--space-3);
}
.register .actions,
.register > button {
  margin: 0;
}
.app-card {
  display: grid;
  gap: var(--space-2);
  align-content: start;
}
.app-card .actions {
  margin-top: 0;
}
.app-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
}
.meta {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.grant-form {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
fieldset {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.scopes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-1) var(--space-4);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
  font-weight: 400;
  font-size: var(--font-size-base);
  overflow-wrap: anywhere;
}
.check input {
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
  accent-color: var(--color-accent);
}
.grants {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.grants li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}
.wrap {
  overflow-wrap: anywhere;
  min-width: 0;
}
code {
  font-family: ui-monospace, monospace;
}
.integrations-page :deep(.danger) {
  border-color: var(--printer-error);
  color: var(--printer-error);
}
.integrations-page :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
.back {
  margin: 0;
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-4);
  }
  .register {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
