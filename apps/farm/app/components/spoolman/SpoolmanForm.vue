<script setup lang="ts">
const origin = defineModel<string>('origin', { required: true })
const serviceId = defineModel<string>('serviceId', { required: true })
const token = defineModel<string>('token', { required: true })
const username = defineModel<string>('username', { required: true })
const password = defineModel<string>('password', { required: true })

defineProps<{ busy: boolean; connectorCount: number }>()
const emit = defineEmits<{ submit: [] }>()
</script>

<template>
  <form class="spoolman-form" @submit.prevent="emit('submit')">
    <label for="spoolman-origin">Endereço do Spoolman</label>
    <input
      id="spoolman-origin"
      v-model="origin"
      required
      maxlength="256"
      type="url"
      autocomplete="off"
      spellcheck="false"
      aria-describedby="spoolman-origin-help"
    />
    <p id="spoolman-origin-help">
      Ex.: http://192.168.1.60:7912. Sem credenciais, caminho ou consulta.
    </p>

    <label for="spoolman-service-id">UUID do serviço (opcional)</label>
    <input
      id="spoolman-service-id"
      v-model="serviceId"
      maxlength="36"
      autocomplete="off"
      spellcheck="false"
      aria-describedby="spoolman-service-id-help"
    />
    <p id="spoolman-service-id-help">
      Ao mudar o endereço da mesma instalação, informe o UUID que ela já usa. Se
      a tabela abaixo mostrar um UUID, use esse valor. Se nenhum UUID estiver
      salvo, confirme o ID na configuração do Connector antes de mudar o
      endereço. Para outra instalação, informe um novo UUID, mesmo no mesmo
      endereço. Sem UUID neste campo, cada Connector mantém o ID no mesmo
      endereço e cria outro quando o endereço muda. Atualize Connectors antigos
      antes de usar um UUID explícito.
    </p>

    <label for="spoolman-username">Usuário (opcional)</label>
    <input
      id="spoolman-username"
      v-model="username"
      maxlength="256"
      autocomplete="off"
    />
    <label for="spoolman-password">Senha (opcional)</label>
    <input
      id="spoolman-password"
      v-model="password"
      type="password"
      maxlength="256"
      autocomplete="new-password"
    />
    <label for="spoolman-token">Token (alternativa a usuário e senha)</label>
    <input
      id="spoolman-token"
      v-model="token"
      type="password"
      maxlength="256"
      autocomplete="off"
      aria-describedby="spoolman-secret-help"
    />
    <p id="spoolman-secret-help">
      As credenciais vão direto ao Connector pela conexão segura e ficam apenas
      na configuração privada dele. O servidor não as guarda e elas não são
      exibidas depois do envio.
    </p>

    <button type="submit" :disabled="busy || connectorCount === 0">
      {{ busy ? 'Testando e salvando…' : 'Testar conexão e salvar' }}
    </button>
    <p v-if="connectorCount === 0" role="status">
      Nenhum Connector aprovado nesta farm para receber a configuração.
    </p>
  </form>
</template>
