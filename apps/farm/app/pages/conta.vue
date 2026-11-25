<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import SettingsMessage from '../components/settings/SettingsMessage.vue'
import SettingsPage from '../components/settings/SettingsPage.vue'
import SettingsPanel from '../components/settings/SettingsPanel.vue'
import SettingsTextField from '../components/settings/SettingsTextField.vue'
import Button from '../components/ui/Button.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'

const currentPassword = ref('')
const newPassword = ref('')
const pending = ref(false)
const message = ref('')
const error = ref(false)
const summary = ref<InstanceType<typeof SettingsMessage> | null>(null)
const bambuCloudEnabled = ref(false)

type IdentitiesResponse = {
  google?: {
    available?: boolean
    linked?: boolean
    canUnlink?: boolean
  }
}

const googleAvailable = ref(false)
const googleLinked = ref(false)
const googleCanUnlink = ref(false)
const googleBusy = ref(false)
const googleMessage = ref('')
const googleError = ref(false)
const googleSummary = ref<InstanceType<typeof SettingsMessage> | null>(null)
// 'loading' until the first answer; 'session' (401) and 'failed' keep the
// Google actions hidden, because their state is unknown.
const identitiesState = ref<'loading' | 'ready' | 'session' | 'failed'>(
  'loading',
)

async function loadIdentities() {
  try {
    const response = await $fetch<IdentitiesResponse>('/api/auth/identities', {
      retry: 0,
      timeout: 10_000,
    })
    const google = response.google ?? {}
    googleAvailable.value = google.available === true
    googleLinked.value = google.linked === true
    googleCanUnlink.value = google.canUnlink === true
    identitiesState.value = 'ready'
  } catch (cause: unknown) {
    googleAvailable.value = false
    googleLinked.value = false
    googleCanUnlink.value = false
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    // 404: this installation exposes no identity providers, so there is
    // nothing to link and nothing failed.
    identitiesState.value =
      status === 404 ? 'ready' : status === 401 ? 'session' : 'failed'
  }
}

async function retryIdentities() {
  identitiesState.value = 'loading'
  await loadIdentities()
}

onMounted(async () => {
  await loadIdentities()
  if (window.location.hash === '#google=vinculado') {
    googleMessage.value = 'Conta Google vinculada.'
    history.replaceState(null, '', window.location.pathname)
    await nextTick()
    googleSummary.value?.focus()
  } else if (window.location.hash === '#erro=google-vinculo') {
    googleMessage.value = 'Não foi possível vincular o Google. Tente novamente.'
    googleError.value = true
    history.replaceState(null, '', window.location.pathname)
    await nextTick()
    googleSummary.value?.focus()
  }
})

function startGoogleLink() {
  if (googleBusy.value || !googleAvailable.value || googleLinked.value) return
  googleBusy.value = true
  window.location.assign('/api/auth/google/link/start')
}

async function unlinkGoogle() {
  if (googleBusy.value || !googleLinked.value || !googleCanUnlink.value) return
  googleBusy.value = true
  googleMessage.value = ''
  googleError.value = false
  try {
    await $fetch('/api/auth/identities/google', {
      method: 'DELETE',
      retry: 0,
      timeout: 15_000,
    })
    googleLinked.value = false
    googleCanUnlink.value = false
    googleMessage.value = 'Conta Google desvinculada.'
    await loadIdentities()
  } catch (cause: unknown) {
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    googleMessage.value =
      status === 409
        ? 'Mantenha outra forma de entrada antes de desvincular o Google.'
        : status === 404
          ? 'Nenhuma conta Google vinculada.'
          : 'Não foi possível desvincular o Google agora.'
    googleError.value = true
  } finally {
    googleBusy.value = false
    await nextTick()
    googleSummary.value?.focus()
  }
}

async function changePassword() {
  if (pending.value) return
  pending.value = true
  message.value = ''
  error.value = false
  try {
    await $fetch('/api/auth/password', {
      method: 'POST',
      body: {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      },
      retry: 0,
      timeout: 15_000,
    })
    message.value = 'Senha alterada. As outras sessões foram encerradas.'
    await loadIdentities()
  } catch (cause: unknown) {
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    message.value =
      status === 401
        ? 'Não foi possível alterar a senha. Confira a senha atual e tente novamente.'
        : status === 400
          ? 'Use uma nova senha com 12 caracteres ou mais.'
          : status === 429
            ? 'Muitas tentativas. Aguarde um pouco e tente novamente.'
            : 'Não foi possível alterar a senha agora.'
    error.value = true
  } finally {
    currentPassword.value = ''
    newPassword.value = ''
    pending.value = false
    await nextTick()
    summary.value?.focus()
  }
}
</script>

<template>
  <SettingsPage class="ops-screen ops-screen--columns" title="Conta">
    <template #intro>
      Gerencie como você entra: o vínculo com o Google e a senha desta conta.
    </template>
    <SettingsPanel
      heading-id="google-heading"
      title="Conta Google"
      :busy="identitiesState === 'loading' || googleBusy"
    >
      <div v-if="identitiesState === 'loading'" class="loading">
        <p role="status">Consultando o vínculo com o Google…</p>
        <Skeleton /><Skeleton />
      </div>
      <StaleNotice
        v-else-if="identitiesState !== 'ready'"
        role="alert"
        title="Vínculo indisponível"
        :description="
          identitiesState === 'session'
            ? 'Sua sessão não está disponível. Entre novamente para ver o vínculo com o Google.'
            : 'Não foi possível consultar o vínculo com o Google. Tente novamente.'
        "
      >
        <div class="actions">
          <Button @click="retryIdentities">Tentar novamente</Button>
          <NuxtLink v-if="identitiesState === 'session'" to="/entrar"
            >Entrar na conta</NuxtLink
          >
        </div>
      </StaleNotice>
      <template v-else>
        <p v-if="!googleAvailable && !googleLinked" class="help">
          O vínculo com o Google fica indisponível enquanto o provedor não
          estiver ativo nesta instalação.
        </p>
        <p v-else-if="googleLinked" class="help">
          Uma conta Google está vinculada.
        </p>
        <p v-else class="help">Nenhuma conta Google vinculada.</p>
        <div
          v-if="
            (googleAvailable && !googleLinked) ||
            (googleLinked && googleCanUnlink)
          "
          class="actions"
        >
          <Button
            v-if="googleAvailable && !googleLinked"
            :disabled="googleBusy"
            :aria-busy="googleBusy"
            @click="startGoogleLink"
          >
            {{ googleBusy ? 'Abrindo o Google…' : 'Vincular conta Google' }}
          </Button>
          <Button
            v-if="googleLinked && googleCanUnlink"
            :disabled="googleBusy"
            :aria-busy="googleBusy"
            @click="unlinkGoogle"
          >
            {{ googleBusy ? 'Desvinculando…' : 'Desvincular Google' }}
          </Button>
        </div>
        <p v-if="googleLinked && !googleCanUnlink" class="help">
          Defina uma senha ou vincule outro provedor antes de remover o Google.
        </p>
      </template>
      <SettingsMessage
        ref="googleSummary"
        :message="googleMessage"
        :error="googleError"
      />
    </SettingsPanel>
    <SettingsPanel heading-id="senha-heading" title="Alterar senha">
      <form
        class="form"
        method="post"
        action="/api/auth/password"
        :aria-busy="pending"
        @submit.prevent="changePassword"
      >
        <SettingsTextField
          id="current-password"
          v-model="currentPassword"
          label="Senha atual"
          type="password"
          autocomplete="current-password"
          required
          :disabled="pending"
        />
        <SettingsTextField
          id="new-password"
          v-model="newPassword"
          label="Nova senha"
          type="password"
          autocomplete="new-password"
          hint="Use 12 caracteres ou mais."
          required
          minlength="12"
          :disabled="pending"
        />
        <SettingsMessage ref="summary" :message="message" :error="error" />
        <div class="actions">
          <Button type="submit" :disabled="pending">
            {{ pending ? 'Alterando…' : 'Alterar senha' }}
          </Button>
        </div>
      </form>
    </SettingsPanel>
    <SettingsPanel
      v-if="bambuCloudEnabled"
      id="bambu-cloud-account"
      heading-id="bambu-cloud-heading"
      title="Conta Bambu Cloud"
    />
    <SettingsPanel heading-id="sessao-heading" title="Sessão">
      <template #description>
        Encerre a sessão neste navegador ou em todos os seus dispositivos.
      </template>
      <p><NuxtLink to="/sair">Sair</NuxtLink></p>
    </SettingsPanel>
  </SettingsPage>
</template>

<style scoped>
.loading,
.form {
  display: grid;
  gap: var(--space-3);
}
.help {
  max-width: 36rem;
  margin: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
</style>
