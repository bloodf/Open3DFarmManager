<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'

type Farm = { farmId: string }
type Mqtt = { host: string; port: number; username: string }
type AccountView = {
  connected: boolean
  region: 'global' | 'china' | null
  account: string | null
  expiresAt: string | null
  expired: boolean
  mqtt: Mqtt | null
}
type ConnectResponse = AccountView | { tfaRequired: true; tfaKey: string }

const farms = ref<Farm[]>([])
const farmId = ref('')
const account = ref<AccountView | null>(null)
const mode = ref<'email-code' | 'password' | 'token' | 'tfa'>('email-code')
const region = ref<'global' | 'china'>('global')
const email = ref('')
const code = ref('')
const password = ref('')
const accessToken = ref('')
const refreshToken = ref('')
const expiresAt = ref('')
const tfaKey = ref('')
const tfaCode = ref('')
const loading = ref(true)
const pending = ref(false)
const unavailable = ref(false)
const message = ref('')
const error = ref(false)
const summary = ref<HTMLElement | null>(null)

const when = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
})

// The farm list itself failed: there is nothing to select and no form to show.
const farmsFailed = computed(
  () => error.value && !farmId.value && !loading.value,
)

const expiryLabel = computed(() => {
  const value = account.value?.expiresAt
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return when.format(date)
})

function statusCode(cause: unknown) {
  if (typeof cause !== 'object' || cause === null || !('statusCode' in cause))
    return undefined
  const value = cause.statusCode
  return typeof value === 'number' ? value : undefined
}

function clearSecrets() {
  code.value = ''
  password.value = ''
  accessToken.value = ''
  refreshToken.value = ''
  tfaCode.value = ''
}

async function report(text: string, failed: boolean) {
  message.value = text
  error.value = failed
  await nextTick()
  summary.value?.focus()
}

async function loadStatus() {
  if (!farmId.value) return
  unavailable.value = false
  try {
    account.value = await $fetch<AccountView>(
      `/api/farms/${farmId.value}/bambu-cloud`,
      { retry: 0, timeout: 15_000 },
    )
  } catch (cause: unknown) {
    account.value = null
    const status = statusCode(cause)
    if (status === 404) {
      unavailable.value = true
      return
    }
    await report(
      status === 403
        ? 'Apenas o proprietário conecta a conta Bambu Cloud.'
        : 'Não foi possível carregar a conta Bambu Cloud.',
      true,
    )
  }
}

async function load() {
  loading.value = true
  message.value = ''
  error.value = false
  try {
    const page = await $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      retry: 0,
      timeout: 15_000,
    })
    farms.value = page.farms
    farmId.value = page.farms[0]?.farmId ?? ''
    if (farmId.value) await loadStatus()
  } catch {
    await report('Não foi possível carregar as farms.', true)
  } finally {
    loading.value = false
  }
}

function body() {
  if (mode.value === 'tfa')
    return {
      mode: 'tfa' as const,
      account: email.value,
      tfaKey: tfaKey.value,
      tfaCode: tfaCode.value,
      region: region.value,
    }
  if (mode.value === 'password')
    return {
      mode: 'password' as const,
      account: email.value,
      password: password.value,
      region: region.value,
    }
  if (mode.value === 'token')
    return {
      mode: 'token' as const,
      account: email.value,
      accessToken: accessToken.value,
      ...(refreshToken.value ? { refreshToken: refreshToken.value } : {}),
      expiresAt: new Date(expiresAt.value).toISOString(),
      region: region.value,
    }
  return {
    mode: 'email-code' as const,
    account: email.value,
    code: code.value,
    region: region.value,
  }
}

async function connect() {
  if (pending.value || !farmId.value || unavailable.value) return
  pending.value = true
  message.value = ''
  error.value = false
  try {
    const response = await $fetch<ConnectResponse>(
      `/api/farms/${farmId.value}/bambu-cloud`,
      { method: 'POST', body: body(), retry: 0, timeout: 15_000 },
    )
    clearSecrets()
    if ('tfaRequired' in response) {
      tfaKey.value = response.tfaKey
      mode.value = 'tfa'
      await report('Informe o código de verificação.', false)
      return
    }
    tfaKey.value = ''
    mode.value = 'email-code'
    account.value = response
    await report(
      response.expired
        ? 'Conta conectada. O token expirou.'
        : 'Conta Bambu Cloud conectada.',
      false,
    )
  } catch (cause: unknown) {
    clearSecrets()
    const status = statusCode(cause)
    await report(
      status === 403
        ? 'Apenas o proprietário conecta a conta Bambu Cloud.'
        : status === 422
          ? 'A nuvem recusou o código, a senha ou o token.'
          : status === 429
            ? 'Muitas tentativas. Aguarde antes de tentar novamente.'
            : 'Não foi possível conectar a conta Bambu Cloud.',
      true,
    )
  } finally {
    pending.value = false
  }
}

function cancelTfa() {
  tfaKey.value = ''
  tfaCode.value = ''
  mode.value = 'password'
  message.value = ''
}

async function disconnect() {
  if (pending.value || !farmId.value) return
  pending.value = true
  message.value = ''
  error.value = false
  try {
    account.value = await $fetch<AccountView>(
      `/api/farms/${farmId.value}/bambu-cloud`,
      { method: 'DELETE', retry: 0, timeout: 15_000 },
    )
    clearSecrets()
    tfaKey.value = ''
    await report('Conta Bambu Cloud desconectada.', false)
  } catch (cause: unknown) {
    const status = statusCode(cause)
    await report(
      status === 403
        ? 'Apenas o proprietário desconecta a conta Bambu Cloud.'
        : 'Não foi possível desconectar a conta Bambu Cloud.',
      true,
    )
  } finally {
    pending.value = false
  }
}

onMounted(load)
</script>

<template>
  <main id="conteudo" class="bambu-page" :aria-busy="loading || pending">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Conta Bambu Cloud</h1>
      <p class="intro">
        Uma conta por farm. O token fica criptografado no servidor e não volta
        para esta tela.
      </p>
    </header>
    <div
      ref="summary"
      class="alert"
      :role="error ? 'alert' : 'status'"
      tabindex="-1"
    >
      <p v-if="message" class="notice" :class="{ 'notice-error': error }">
        {{ message }}
      </p>
    </div>
    <div v-if="loading" class="loading panel" aria-busy="true">
      <p role="status">Carregando a conta Bambu Cloud.</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <ErrorState
      v-else-if="farmsFailed"
      title="Farms indisponíveis"
      description="Não foi possível listar suas farms. Tente carregar de novo."
    >
      <Button @click="load">Tentar novamente</Button>
    </ErrorState>
    <EmptyState
      v-else-if="!farmId"
      title="Nenhuma farm disponível"
      description="Esta conta ainda não tem acesso a uma farm para conectar a Bambu Cloud."
    >
      <NuxtLink to="/conta">Voltar para a conta</NuxtLink>
    </EmptyState>
    <EmptyState
      v-else-if="unavailable"
      title="Bambu Cloud indisponível"
      description="Conta Bambu Cloud indisponível nesta instalação."
    >
      <NuxtLink to="/conta">Voltar para a conta</NuxtLink>
    </EmptyState>
    <template v-else>
      <section
        v-if="farms.length > 1"
        class="panel"
        aria-labelledby="bambu-farm-heading"
      >
        <h2 id="bambu-farm-heading">Escolha a farm</h2>
        <div class="field">
          <label for="bambu-farm">Farm</label>
          <select
            id="bambu-farm"
            v-model="farmId"
            :disabled="pending"
            @change="loadStatus"
          >
            <option
              v-for="farm in farms"
              :key="farm.farmId"
              :value="farm.farmId"
            >
              {{ farm.farmId }}
            </option>
          </select>
        </div>
      </section>
      <section
        v-if="account?.connected"
        class="panel"
        aria-labelledby="bambu-account-heading"
      >
        <header class="panel-head">
          <h2 id="bambu-account-heading">Conta conectada</h2>
          <StatusBadge
            :tone="account.expired ? 'paused' : 'idle'"
            :label="account.expired ? 'Token expirado' : 'Conectada'"
          />
        </header>
        <dl class="facts">
          <div>
            <dt>Conta</dt>
            <dd class="wrap">{{ account.account }}</dd>
          </div>
          <div>
            <dt>Região</dt>
            <dd>{{ account.region === 'china' ? 'China' : 'Global' }}</dd>
          </div>
          <div>
            <dt>
              {{ account.expired ? 'Token expirou em' : 'Token válido até' }}
            </dt>
            <dd>{{ expiryLabel || 'Indisponível' }}</dd>
          </div>
        </dl>
        <div class="actions">
          <Button
            class="danger"
            :disabled="pending"
            :aria-busy="pending"
            @click="disconnect"
          >
            {{ pending ? 'Desconectando…' : 'Desconectar' }}
          </Button>
        </div>
      </section>
      <section class="panel" aria-labelledby="bambu-connect-heading">
        <h2 id="bambu-connect-heading">
          {{ account?.connected ? 'Trocar de conta' : 'Conectar conta' }}
        </h2>
        <form class="form" method="post" @submit.prevent="connect">
          <div class="field">
            <label for="bambu-region">Região</label>
            <select
              id="bambu-region"
              v-model="region"
              :disabled="pending || mode === 'tfa'"
            >
              <option value="global">Global</option>
              <option value="china">China</option>
            </select>
          </div>
          <div class="field">
            <label for="bambu-email">E-mail da conta Bambu</label>
            <input
              id="bambu-email"
              v-model="email"
              type="email"
              autocomplete="username"
              required
              maxlength="320"
              :disabled="pending || mode === 'tfa'"
            />
          </div>
          <fieldset v-if="mode !== 'tfa'">
            <legend>Modo de conexão</legend>
            <label class="check">
              <input
                v-model="mode"
                type="radio"
                name="bambu-mode"
                value="email-code"
                :disabled="pending"
              />
              <span>Código por e-mail</span>
            </label>
            <label class="check">
              <input
                v-model="mode"
                type="radio"
                name="bambu-mode"
                value="password"
                :disabled="pending"
              />
              <span>Senha e verificação</span>
            </label>
            <label class="check">
              <input
                v-model="mode"
                type="radio"
                name="bambu-mode"
                value="token"
                :disabled="pending"
              />
              <span>Token colado</span>
            </label>
          </fieldset>
          <template v-if="mode === 'email-code'">
            <div class="field">
              <label for="bambu-code">Código recebido por e-mail</label>
              <input
                id="bambu-code"
                v-model="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                required
                minlength="4"
                maxlength="8"
                pattern="[0-9]{4,8}"
                :disabled="pending"
              />
            </div>
          </template>
          <template v-else-if="mode === 'password'">
            <div class="field">
              <label for="bambu-password">Senha</label>
              <input
                id="bambu-password"
                v-model="password"
                type="password"
                autocomplete="current-password"
                required
                maxlength="200"
                :disabled="pending"
              />
            </div>
          </template>
          <template v-else-if="mode === 'token'">
            <div class="field">
              <label for="bambu-token">Token de acesso</label>
              <input
                id="bambu-token"
                v-model="accessToken"
                type="password"
                autocomplete="off"
                required
                minlength="16"
                maxlength="4096"
                :disabled="pending"
              />
            </div>
            <div class="field">
              <label for="bambu-refresh">Token de atualização (opcional)</label>
              <input
                id="bambu-refresh"
                v-model="refreshToken"
                type="password"
                autocomplete="off"
                minlength="16"
                maxlength="4096"
                :disabled="pending"
              />
            </div>
            <div class="field">
              <label for="bambu-expires">Validade do token</label>
              <input
                id="bambu-expires"
                v-model="expiresAt"
                type="datetime-local"
                required
                :disabled="pending"
              />
            </div>
          </template>
          <template v-else>
            <div class="field">
              <label for="bambu-tfa">Código de verificação</label>
              <input
                id="bambu-tfa"
                v-model="tfaCode"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                required
                minlength="4"
                maxlength="8"
                pattern="[0-9]{4,8}"
                :disabled="pending"
              />
            </div>
          </template>
          <div class="actions">
            <Button type="submit" :disabled="pending" :aria-busy="pending">
              {{
                pending
                  ? 'Conectando…'
                  : mode === 'tfa'
                    ? 'Confirmar código'
                    : 'Conectar'
              }}
            </Button>
            <Button
              v-if="mode === 'tfa'"
              :disabled="pending"
              @click="cancelTfa"
            >
              Cancelar verificação
            </Button>
          </div>
        </form>
      </section>
    </template>
    <p class="back"><NuxtLink to="/conta">Voltar para a conta</NuxtLink></p>
  </main>
</template>

<style scoped>
.bambu-page {
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
  max-width: 40rem;
  color: var(--color-text-muted);
}
.alert:focus-visible {
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
.loading {
  display: grid;
  gap: var(--space-3);
}
.loading p {
  margin: 0;
}
h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--space-3) var(--space-4);
  margin: 0;
}
.facts dt {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.facts dd {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
.form {
  display: grid;
  gap: var(--space-3);
  max-width: 28rem;
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
  margin-bottom: var(--space-1);
}
fieldset {
  display: grid;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
  font-size: var(--font-size-base);
  font-weight: 400;
}
.check input {
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
  accent-color: var(--color-accent);
}
select,
input:not([type='radio']) {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
select:focus-visible,
input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
select:disabled,
input:disabled {
  opacity: 0.6;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  align-items: center;
  margin-top: var(--space-3);
}
.wrap {
  overflow-wrap: anywhere;
}
.bambu-page :deep(.danger) {
  border-color: var(--printer-error);
  color: var(--printer-error);
}
.bambu-page :deep(.ui-card) {
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
}
</style>
