<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'

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
  <main id="conteudo" :aria-busy="loading || pending">
    <small>Open3DFarmManager</small>
    <h1>Conta Bambu Cloud</h1>
    <p class="help">
      Uma conta por farm. O token fica criptografado no servidor e não volta
      para esta tela.
    </p>
    <p v-if="loading">Carregando a conta Bambu Cloud.</p>
    <p v-else-if="!farmId">Nenhuma farm disponível para esta conta.</p>
    <p v-else-if="unavailable">
      Conta Bambu Cloud indisponível nesta instalação.
    </p>
    <form v-else method="post" @submit.prevent="connect">
      <label v-if="farms.length > 1" for="bambu-farm">Farm</label>
      <select
        v-if="farms.length > 1"
        id="bambu-farm"
        v-model="farmId"
        :disabled="pending"
        @change="loadStatus"
      >
        <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
          {{ farm.farmId }}
        </option>
      </select>
      <p v-if="account?.connected" class="help" role="status">
        Conta conectada: {{ account.account }}. Região
        {{ account.region === 'china' ? 'China' : 'Global' }}.
        <template v-if="account.expired">
          O token expirou em {{ expiryLabel }}.
        </template>
        <template v-else>O token vale até {{ expiryLabel }}.</template>
      </p>
      <button
        v-if="account?.connected"
        type="button"
        :disabled="pending"
        :aria-busy="pending"
        @click="disconnect"
      >
        {{ pending ? 'Desconectando…' : 'Desconectar' }}
      </button>
      <label for="bambu-region">Região</label>
      <select
        id="bambu-region"
        v-model="region"
        :disabled="pending || mode === 'tfa'"
      >
        <option value="global">Global</option>
        <option value="china">China</option>
      </select>
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
      <fieldset v-if="mode !== 'tfa'">
        <legend>Modo de conexão</legend>
        <label>
          <input
            v-model="mode"
            type="radio"
            name="bambu-mode"
            value="email-code"
            :disabled="pending"
          />
          Código por e-mail
        </label>
        <label>
          <input
            v-model="mode"
            type="radio"
            name="bambu-mode"
            value="password"
            :disabled="pending"
          />
          Senha e verificação
        </label>
        <label>
          <input
            v-model="mode"
            type="radio"
            name="bambu-mode"
            value="token"
            :disabled="pending"
          />
          Token colado
        </label>
      </fieldset>
      <template v-if="mode === 'email-code'">
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
      </template>
      <template v-else-if="mode === 'password'">
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
      </template>
      <template v-else-if="mode === 'token'">
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
        <label for="bambu-expires">Validade do token</label>
        <input
          id="bambu-expires"
          v-model="expiresAt"
          type="datetime-local"
          required
          :disabled="pending"
        />
      </template>
      <template v-else>
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
        <button type="button" :disabled="pending" @click="cancelTfa">
          Cancelar verificação
        </button>
      </template>
      <p ref="summary" :role="error ? 'alert' : 'status'" tabindex="-1">
        {{ message }}
      </p>
      <button type="submit" :disabled="pending" :aria-busy="pending">
        {{
          pending
            ? 'Conectando…'
            : mode === 'tfa'
              ? 'Confirmar código'
              : 'Conectar'
        }}
      </button>
    </form>
    <p><NuxtLink to="/conta">Voltar para a conta</NuxtLink></p>
  </main>
</template>

<style scoped>
label,
legend {
  display: block;
  margin-top: 1rem;
  font-weight: 600;
}
input,
select {
  display: block;
  width: 100%;
  max-width: 26rem;
  margin-top: 0.5rem;
  padding: 0.75rem;
  font: inherit;
}
fieldset label {
  font-weight: 400;
}
fieldset input {
  display: inline-block;
  width: auto;
  margin-right: 0.5rem;
}
button {
  min-height: 2.75rem;
  margin-top: 1rem;
  margin-right: 0.5rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
.help {
  max-width: 36rem;
}
</style>
