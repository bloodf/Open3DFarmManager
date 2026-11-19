<script setup lang="ts">
import { completeAuth } from '../utils/auth-invalidation.ts'

const hydrated = ref(false)
const oidcEnabled = ref(false)
const googleEnabled = ref(false)
const googleUnavailableReason = ref('')
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
  } else if (window.location.hash === '#erro=google') {
    errorMessage.value =
      'Não foi possível entrar com o Google. Tente novamente.'
    history.replaceState(null, '', window.location.pathname)
    await nextTick()
    errorSummary.value?.focus()
  }
  const offline = navigator.onLine === false
  try {
    const status = await $fetch<{ enabled?: boolean }>('/api/auth/oidc', {
      retry: 0,
      timeout: 5_000,
    })
    oidcEnabled.value = status.enabled === true
  } catch {
    oidcEnabled.value = false
  }
  try {
    const status = await $fetch<{
      enabled?: boolean
      reason?: string
    }>('/api/auth/google', { retry: 0, timeout: 5_000 })
    if (offline) {
      googleEnabled.value = false
      googleUnavailableReason.value =
        'Sem conexão com a internet. O Entrar com Google precisa de rede; o login por senha continua disponível.'
    } else if (status.enabled === true) {
      googleEnabled.value = true
      googleUnavailableReason.value = ''
    } else {
      googleEnabled.value = false
      googleUnavailableReason.value =
        status.reason === 'offline'
          ? 'Sem conexão com a internet. O Entrar com Google precisa de rede; o login por senha continua disponível.'
          : ''
    }
  } catch {
    googleEnabled.value = false
    if (offline) {
      googleUnavailableReason.value =
        'Sem conexão com a internet. O Entrar com Google precisa de rede; o login por senha continua disponível.'
    }
  }
})

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
    <section
      v-if="googleEnabled || googleUnavailableReason"
      aria-labelledby="google-titulo"
    >
      <h2 id="google-titulo">Google</h2>
      <p v-if="googleUnavailableReason" role="status">
        {{ googleUnavailableReason }}
      </p>
      <p v-else>
        <a
          class="google-signin"
          href="/api/auth/google/start"
          aria-label="Entrar com Google"
        >
          <svg
            class="google-mark"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            width="18"
            height="18"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
          </svg>
          <span>Entrar com Google</span>
        </a>
      </p>
    </section>
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
.google-signin {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2.75rem;
  padding: 0.5rem 1rem;
  border: 1px solid #747775;
  border-radius: 0.25rem;
  background: #fff;
  color: #1f1f1f;
  text-decoration: none;
  font: inherit;
  font-weight: 500;
}
.google-signin:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
.google-mark {
  flex: none;
}
#username-help {
  font-size: 0.875rem;
}
</style>
