<script setup lang="ts">
type ProviderView = {
  id: string
  enabled: boolean
  clientId: string
  hasClientSecret: boolean
  redirectUri: string
  issuer: string
  scopes: string[]
  pkce: boolean
  emailVerifiedRequired: boolean
}

const hydrated = ref(false)
const pending = ref(false)
const forbidden = ref(false)
const offline = ref(false)
const message = ref('')
const error = ref(false)
const summary = ref<HTMLElement | null>(null)
const provider = ref<ProviderView | null>(null)
const enabled = ref(false)
const clientId = ref('')
const clientSecret = ref('')

async function load() {
  offline.value = typeof navigator !== 'undefined' && navigator.onLine === false
  try {
    const data = await $fetch<{ providers: ProviderView[] }>(
      '/api/admin/sign-in-providers',
      { retry: 0, timeout: 10_000 },
    )
    const google = data.providers.find((item) => item.id === 'google')
    if (!google) throw new Error('missing')
    provider.value = google
    enabled.value = google.enabled
    clientId.value = google.clientId
    clientSecret.value = ''
    forbidden.value = false
  } catch (cause: unknown) {
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    forbidden.value = status === 404 || status === 403
    if (!forbidden.value) {
      message.value =
        'Não foi possível carregar os provedores de entrada. Tente novamente.'
      error.value = true
    }
  } finally {
    hydrated.value = true
  }
}

async function save() {
  if (pending.value || !provider.value) return
  pending.value = true
  message.value = ''
  error.value = false
  try {
    const body: {
      enabled: boolean
      clientId: string
      clientSecret?: string
    } = {
      enabled: enabled.value,
      clientId: clientId.value.trim(),
    }
    if (clientSecret.value !== '') body.clientSecret = clientSecret.value
    const data = await $fetch<{ provider: ProviderView }>(
      '/api/admin/sign-in-providers/google',
      {
        method: 'PUT',
        body,
        retry: 0,
        timeout: 15_000,
      },
    )
    provider.value = data.provider
    enabled.value = data.provider.enabled
    clientId.value = data.provider.clientId
    clientSecret.value = ''
    message.value = 'Configuração do Google salva.'
  } catch (cause: unknown) {
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    message.value =
      status === 404 || status === 403
        ? 'Você não tem permissão para alterar os provedores de entrada.'
        : status === 400
          ? 'Confira o client ID, o segredo e se o Google está completo antes de ativar.'
          : 'Não foi possível salvar agora. Tente novamente.'
    error.value = true
  } finally {
    pending.value = false
    await nextTick()
    summary.value?.focus()
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Provedores de entrada</h1>
    <p>
      Contas → Provedores de entrada. Só administradores da instalação podem
      alterar estas opções.
    </p>
    <p v-if="forbidden" role="alert">
      Você não tem permissão para abrir as configurações de provedores de
      entrada.
    </p>
    <p v-else-if="offline" role="status">
      Sem conexão com a internet. A configuração do Google fica indisponível
      offline; o login por senha continua funcionando.
    </p>
    <section
      v-else-if="provider"
      aria-labelledby="google-titulo"
      :aria-busy="pending || !hydrated"
    >
      <h2 id="google-titulo">Google</h2>
      <p>
        Preset embutido: emissor
        <code>{{ provider.issuer }}</code>, escopos
        <code>{{ provider.scopes.join(' ') }}</code>, PKCE e e-mail verificado
        obrigatório. Nenhum client ID ou segredo é enviado com o produto.
      </p>
      <p>
        URI de redirecionamento para registrar no Google Cloud:
        <code>{{ provider.redirectUri }}</code>
      </p>
      <form method="post" @submit.prevent="save">
        <label>
          <input
            v-model="enabled"
            type="checkbox"
            :disabled="pending || offline"
          />
          Ativar Entrar com Google
        </label>
        <label for="google-client-id">Client ID</label>
        <input
          id="google-client-id"
          v-model="clientId"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          maxlength="200"
          :disabled="pending || offline"
        />
        <label for="google-client-secret">Client secret</label>
        <input
          id="google-client-secret"
          v-model="clientSecret"
          type="password"
          autocomplete="new-password"
          maxlength="512"
          :disabled="pending || offline"
          :placeholder="
            provider.hasClientSecret
              ? 'Segredo já salvo (deixe em branco para manter)'
              : 'Cole o segredo do projeto Google Cloud'
          "
          aria-describedby="google-secret-help"
        />
        <p id="google-secret-help">
          O segredo é guardado criptografado e nunca é devolvido ao navegador
          nem escrito em logs.
        </p>
        <p ref="summary" :role="error ? 'alert' : 'status'" tabindex="-1">
          {{ message }}
        </p>
        <button type="submit" :disabled="pending || !hydrated || offline">
          {{ pending ? 'Salvando…' : 'Salvar Google' }}
        </button>
      </form>
    </section>
    <p><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>

<style scoped>
form {
  max-width: 32rem;
}
label {
  display: block;
  font-weight: 600;
  margin-top: 1rem;
}
input[type='text'],
input[type='password'],
input:not([type]) {
  display: block;
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid currentColor;
  border-radius: 0.25rem;
  font: inherit;
}
input[type='checkbox'] {
  margin-right: 0.5rem;
}
button {
  min-height: 2.75rem;
  margin-top: 1.25rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: wait;
}
code {
  word-break: break-all;
}
input:focus-visible,
button:focus-visible,
a:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
#google-secret-help {
  font-size: 0.875rem;
}
</style>
