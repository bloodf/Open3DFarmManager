<script setup lang="ts">
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const {
  moonrakerOrigin,
  moonrakerApiKey,
  moonrakerUsername,
  moonrakerPassword,
} = usePrinterSetup()
</script>

<template>
  <label for="moonraker-origin">Origem HTTP(S) do Moonraker</label>
  <input
    id="moonraker-origin"
    v-model="moonrakerOrigin"
    required
    maxlength="256"
    type="url"
    autocomplete="off"
    spellcheck="false"
    aria-describedby="moonraker-origin-help"
  />
  <p id="moonraker-origin-help">
    Ex.: http://192.168.1.50:7125. Sem credenciais, caminho ou consulta.
  </p>
  <label for="moonraker-api-key">Chave de API (opcional)</label>
  <input
    id="moonraker-api-key"
    v-model="moonrakerApiKey"
    type="password"
    maxlength="256"
    autocomplete="off"
    aria-describedby="moonraker-key-help"
  />
  <p id="moonraker-key-help">
    A chave será guardada somente na configuração privada do Connector.
    {{ moonrakerApiKey ? 'Chave configurada.' : 'Chave não configurada.' }}
  </p>
  <label for="moonraker-username">Usuário (alternativa à chave)</label>
  <input
    id="moonraker-username"
    v-model="moonrakerUsername"
    maxlength="256"
    autocomplete="off"
  />
  <label for="moonraker-password">Senha</label>
  <input
    id="moonraker-password"
    v-model="moonrakerPassword"
    type="password"
    maxlength="256"
    autocomplete="new-password"
  />
  <p>
    Suporte não qualificado. O Connector verifica o Moonraker em modo somente
    leitura antes de aceitar.
  </p>
</template>

<style scoped src="./printer-setup.css"></style>
