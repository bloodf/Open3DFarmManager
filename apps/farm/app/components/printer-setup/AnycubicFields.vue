<script setup lang="ts">
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const {
  anycubicHost,
  anycubicPort,
  anycubicModelId,
  anycubicDeviceId,
  anycubicUsername,
  anycubicPassword,
  anycubicCaFile,
  anycubicPin,
} = usePrinterSetup()
</script>

<template>
  <label for="anycubic-host">Endereço IPv4 na LAN</label>
  <input
    id="anycubic-host"
    v-model="anycubicHost"
    type="text"
    maxlength="15"
    required
    autocomplete="off"
    spellcheck="false"
  />
  <label for="anycubic-port">Porta LAN</label>
  <input
    id="anycubic-port"
    v-model="anycubicPort"
    type="number"
    required
    autocomplete="off"
    spellcheck="false"
    min="1"
    max="65535"
  />
  <label for="anycubic-model">Identificador do modelo</label>
  <input
    id="anycubic-model"
    v-model="anycubicModelId"
    type="text"
    maxlength="64"
    required
    autocomplete="off"
    spellcheck="false"
  />
  <label for="anycubic-device">Identificador do dispositivo</label>
  <input
    id="anycubic-device"
    v-model="anycubicDeviceId"
    type="text"
    maxlength="64"
    required
    autocomplete="off"
    spellcheck="false"
  />
  <label for="anycubic-username">Usuário LAN</label>
  <input
    id="anycubic-username"
    v-model="anycubicUsername"
    type="password"
    maxlength="256"
    required
    autocomplete="off"
    spellcheck="false"
  />
  <label for="anycubic-ca">Arquivo CA no Connector</label>
  <input id="anycubic-ca" v-model="anycubicCaFile" maxlength="4096" />
  <label for="anycubic-pin">SHA-256 do certificado</label>
  <input id="anycubic-pin" v-model="anycubicPin" maxlength="64" />
  <label for="anycubic-password">Senha LAN</label>
  <input
    id="anycubic-password"
    v-model="anycubicPassword"
    type="password"
    maxlength="2048"
    required
    autocomplete="off"
    spellcheck="false"
  />
  <p>
    Porta padrão: 9883. Credenciais guardadas somente no Connector.
    {{
      anycubicUsername && anycubicPassword
        ? 'Acesso configurado.'
        : 'Informe as credenciais LAN.'
    }}
  </p>
  <p>
    Suporte não qualificado. O Connector verifica a conexão LAN sem enviar
    comandos.
  </p>
</template>

<style scoped src="./printer-setup.css"></style>
