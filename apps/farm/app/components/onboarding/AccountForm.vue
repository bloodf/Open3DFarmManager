<script setup lang="ts">
// Account creation form for /criar-conta (invite) and /primeiro-acesso
// (setup code). Same request, validation and secret handling as before; only
// the presentation changed. The submit stays disabled until hydration so a
// native submit can never post the credentials in the URL.
import Button from '../ui/Button.vue'
import Icon from '../ui/Icon.vue'
import OnboardingField from './OnboardingField.vue'
import { completeAuth } from '../../utils/auth-invalidation.ts'

const hydrated = ref(false)
onMounted(() => {
  hydrated.value = true
})

const props = defineProps<{
  endpoint: string
  tokenHeader: string
  tokenLabel: string
  tokenHelp: string
  submitLabel: string
  /** Read the code from the URL fragment (never sent to servers or logs) and clear it. */
  tokenFromFragment?: boolean
  secretToken?: boolean
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
    token.value = ''
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
    pending.value = false
    if (errorMessage.value) {
      await nextTick()
      errorSummary.value?.focus()
    }
  }
}
</script>

<template>
  <form class="onboarding-form" :aria-busy="pending" @submit.prevent="submit">
    <OnboardingField
      id="account-token"
      :label="tokenLabel"
      :help="tokenHelp"
      v-slot="{ describedBy }"
    >
      <input
        id="account-token"
        v-model="token"
        :type="secretToken ? 'password' : 'text'"
        autocomplete="off"
        autocapitalize="none"
        :spellcheck="false"
        required
        :aria-describedby="describedBy"
        :disabled="pending"
      />
    </OnboardingField>
    <OnboardingField
      id="account-username"
      label="Usuário"
      help="Use letras minúsculas, números, hífen ou sublinhado."
      v-slot="{ describedBy }"
    >
      <input
        id="account-username"
        v-model="username"
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="3"
        maxlength="64"
        pattern="[a-z0-9_\-]{3,64}"
        :aria-describedby="describedBy"
        :disabled="pending"
      />
    </OnboardingField>
    <OnboardingField
      id="account-password"
      label="Senha"
      help="Use 12 caracteres ou mais."
      v-slot="{ describedBy }"
    >
      <input
        id="account-password"
        v-model="password"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        :aria-describedby="describedBy"
        :disabled="pending"
      />
    </OnboardingField>
    <div ref="errorSummary" class="alert" role="alert" tabindex="-1">
      <p v-if="errorMessage">
        <Icon name="info" />
        <span>{{ errorMessage }}</span>
      </p>
    </div>
    <div class="actions">
      <Button type="submit" :disabled="pending || !hydrated">
        {{ pending ? 'Criando conta…' : submitLabel }}
      </Button>
    </div>
    <p v-if="!hydrated" role="status" class="note">Preparando o formulário</p>
    <p role="status" class="note">{{ pending ? 'Criando sua conta.' : '' }}</p>
  </form>
</template>

<style scoped>
.onboarding-form {
  display: grid;
  gap: var(--ops-space-4);
  padding: var(--ops-space-4);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
  color: var(--ops-text);
  min-width: 0;
}
.alert:empty {
  display: none;
}
.alert p {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--ops-space-2);
  padding: var(--ops-space-2) var(--ops-space-3);
  border-inline-start: 3px solid var(--ops-fault);
  border-radius: var(--ops-radius-sm);
  background: var(--ops-fault-bg);
  color: var(--ops-fault);
  line-height: 20px;
  overflow-wrap: anywhere;
}
.alert svg {
  flex: none;
}
.alert:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.actions {
  display: grid;
}
.actions :deep(.ui-button) {
  border-color: var(--ops-action);
  border-radius: var(--ops-radius-md);
  background: var(--ops-action);
  color: var(--ops-on-action);
  font-weight: var(--font-weight-semibold);
}
.actions :deep(.ui-button:hover:not(:disabled)) {
  background: color-mix(in srgb, var(--ops-action) 88%, var(--ops-text));
}
.actions :deep(.ui-button:focus-visible) {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.note {
  margin: 0;
  font-size: var(--ops-text-small);
  line-height: 18px;
  color: var(--ops-muted);
}
.note:empty {
  display: none;
}
</style>
