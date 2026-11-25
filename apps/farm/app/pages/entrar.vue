<script setup lang="ts">
import AuthAlert from '../components/auth/AuthAlert.vue'
import AuthField from '../components/auth/AuthField.vue'
import AuthHeader from '../components/auth/AuthHeader.vue'
import AuthPanel from '../components/auth/AuthPanel.vue'
import AuthStatus from '../components/auth/AuthStatus.vue'
import AuthSubmit from '../components/auth/AuthSubmit.vue'
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
const errorSummary = ref<{ focus: () => void } | null>(null)
const formStatus = computed(() =>
  !hydrated.value
    ? 'Preparando o formulário'
    : pending.value
      ? 'Verificando seus dados.'
      : '',
)
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
  <main id="conteudo" class="auth-page">
    <AuthHeader eyebrow="Open3DFarmManager" title="Entrar">
      Use sua conta do Open3DFarmManager.
    </AuthHeader>
    <AuthPanel
      tag="form"
      method="post"
      action="/api/auth/login"
      :aria-busy="pending"
      @submit.prevent="login"
    >
      <AuthField
        id="username"
        v-model="username"
        label="Usuário"
        hint="Use letras minúsculas, números, hífen ou sublinhado."
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="3"
        maxlength="64"
        pattern="[a-z0-9_\-]{3,64}"
        :disabled="pending"
      />
      <AuthField
        id="password"
        v-model="password"
        label="Senha"
        type="password"
        autocomplete="current-password"
        required
        :disabled="pending"
      />
      <AuthAlert ref="errorSummary" :message="errorMessage" />
      <AuthSubmit :disabled="pending || !hydrated">
        {{ pending ? 'Entrando…' : 'Entrar' }}
      </AuthSubmit>
      <AuthStatus :message="formStatus" />
    </AuthPanel>
    <section
      v-if="googleEnabled || googleUnavailableReason"
      class="provider"
      aria-labelledby="google-titulo"
    >
      <AuthPanel>
        <h2 id="google-titulo">Google</h2>
        <p v-if="googleUnavailableReason" role="status">
          {{ googleUnavailableReason }}
        </p>
        <a
          v-else
          class="provider-link google-signin"
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
      </AuthPanel>
    </section>
    <section v-if="oidcEnabled" class="provider" aria-labelledby="oidc-titulo">
      <AuthPanel>
        <h2 id="oidc-titulo">Provedor OpenID Connect</h2>
        <p>
          O servidor aceita um provedor configurado. O e-mail do provedor não
          localiza nem cria conta.
        </p>
        <a class="provider-link" href="/api/auth/oidc/start"
          >Entrar com OpenID Connect</a
        >
      </AuthPanel>
      <AuthPanel
        tag="form"
        method="post"
        action="/api/auth/oidc/start"
        :aria-busy="linking"
        @submit.prevent="linkOidc"
      >
        <h3>Vincular com um convite</h3>
        <p id="oidc-invite-help" class="help">
          Um convite válido cria a conta e guarda só o identificador do
          provedor. O papel vem do convite.
        </p>
        <AuthField
          id="oidc-username"
          v-model="oidcUsername"
          label="Usuário da nova conta"
          describedby="oidc-invite-help"
          autocomplete="username"
          autocapitalize="none"
          :spellcheck="false"
          required
          minlength="3"
          maxlength="64"
          pattern="[a-z0-9_\-]{3,64}"
          :disabled="linking"
        />
        <AuthField
          id="oidc-invite"
          v-model="invite"
          label="Código do convite"
          describedby="oidc-invite-help"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          required
          minlength="43"
          maxlength="43"
          pattern="[A-Za-z0-9_\-]{43}"
          :disabled="linking"
        />
        <AuthSubmit variant="secondary" :disabled="linking || !hydrated">
          {{ linking ? 'Abrindo o provedor…' : 'Vincular convite e entrar' }}
        </AuthSubmit>
      </AuthPanel>
    </section>
    <p class="links">
      <NuxtLink to="/redefinir-senha">Esqueci a senha</NuxtLink>
      <NuxtLink to="/">Voltar ao início</NuxtLink>
    </p>
  </main>
</template>

<style scoped>
.auth-page {
  display: grid;
  gap: var(--ops-space-4);
  align-content: start;
  max-width: 26rem;
  padding: var(--ops-space-5) var(--ops-space-4);
  font-size: var(--ops-text-body);
  line-height: 20px;
}

.provider {
  display: grid;
  gap: var(--ops-space-4);
}
.provider p {
  line-height: 20px;
}
.provider .help {
  font-size: var(--ops-text-small);
  color: var(--ops-muted);
}
.provider-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ops-space-3);
  min-height: 2.75rem;
  padding: var(--ops-space-2) var(--ops-space-3);
  border: 1px solid color-mix(in srgb, var(--ops-muted) 70%, var(--ops-panel));
  border-radius: var(--ops-radius-sm);
  background: var(--ops-raised);
  color: var(--ops-text);
  font-weight: var(--font-weight-semibold);
  text-align: center;
  text-decoration: none;
}
.provider-link:hover {
  border-color: var(--ops-action);
}
.provider-link:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.google-mark {
  flex: none;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2) var(--ops-space-5);
  margin: 0;
  padding-block-start: var(--ops-space-2);
  border-block-start: 1px solid var(--ops-border);
}
.links a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  color: var(--ops-action);
}
.links a:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
</style>
