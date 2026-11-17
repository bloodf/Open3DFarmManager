<script setup lang="ts">
import {
  BAMBU_LAN_COMMAND_NOTE,
  BAMBU_SUPPORT_NOTE,
} from '../../utils/bambu-onboarding.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const { bambuIp, bambuSerial, bambuAccessCode, bambuControl } =
  usePrinterSetup()
</script>

<template>
  <label for="bambu-ip">Endereço IPv4 da Bambu Lab na LAN</label>
  <input
    id="bambu-ip"
    v-model="bambuIp"
    required
    maxlength="15"
    inputmode="decimal"
    autocomplete="off"
    spellcheck="false"
    aria-describedby="bambu-ip-help"
  />
  <p id="bambu-ip-help">
    Ex.: 192.168.1.60. Somente IPv4, sem nome de host, porta ou URL.
  </p>
  <label for="bambu-serial">Número de série</label>
  <input
    id="bambu-serial"
    v-model="bambuSerial"
    required
    maxlength="20"
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    aria-describedby="bambu-serial-help"
  />
  <p id="bambu-serial-help">
    Como aparece em Configurações → Dispositivo: letras maiúsculas e números.
  </p>
  <label for="bambu-access-code">Código de acesso LAN</label>
  <input
    id="bambu-access-code"
    v-model="bambuAccessCode"
    required
    type="password"
    maxlength="32"
    autocomplete="off"
    aria-describedby="bambu-access-code-help"
  />
  <p id="bambu-access-code-help">
    O código será guardado somente na configuração privada do Connector e nunca
    é exibido de volta.

    {{ bambuAccessCode ? 'Código configurado.' : 'Código não configurado.' }}
  </p>
  <label for="bambu-control">
    <input id="bambu-control" v-model="bambuControl" type="checkbox" />
    Habilitar comandos (pausar, retomar e cancelar) nesta impressora
  </label>
  <p>{{ BAMBU_LAN_COMMAND_NOTE }}</p>
  <p>{{ BAMBU_SUPPORT_NOTE }}</p>
</template>

<style scoped src="./printer-setup.css"></style>
