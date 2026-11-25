<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import SettingsMessage from '../../components/settings/SettingsMessage.vue'
import SettingsPage from '../../components/settings/SettingsPage.vue'
import SettingsPanel from '../../components/settings/SettingsPanel.vue'
import SettingsTextField from '../../components/settings/SettingsTextField.vue'
import SettingsToggle from '../../components/settings/SettingsToggle.vue'
import Button from '../../components/ui/Button.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import StaleNotice from '../../components/ui/StaleNotice.vue'
import StatusBadge from '../../components/ui/StatusBadge.vue'

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
const summary = ref<InstanceType<typeof SettingsMessage> | null>(null)
const loadFailed = ref(false)
const provider = ref<ProviderView | null>(null)
const enabled = ref(false)
const clientId = ref('')
const clientSecret = ref('')

async function load() {
  loadFailed.value = false
  hydrated.value = false
  message.value = ''
  error.value = false
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
    if (!forbidden.value) loadFailed.value = true
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
  <SettingsPage class="ops-account" title="Provedores de entrada">
    <template #intro>
      Contas → Provedores de entrada. Só administradores da instalação podem
      alterar estas opções.
    </template>
    <ErrorState v-if="forbidden" title="Acesso restrito">
      <p role="alert">
        Você não tem permissão para abrir as configurações de provedores de
        entrada.
      </p>
    </ErrorState>
    <StaleNotice
      v-else-if="offline"
      title="Sem conexão"
      description="Sem conexão com a internet. A configuração do Google fica indisponível offline; o login por senha continua funcionando."
    />
    <SettingsPanel
      v-else-if="provider"
      heading-id="google-titulo"
      title="Google"
      :busy="pending || !hydrated"
    >
      <template #description>
        Preset embutido, sem client ID nem segredo enviados com o produto.
      </template>
      <dl class="facts">
        <div>
          <dt>Situação</dt>
          <dd>
            <StatusBadge
              :tone="provider.enabled ? 'idle' : 'offline'"
              :label="provider.enabled ? 'Ativo' : 'Desativado'"
            />
          </dd>
        </div>
        <div>
          <dt>Emissor</dt>
          <dd>
            <code>{{ provider.issuer }}</code>
          </dd>
        </div>
        <div>
          <dt>Escopos</dt>
          <dd>
            <code>{{ provider.scopes.join(' ') }}</code>
          </dd>
        </div>
        <div>
          <dt>Segurança</dt>
          <dd>PKCE e e-mail verificado obrigatório</dd>
        </div>
        <div>
          <dt>Segredo do cliente</dt>
          <dd>
            <StatusBadge
              :tone="provider.hasClientSecret ? 'idle' : 'offline'"
              :label="provider.hasClientSecret ? 'Salvo' : 'Não definido'"
            />
          </dd>
        </div>
        <div>
          <dt>URI de redirecionamento para registrar no Google Cloud</dt>
          <dd>
            <code>{{ provider.redirectUri }}</code>
          </dd>
        </div>
      </dl>
      <form class="form" method="post" @submit.prevent="save">
        <SettingsToggle
          v-model="enabled"
          label="Ativar Entrar com Google"
          :disabled="pending || offline"
        />
        <SettingsTextField
          v-model="clientId"
          label="Client ID"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          maxlength="200"
          :disabled="pending || offline"
        />
        <SettingsTextField
          v-model="clientSecret"
          label="Client secret"
          type="password"
          autocomplete="new-password"
          maxlength="512"
          hint="O segredo é guardado criptografado e nunca é devolvido ao navegador nem escrito em logs."
          :disabled="pending || offline"
          :placeholder="
            provider.hasClientSecret
              ? 'Segredo já salvo (deixe em branco para manter)'
              : 'Cole o segredo do projeto Google Cloud'
          "
        />
        <SettingsMessage ref="summary" :message="message" :error="error" />
        <div class="actions">
          <Button type="submit" :disabled="pending || !hydrated || offline">
            {{ pending ? 'Salvando…' : 'Salvar Google' }}
          </Button>
        </div>
      </form>
    </SettingsPanel>
    <ErrorState
      v-else-if="hydrated && loadFailed"
      title="Provedores indisponíveis"
    >
      <p role="alert">
        Não foi possível carregar os provedores de entrada. Tente novamente.
      </p>
      <Button @click="load()">Tentar novamente</Button>
    </ErrorState>
    <div v-else class="loading" aria-busy="true">
      <p role="status">Carregando provedores de entrada…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <p class="back"><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </SettingsPage>
</template>

<style scoped>
.loading,
.form {
  display: grid;
  gap: var(--space-3);
}
.form {
  max-inline-size: 32rem;
}
.facts {
  display: grid;
  gap: var(--space-3);
  margin: 0;
}
.facts div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.facts dt {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
.back {
  margin: 0;
}
</style>
