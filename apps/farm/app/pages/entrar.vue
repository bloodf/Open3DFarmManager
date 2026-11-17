<script setup lang="ts">
const hydrated = ref(false)
const oidcEnabled = ref(false)
const invite = ref('')
const oidcUsername = ref('')
const linking = ref(false)
const username = ref('')
const password = ref('')
const pending = ref(false)
const errorMessage = ref('')
const errorSummary = ref<HTMLElement | null>(null)
onMounted(async () => {
  hydrated.value = true
  if (window.location.hash === '#erro=oidc') {
    errorMessage.value =
      'Não foi possível entrar com o provedor OpenID Connect. Tente novamente.'
    history.replaceState(null, '', window.location.pathname)
    await nextTick()
    errorSummary.value?.focus()
  }
  try {
    const status = await $fetch<{ enabled?: boolean }>('/api/auth/oidc', {
      retry: 0,
      timeout: 5_000,
    })
    oidcEnabled.value = status.enabled === true
  } catch {
    oidcEnabled.value = false
  }
})
import { completeAuth } from '../utils/auth-invalidation.ts'

async function linkOidc() {
  if (linking.value) return
  linking.value = true
  errorMessage.value = ''
  try {
    const response = await $fetch<{ url: string }>('/api/auth/oidc/start', {
      method: 'POST',
      headers: { 'x-invite-token': invite.value },
      body: { username: oidcUsername.value },
      retry: 0,
      timeout: 15_000,
    })
    const target = new URL(response.url)
    if (target.protocol !== 'https:' && target.protocol !== 'http:')
      throw new Error('bad url')
    window.location.assign(target.href)
  } catch (error: unknown) {
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value =
      status === 400
        ? 'Não foi possível vincular o convite. Confira o código e o usuário.'
        : status === 429
          ? 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
          : 'Não foi possível entrar com o provedor agora. Tente novamente mais tarde.'
    linking.value = false
    await nextTick()
    errorSummary.value?.focus()
  }
}

async function login() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    await completeAuth(() =>
      $fetch('/api/auth/login', {
        method: 'POST',
        body: { username: username.value, password: password.value },
        retry: 0,
        timeout: 15_000,
      }),
    )
    password.value = ''
    await navigateTo('/')
  } catch (error: unknown) {
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value =
      status === 401
        ? 'Usuário ou senha inválidos. Confira os dados e tente novamente.'
        : status === 429
          ? 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
          : 'Não foi possível entrar agora. Tente novamente mais tarde.'
  } finally {
    password.value = ''
    pending.value = false
    if (errorMessage.value) {
      await nextTick()
      errorSummary.value?.focus()
    }
  }
}
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Entrar</h1>
    <p>Use sua conta do Open3DFarmManager.</p>
    <form
      method="post"
      action="/api/auth/login"
      :aria-busy="pending"
      @submit.prevent="login"
    >
      <label for="username">Usuário</label>
      <input
        id="username"
        v-model="username"
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="3"
        maxlength="64"
        pattern="[a-z0-9_\-]{3,64}"
        aria-describedby="username-help"
        :disabled="pending"
      />
      <p id="username-help">
        Use letras minúsculas, números, hífen ou sublinhado.
      </p>
      <label for="password">Senha</label>
      <input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        :disabled="pending"
      />
      <p ref="errorSummary" role="alert" tabindex="-1">{{ errorMessage }}</p>
      <button type="submit" :disabled="pending || !hydrated">
        {{ pending ? 'Entrando…' : 'Entrar' }}
      </button>
      <p role="status" v-if="!hydrated">Preparando o formulário</p>
      <p role="status">{{ pending ? 'Verificando seus dados.' : '' }}</p>
    </form>
    <p><NuxtLink to="/">Voltar ao início</NuxtLink></p>
    <section v-if="oidcEnabled" aria-labelledby="oidc-titulo">
      <h2 id="oidc-titulo">Provedor OpenID Connect</h2>
      <p>
        O servidor aceita um provedor configurado. O e-mail do provedor não
        localiza nem cria conta.
      </p>
      <p>
        <a href="/api/auth/oidc/start">Entrar com OpenID Connect</a>
      </p>
      <form
        method="post"
        action="/api/auth/oidc/start"
        :aria-busy="linking"
        @submit.prevent="linkOidc"
      >
        <h3>Vincular com um convite</h3>
        <p id="oidc-invite-help">
          Um convite válido cria a conta e guarda só o identificador do
          provedor. O papel vem do convite.
        </p>
        <label for="oidc-username">Usuário da nova conta</label>
        <input
          id="oidc-username"
          v-model="oidcUsername"
          autocomplete="username"
          autocapitalize="none"
          :spellcheck="false"
          required
          minlength="3"
          maxlength="64"
          pattern="[a-z0-9_\-]{3,64}"
          :disabled="linking"
          aria-describedby="oidc-invite-help"
        />
        <label for="oidc-invite">Código do convite</label>
        <input
          id="oidc-invite"
          v-model="invite"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          required
          minlength="43"
          maxlength="43"
          pattern="[A-Za-z0-9_\-]{43}"
          :disabled="linking"
        />
        <button type="submit" :disabled="linking || !hydrated">
          {{ linking ? 'Abrindo o provedor…' : 'Vincular convite e entrar' }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
form {
  max-width: 26rem;
}
label {
  display: block;
  font-weight: 600;
  margin-top: 1rem;
}
input {
  display: block;
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid currentColor;
  border-radius: 0.25rem;
  font: inherit;
}
button {
  min-height: 2.75rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: wait;
}
input:focus-visible,
button:focus-visible,
a:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
a[href='/api/auth/oidc/start'] {
  display: inline-block;
  min-height: 2.75rem;
  padding: 0.65rem 0;
}
#username-help {
  font-size: 0.875rem;
}
</style>
