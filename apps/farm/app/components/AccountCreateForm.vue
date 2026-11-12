<script setup lang="ts">
import { completeAuth } from '../utils/auth-invalidation.ts'

const props = defineProps<{
  endpoint: string
  tokenHeader: string
  tokenLabel: string
  tokenHelp: string
  submitLabel: string
  /** Read the code from the URL fragment (never sent to servers or logs) and clear it. */
  tokenFromFragment?: boolean
}>()

const username = ref('')
const password = ref('')
const token = ref('')
const pending = ref(false)
const errorMessage = ref('')
const errorSummary = ref<HTMLElement | null>(null)

onMounted(() => {
  if (!props.tokenFromFragment) return
  const match = /^#codigo=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)
  if (match?.[1]) token.value = match[1]
  history.replaceState(null, '', window.location.pathname)
})

async function submit() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    await completeAuth(() =>
      $fetch(props.endpoint, {
        method: 'POST',
        headers: { [props.tokenHeader]: token.value },
        body: { username: username.value, password: password.value },
        retry: 0,
        timeout: 15_000,
      }),
    )
    await navigateTo('/')
  } catch (error: unknown) {
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value =
      status === 400
        ? 'Não foi possível criar a conta. Confira o código, escolha outro usuário e use uma senha com 12 caracteres ou mais.'
        : status === 429
          ? 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
          : 'Não foi possível criar a conta agora. Tente novamente mais tarde.'
  } finally {
    password.value = ''
    token.value = ''
    pending.value = false
    if (errorMessage.value) {
      await nextTick()
      errorSummary.value?.focus()
    }
  }
}
</script>

<template>
  <form class="account-form" :aria-busy="pending" @submit.prevent="submit">
    <label for="account-token">{{ tokenLabel }}</label>
    <input
      id="account-token"
      v-model="token"
      name="token"
      autocomplete="off"
      autocapitalize="none"
      :spellcheck="false"
      required
      aria-describedby="account-token-help"
      :disabled="pending"
    />
    <p id="account-token-help" class="help">{{ tokenHelp }}</p>
    <label for="account-username">Usuário</label>
    <input
      id="account-username"
      v-model="username"
      name="username"
      autocomplete="username"
      autocapitalize="none"
      :spellcheck="false"
      required
      minlength="3"
      maxlength="64"
      pattern="[a-z0-9_\-]{3,64}"
      aria-describedby="account-username-help"
      :disabled="pending"
    />
    <p id="account-username-help" class="help">
      Use letras minúsculas, números, hífen ou sublinhado.
    </p>
    <label for="account-password">Senha</label>
    <input
      id="account-password"
      v-model="password"
      name="password"
      type="password"
      autocomplete="new-password"
      required
      minlength="12"
      aria-describedby="account-password-help"
      :disabled="pending"
    />
    <p id="account-password-help" class="help">Use 12 caracteres ou mais.</p>
    <p ref="errorSummary" role="alert" tabindex="-1">{{ errorMessage }}</p>
    <button type="submit" :disabled="pending">
      {{ pending ? 'Criando conta…' : submitLabel }}
    </button>
    <p role="status">{{ pending ? 'Criando sua conta.' : '' }}</p>
  </form>
</template>
