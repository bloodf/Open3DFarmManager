<script setup lang="ts">
const currentPassword = ref('')
const newPassword = ref('')
const pending = ref(false)
const message = ref('')
const error = ref(false)
const summary = ref<HTMLElement | null>(null)
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
const googleSummary = ref<HTMLElement | null>(null)

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
  } catch {
    googleAvailable.value = false
    googleLinked.value = false
    googleCanUnlink.value = false
  }
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
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Conta</h1>
    <section aria-labelledby="google-heading">
      <h2 id="google-heading">Conta Google</h2>
      <p v-if="!googleAvailable && !googleLinked" class="help">
        O vínculo com o Google fica indisponível enquanto o provedor não estiver
        ativo nesta instalação.
      </p>
      <p v-else-if="googleLinked" class="help">
        Uma conta Google está vinculada.
      </p>
      <p v-else class="help">Nenhuma conta Google vinculada.</p>
      <p
        ref="googleSummary"
        :role="googleError ? 'alert' : 'status'"
        tabindex="-1"
      >
        {{ googleMessage }}
      </p>
      <button
        v-if="googleAvailable && !googleLinked"
        type="button"
        class="google-button"
        :disabled="googleBusy"
        :aria-busy="googleBusy"
        @click="startGoogleLink"
      >
        {{ googleBusy ? 'Abrindo o Google…' : 'Vincular conta Google' }}
      </button>
      <button
        v-if="googleLinked && googleCanUnlink"
        type="button"
        :disabled="googleBusy"
        :aria-busy="googleBusy"
        @click="unlinkGoogle"
      >
        {{ googleBusy ? 'Desvinculando…' : 'Desvincular Google' }}
      </button>
      <p v-if="googleLinked && !googleCanUnlink" class="help">
        Defina uma senha ou vincule outro provedor antes de remover o Google.
      </p>
    </section>
    <h2>Alterar senha</h2>
    <form
      method="post"
      action="/api/auth/password"
      :aria-busy="pending"
      @submit.prevent="changePassword"
    >
      <label for="current-password">Senha atual</label>
      <input
        id="current-password"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        required
        :disabled="pending"
      />
      <label for="new-password">Nova senha</label>
      <input
        id="new-password"
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        aria-describedby="new-password-help"
        :disabled="pending"
      />
      <p id="new-password-help" class="help">Use 12 caracteres ou mais.</p>
      <p ref="summary" :role="error ? 'alert' : 'status'" tabindex="-1">
        {{ message }}
      </p>
      <button type="submit" :disabled="pending">
        {{ pending ? 'Alterando…' : 'Alterar senha' }}
      </button>
    </form>
    <section
      v-if="bambuCloudEnabled"
      id="bambu-cloud-account"
      aria-labelledby="bambu-cloud-heading"
    >
      <h2 id="bambu-cloud-heading">Conta Bambu Cloud</h2>
    </section>
    <p><NuxtLink to="/sair">Sair</NuxtLink></p>
  </main>
</template>

<style scoped>
label {
  display: block;
  margin-top: 1rem;
  font-weight: 600;
}
input {
  display: block;
  width: 100%;
  max-width: 26rem;
  margin-top: 0.5rem;
  padding: 0.75rem;
  font: inherit;
}
button {
  min-height: 2.75rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:focus-visible,
input:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
.help {
  max-width: 36rem;
}
.google-button {
  margin-top: 0.75rem;
}
</style>
